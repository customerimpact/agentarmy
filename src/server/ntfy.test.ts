import { describe, expect, it, vi } from 'vitest';
import type { ActionItem } from '../shared/protocol.js';
import { ConsoleManager } from './consoles.js';
import {
  NTFY_COOLDOWN_MS,
  NtfyNotifier,
  formatNtfyMessage,
  headerSafe,
  isNtfyServer,
  isNtfyTopic,
  ntfyHeaders,
  ntfyTopicUrl,
  postNtfy,
} from './ntfy.js';
import { SettingsStore, validatePatch } from './settings.js';

const TOPIC = 'agentarmy-Zx8kQ2mP4vN7rT1w';

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

describe('validation', () => {
  it('accepts ntfy-style topics only', () => {
    expect(isNtfyTopic(TOPIC)).toBe(true);
    expect(isNtfyTopic('a_b-C9')).toBe(true);
    expect(isNtfyTopic('')).toBe(false);
    expect(isNtfyTopic('has space')).toBe(false);
    expect(isNtfyTopic('a/b')).toBe(false);
    expect(isNtfyTopic('x'.repeat(65))).toBe(false);
  });

  it('allows https servers and http only on localhost', () => {
    expect(isNtfyServer('https://ntfy.sh')).toBe(true);
    expect(isNtfyServer('https://ntfy.example.com:8443/base')).toBe(true);
    expect(isNtfyServer('http://localhost:8080')).toBe(true);
    expect(isNtfyServer('http://127.0.0.1')).toBe(true);
    expect(isNtfyServer('http://ntfy.example.com')).toBe(false);
    expect(isNtfyServer('ftp://ntfy.sh')).toBe(false);
    expect(isNtfyServer('https://user:pw@ntfy.sh')).toBe(false);
    expect(isNtfyServer('https://ntfy.sh/?x=1')).toBe(false);
    expect(isNtfyServer('not a url')).toBe(false);
  });

  it('validates the settings patch and normalizes the server', () => {
    expect(validatePatch({ ntfyTopic: TOPIC, ntfyServer: 'https://ntfy.example.com/' })).toEqual({
      ntfyTopic: TOPIC,
      ntfyServer: 'https://ntfy.example.com',
    });
    expect(validatePatch({ ntfyServer: '' })).toEqual({ ntfyServer: 'https://ntfy.sh' });
    expect(validatePatch({ ntfyTopic: '' })).toEqual({ ntfyTopic: '' });
    expect(() => validatePatch({ ntfyTopic: 'bad topic' })).toThrow(/letters, digits/);
    expect(() => validatePatch({ ntfyServer: 'http://evil.example' })).toThrow(/https/);
  });

  it('masks the topic in the public view', () => {
    const settings = new SettingsStore(null);
    expect(settings.publicView({ port: 1 }).ntfy).toEqual({ set: false, hint: '', server: 'https://ntfy.sh' });
    settings.patch({ ntfyTopic: TOPIC });
    const view = settings.publicView({ port: 1 });
    expect(view.ntfy).toEqual({ set: true, hint: TOPIC.slice(-4), server: 'https://ntfy.sh' });
    expect(JSON.stringify(view)).not.toContain(TOPIC);
  });
});

