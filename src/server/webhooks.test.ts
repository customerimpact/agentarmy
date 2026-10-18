import { describe, expect, it, vi } from 'vitest';
import type { ActionItem } from '../shared/protocol.js';
import { ConsoleManager } from './consoles.js';
import { SettingsStore } from './settings.js';
import { WEBHOOK_COOLDOWN_MS, WebhookNotifier, formatActionMessage, postWebhook, webhookBody } from './webhooks.js';

const SLACK = 'https://hooks.slack.com/services/T000/B000/secretXYZ9';
const DISCORD = 'https://discord.com/api/webhooks/42/secret_token';

function action(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: Math.random().toString(36).slice(2),
    consoleId: 'c1',
    kind: 'needs_you',
    title: 'Ada needs you',
    detail: 'Allow   Bash(npm test)?',
    createdAt: Date.now() + 1000,
    ...over,
  };
}

describe('formatActionMessage', () => {
  it('names the project, console and detail, with a link to the board', () => {
    const text = formatActionMessage(action(), { console: { name: 'Ada' }, projectName: 'Shop', port: 4317 });
    expect(text).toBe('AgentArmy · Shop · Ada needs you: Allow Bash(npm test)?\nhttp://127.0.0.1:4317/');
  });

  it('handles errors, requests and missing consoles', () => {
    expect(formatActionMessage(action({ kind: 'error', detail: undefined }), { console: { name: 'Bex' }, port: 1 })).toBe(
      'AgentArmy · Bex hit an error\nhttp://127.0.0.1:1/',
    );
    expect(
      formatActionMessage(action({ kind: 'request', title: 'Add API key', detail: 'for Stripe' }), { port: 1 }),
    ).toBe('AgentArmy · An agent asks for something: Add API key — for Stripe\nhttp://127.0.0.1:1/');
  });

  it('uses each service payload shape', () => {
    expect(JSON.parse(webhookBody('slack', 'hi'))).toEqual({ text: 'hi' });
    expect(JSON.parse(webhookBody('discord', 'hi'))).toEqual({ content: 'hi' });
  });
});

describe('postWebhook', () => {
  it('posts JSON and never leaks the URL in errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await postWebhook('discord', DISCORD, 'x', fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(DISCORD, expect.objectContaining({ method: 'POST', body: '{"content":"x"}' }));

    const failing = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED ${SLACK}`));
    await expect(postWebhook('slack', SLACK, 'x', failing)).rejects.toThrow('Could not reach Slack');
    await expect(postWebhook('slack', SLACK, 'x', failing)).rejects.not.toThrow(/secret/);
    const status = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(postWebhook('slack', SLACK, 'x', status)).rejects.toThrow('Slack answered HTTP 404');
  });
});

describe('WebhookNotifier', () => {
  function setup() {
    const manager = new ConsoleManager({ port: 1, token: 't', onChange: () => {} });
    const settings = new SettingsStore(null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    let now = Date.now();
    const notifier = new WebhookNotifier(manager, settings, 4317, fetchMock, () => now);
    return { manager, settings, fetchMock, notifier, advance: (ms: number) => (now += ms) };
  }

  it('does nothing without webhooks, posts to both when set', () => {
    const { manager, settings, fetchMock } = setup();
    manager.emit('action', action());
    expect(fetchMock).not.toHaveBeenCalled();
    settings.patch({ slackWebhookUrl: SLACK, discordWebhookUrl: DISCORD });
    manager.emit('action', action());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([SLACK, DISCORD]);
  });

  it('rate-limits per console, skips resolved, restored and repeated items', () => {
    const { manager, settings, fetchMock, advance } = setup();
    settings.patch({ slackWebhookUrl: SLACK });
    const first = action();
    manager.emit('action', first);
    manager.emit('action', first); // update of the same item
    manager.emit('action', action()); // same console within the cooldown
    manager.emit('action', action({ consoleId: 'c2' })); // other console
    manager.emit('action', action({ consoleId: 'c3', resolvedAt: Date.now() }));
    manager.emit('action', action({ consoleId: 'c4', createdAt: 0 })); // restored from disk
    expect(fetchMock).toHaveBeenCalledTimes(2);
    advance(WEBHOOK_COOLDOWN_MS + 1);
    manager.emit('action', action());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends a test message, or explains that no webhook is set', async () => {
    const { settings, fetchMock, notifier } = setup();
    await expect(notifier.sendTest('discord')).rejects.toThrow(/No Discord webhook/);
    settings.patch({ discordWebhookUrl: DISCORD });
    await notifier.sendTest('discord');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content).toMatch(/test message/);
  });
});
