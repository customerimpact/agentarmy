import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConsoleManager, childEnv } from './consoles.js';
import { buildServer } from './server.js';
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  claudeLaunchArgs,
  isDiscordWebhook,
  isSlackWebhook,
  packageVersion,
  splitArgs,
  validatePatch,
} from './settings.js';

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdEFGH1234';
const DISCORD = 'https://discord.com/api/webhooks/123456/abc_DEF-xyz9';

describe('splitArgs', () => {
  it('splits on whitespace and respects quotes', () => {
    expect(splitArgs('  --verbose   --add-dir "C:\\My Repo" \'a b\'  ')).toEqual([
      '--verbose',
      '--add-dir',
      'C:\\My Repo',
      'a b',
    ]);
    expect(splitArgs('--x="1 2" ""')).toEqual(['--x=1 2', '']);
    expect(splitArgs('')).toEqual([]);
  });

  it('rejects an unclosed quote', () => {
    expect(() => splitArgs('--a "oops')).toThrow(/unclosed quote/);
  });
});

describe('validatePatch', () => {
  it('accepts valid values and trims text', () => {
    expect(
      validatePatch({ model: ' haiku ', permissionMode: 'plan', enableTasks: false, startupResume: 'never' }),
    ).toEqual({ model: 'haiku', permissionMode: 'plan', enableTasks: false, startupResume: 'never' });
    expect(validatePatch({ model: 'claude-opus-4-1[1m]' }).model).toBe('claude-opus-4-1[1m]');
  });

  it('rejects bad types, unknown keys and bad enums', () => {
    expect(() => validatePatch(null)).toThrow();
    expect(() => validatePatch({ nope: 1 })).toThrow(/Unknown setting/);
    expect(() => validatePatch({ useApiKey: 'yes' })).toThrow(/true or false/);
    expect(() => validatePatch({ permissionMode: 'yolo' })).toThrow(/permissionMode/);
    expect(() => validatePatch({ model: 'opus; rm -rf /' })).toThrow(/Model/);
  });

  it('rejects flags AgentArmy manages itself', () => {
    expect(() => validatePatch({ extraArgs: '--resume abc' })).toThrow(/managed by AgentArmy/);
    expect(() => validatePatch({ extraArgs: '--settings=x.json' })).toThrow(/managed by AgentArmy/);
    expect(validatePatch({ extraArgs: '--verbose --add-dir "../shared lib"' }).extraArgs).toBe(
      '--verbose --add-dir "../shared lib"',
    );
  });

  it('validates webhook URLs and allows clearing them', () => {
    expect(isSlackWebhook(SLACK)).toBe(true);
    expect(isSlackWebhook('http://hooks.slack.com/services/x')).toBe(false);
    expect(isSlackWebhook('https://hooks.slack.com.evil.io/services/x')).toBe(false);
    expect(isDiscordWebhook(DISCORD)).toBe(true);
    expect(isDiscordWebhook('https://discordapp.com/api/webhooks/1/abc')).toBe(true);
    expect(isDiscordWebhook('https://example.com/api/webhooks/1/abc')).toBe(false);
    expect(() => validatePatch({ slackWebhookUrl: DISCORD })).toThrow(/Slack/);
    expect(() => validatePatch({ discordWebhookUrl: SLACK })).toThrow(/Discord/);
    expect(validatePatch({ slackWebhookUrl: '' })).toEqual({ slackWebhookUrl: '' });
  });
});

describe('claudeLaunchArgs / childEnv', () => {
  it('turns settings into claude flags', () => {
    expect(claudeLaunchArgs(DEFAULT_SETTINGS)).toEqual([]);
    expect(
      claudeLaunchArgs({ ...DEFAULT_SETTINGS, model: 'haiku', permissionMode: 'acceptEdits', extraArgs: '--verbose "a b"' }),
    ).toEqual(['--model', 'haiku', '--permission-mode', 'acceptEdits', '--verbose', 'a b']);
  });

  it('applies the API key and task list settings to the console env', () => {
    const source = { ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_ENABLE_TASKS: '1' };
    expect(childEnv(source, { useApiKey: true, enableTasks: true }).ANTHROPIC_API_KEY).toBe('sk-x');
    expect(childEnv(source, { useApiKey: false, enableTasks: true }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv(source, { useApiKey: false, enableTasks: false }).CLAUDE_CODE_ENABLE_TASKS).toBeUndefined();
  });
});

describe('SettingsStore', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-settings-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists patches and reloads them', () => {
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    let changes = 0;
    store.on('change', () => changes++);
    store.patch({ model: 'sonnet', slackWebhookUrl: SLACK });
    expect(changes).toBe(1);
    const again = new SettingsStore(file);
    expect(again.get().model).toBe('sonnet');
    expect(again.get().slackWebhookUrl).toBe(SLACK);
    again.reset();
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields from a partly invalid file and backs up a corrupt one', () => {
    const file = path.join(dir, 'partial.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', permissionMode: 'yolo', future: 1 }));
    expect(new SettingsStore(file).get()).toEqual({ ...DEFAULT_SETTINGS, model: 'opus' });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{nope');
    expect(new SettingsStore(bad).get()).toEqual(DEFAULT_SETTINGS);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('bad.json.') && f.endsWith('.bad'))).toBe(true);
  });

  it('never exposes webhook URLs in the public view', () => {
    const store = new SettingsStore(null);
    store.patch({ slackWebhookUrl: SLACK });
    const view = store.publicView({ port: 1 });
    expect(JSON.stringify(view)).not.toContain('hooks.slack.com');
    expect(view.slack).toEqual({ set: true, hint: '1234' });
    expect(view.discord).toEqual({ set: false, hint: '' });
    expect(view.version).toBe(packageVersion());
    expect(view.version).not.toBe('unknown');
  });
});

describe('settings routes', () => {
  const PORT = 4317;
  const HEADERS = { host: `127.0.0.1:${PORT}`, 'x-agentarmy-token': 't' };
  let app: FastifyInstance;
  let settings: SettingsStore;

  beforeAll(async () => {
    const manager = new ConsoleManager({ port: PORT, token: 't', onChange: () => {} });
    settings = new SettingsStore(null);
    app = await buildServer({ port: PORT, token: 't', dev: false, manager, settings });
  });
  afterAll(() => app.close());

  it('GET, PATCH (validated) and reset', async () => {
    const get = await app.inject({ url: '/api/settings', headers: HEADERS });
    expect(get.statusCode).toBe(200);
    expect(get.json().settings.model).toBe('');
    const patch = await app.inject({ method: 'PATCH', url: '/api/settings', headers: HEADERS, payload: { model: 'haiku' } });
    expect(patch.json().settings.model).toBe('haiku');
    const bad = await app.inject({ method: 'PATCH', url: '/api/settings', headers: HEADERS, payload: { model: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(settings.get().model).toBe('haiku');
    const reset = await app.inject({ method: 'POST', url: '/api/settings/reset', headers: HEADERS });
    expect(reset.json().settings.model).toBe('');
  });

  it('requires the token and rejects a test without a webhook', async () => {
    const res = await app.inject({ url: '/api/settings', headers: { host: HEADERS.host } });
    expect(res.statusCode).toBe(401);
    const test = await app.inject({
      method: 'POST',
      url: '/api/settings/test-webhook',
      headers: HEADERS,
      payload: { kind: 'slack' },
    });
    expect(test.statusCode).toBe(400);
    expect(test.json().error).toMatch(/No Slack webhook/);
  });
});