describe('formatting', () => {
  it('builds title, body, priority, tags and a console deep link', () => {
    const msg = formatNtfyMessage(action(), { console: { id: 'c1', name: 'Ada' }, projectName: 'Shop', port: 4317 });
    expect(msg).toEqual({
      title: 'Shop · Ada needs you',
      body: 'Allow Bash(npm test)?',
      priority: 'high',
      tags: ['raising_hand'],
      click: 'http://127.0.0.1:4317/?view=console&id=c1',
    });
  });

  it('uses default priority for errors and requests, and a fallback body', () => {
    const err = formatNtfyMessage(action({ kind: 'error', detail: undefined }), { console: { id: 'c 2', name: 'Bex' }, port: 1 });
    expect(err.priority).toBe('default');
    expect(err.tags).toEqual(['warning']);
    expect(err.title).toBe('Bex hit an error');
    expect(err.body).toMatch(/Open AgentArmy/);
    expect(err.click).toBe('http://127.0.0.1:1/?view=console&id=c%202');
    const req = formatNtfyMessage(action({ kind: 'request', consoleId: null, title: 'Add API key', detail: 'for Stripe' }), { port: 1 });
    expect(req.title).toBe('An agent asks for something');
    expect(req.body).toBe('Add API key — for Stripe');
    expect(req.click).toBe('http://127.0.0.1:1/');
  });

  it('keeps headers Latin-1 safe (RFC 2047 for anything else) and strips newlines', () => {
    expect(headerSafe('Ada needs you')).toBe('Ada needs you');
    expect(headerSafe('a\r\nb')).toBe('a b');
    const encoded = headerSafe('Café · Ada');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8')).toBe('Café · Ada');
    const headers = ntfyHeaders(formatNtfyMessage(action(), { console: { id: 'c1', name: 'Ada' }, port: 1 }));
    expect(headers).toMatchObject({ Priority: 'high', Tags: 'raising_hand', Click: 'http://127.0.0.1:1/?view=console&id=c1' });
    expect(headers.Title).toBe('Ada needs you');
  });

  it('joins server and topic with exactly one slash', () => {
    expect(ntfyTopicUrl('https://ntfy.sh/', TOPIC)).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(ntfyTopicUrl('', TOPIC)).toBe(`https://ntfy.sh/${TOPIC}`);
  });
});

describe('postNtfy', () => {
  it('posts plain text to <server>/<topic> and never leaks the topic in errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const msg = formatNtfyMessage(action(), { console: { id: 'c1', name: 'Ada' }, port: 1 });
    await postNtfy('https://ntfy.sh', TOPIC, msg, fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://ntfy.sh/${TOPIC}`,
      expect.objectContaining({ method: 'POST', body: 'Allow Bash(npm test)?' }),
    );
    const failing = vi.fn().mockRejectedValue(new Error(`getaddrinfo ENOTFOUND https://ntfy.sh/${TOPIC}`));
    await expect(postNtfy('https://ntfy.sh', TOPIC, msg, failing)).rejects.toThrow('Could not reach the ntfy server');
    await expect(postNtfy('https://ntfy.sh', TOPIC, msg, failing)).rejects.not.toThrow(new RegExp(TOPIC));
    const status = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(postNtfy('https://ntfy.sh', TOPIC, msg, status)).rejects.toThrow('ntfy answered HTTP 429');
    await expect(postNtfy('http://evil.example', TOPIC, msg, fetchMock)).rejects.toThrow(/not allowed/);
  });
});

describe('NtfyNotifier', () => {
  function setup() {
    const manager = new ConsoleManager({ port: 1, token: 't', onChange: () => {} });
    const settings = new SettingsStore(null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    let now = Date.now();
    const notifier = new NtfyNotifier(manager, settings, 4317, fetchMock, () => now);
    return { manager, settings, fetchMock, notifier, advance: (ms: number) => (now += ms) };
  }

  it('does nothing without a topic, pushes once set', () => {
    const { manager, settings, fetchMock } = setup();
    manager.emit('action', action());
    expect(fetchMock).not.toHaveBeenCalled();
    settings.patch({ ntfyTopic: TOPIC, ntfyServer: 'http://localhost:8080' });
    manager.emit('action', action());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`http://localhost:8080/${TOPIC}`]);
    expect(fetchMock.mock.calls[0][1].headers.Priority).toBe('high');
  });

  it('rate-limits per console and skips resolved, restored and repeated items', () => {
    const { manager, settings, fetchMock, advance } = setup();
    settings.patch({ ntfyTopic: TOPIC });
    const first = action();
    manager.emit('action', first);
    manager.emit('action', first);
    manager.emit('action', action());
    manager.emit('action', action({ consoleId: 'c2' }));
    manager.emit('action', action({ consoleId: 'c3', resolvedAt: Date.now() }));
    manager.emit('action', action({ consoleId: 'c4', createdAt: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    advance(NTFY_COOLDOWN_MS + 1);
    manager.emit('action', action());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends a test push, or explains that no topic is set', async () => {
    const { settings, fetchMock, notifier } = setup();
    await expect(notifier.sendTest()).rejects.toThrow(/No ntfy topic/);
    settings.patch({ ntfyTopic: TOPIC });
    await notifier.sendTest();
    expect(fetchMock.mock.calls[0][1].headers.Title).toBe('AgentArmy test');
  });
});
