import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConsoleInfo } from '../../shared/protocol.js';
import { DEFAULT_SETTINGS, SettingsError, SettingsStore, providerKey } from '../settings.js';
import { grokAdapter, grokArgs, grokEnv } from './grok.js';

const FAKE_GROK = path.resolve('tests', 'fake-cli', process.platform === 'win32' ? 'grok.cmd' : 'grok');

function info(extra: Partial<ConsoleInfo> = {}): ConsoleInfo {
  return {
    id: 'g1',
    name: 'Ada',
    cwd: process.cwd(),
    sessionId: 's',
    status: 'starting',
    statusChangedAt: 0,
    layout: { x: 0, y: 0, width: 1, height: 1 },
    createdAt: 0,
    agent: 'grok',
    ...extra,
  };
}

describe('grok adapter', () => {
  it('builds new / resume args with the model flag', () => {
    expect(grokArgs({}, 'new')).toEqual([]);
    expect(grokArgs({ launchModel: 'grok-build' }, 'new')).toEqual(['-m', 'grok-build']);
    expect(grokArgs({ launchModel: 'grok-4.7' }, 'resume')).toEqual(['--continue', '-m', 'grok-4.7']);
  });

  it('injects the saved key only as the CLI env var, and nothing without one', () => {
    expect(grokEnv({ PATH: 'x' }, '')).toEqual({ PATH: 'x' });
    expect(grokEnv({ PATH: 'x' }, 'xai-secret1234')).toEqual({ PATH: 'x', XAI_API_KEY: 'xai-secret1234', GROK_API_KEY: 'xai-secret1234' });
  });

  it('launches the fake grok through its path override with the key from settings', () => {
    const settings = { ...DEFAULT_SETTINGS, agentPaths: { grok: FAKE_GROK }, providerKeys: { grok: 'xai-abcdef9876' } };
    const spec = grokAdapter.buildLaunch(info({ launchModel: 'grok-build' }), 'resume', { port: 1, token: 't', settings, baseEnv: { A: '1' } });
    const args = Array.isArray(spec.args) ? spec.args.join(' ') : spec.args;
    expect(args).toMatch(/grok(.cmd)?/);
    expect(args).toContain('--continue');
    expect(args).toContain('-m grok-build');
    expect(spec.env).toMatchObject({ A: '1', XAI_API_KEY: 'xai-abcdef9876' });
    // Other consoles never see it: the key is only added by this adapter
    const noKey = { ...settings, providerKeys: {} };
    const plain = grokAdapter.buildLaunch(info(), 'new', { port: 1, token: 't', settings: noKey, baseEnv: { A: '1' } });
    expect(plain.env.XAI_API_KEY).toBeUndefined();
  });

  it('detects the fake grok with its version and has no MCP / hooks', async () => {
    const found = await grokAdapter.detect({ ...DEFAULT_SETTINGS, agentPaths: { grok: FAKE_GROK } });
    expect(found).toMatchObject({ installed: true, version: 'grok 0.1.0-fake (Grok Build)' });
    expect(grokAdapter).toMatchObject({ supportsMcp: false, supportsHooks: false, heuristics: 'agent', supportsResume: true });
    const missing = await grokAdapter.detect({ ...DEFAULT_SETTINGS, agentPaths: { grok: path.resolve('nope', 'grok.exe') } });
    expect(missing.installed).toBe(false);
  });
});

describe('providerKeys setting', () => {
  it('stores the key but only shows set + last 4 to the browser', () => {
    const store = new SettingsStore(null);
    store.patch({ providerKeys: { grok: 'xai-0123456789abcdWXYZ' } });
    expect(providerKey(store.get(), 'grok')).toBe('xai-0123456789abcdWXYZ');
    const view = store.publicView({ port: 1 });
    expect(view.providerKeys.grok).toEqual({ set: true, hint: 'WXYZ' });
    expect(JSON.stringify(view)).not.toContain('xai-0123456789abcd');
    expect((view.settings as unknown as Record<string, unknown>).providerKeys).toBeUndefined();
  });

  it('clears with an empty string and rejects junk', () => {
    const store = new SettingsStore(null);
    store.patch({ providerKeys: { grok: 'xai-0123456789abcd' } });
    store.patch({ model: 'sonnet' }); // other patches keep it
    expect(providerKey(store.get(), 'grok')).toBe('xai-0123456789abcd');
    store.patch({ providerKeys: { grok: '' } });
    expect(providerKey(store.get(), 'grok')).toBe('');
    expect(store.publicView({ port: 1 }).providerKeys.grok).toEqual({ set: false, hint: '' });
    expect(() => store.patch({ providerKeys: { grok: 'has space here' } })).toThrow(SettingsError);
    expect(() => store.patch({ providerKeys: { openai: 'sk-0123456789' } })).toThrow('unknown provider');
  });

  it('validates the limit fallback settings', () => {
    const store = new SettingsStore(null);
    expect(store.get()).toMatchObject({ limitFallback: 'ask', limitFallbackAgent: 'codex' });
    store.patch({ limitFallback: 'switch', limitFallbackAgent: 'grok' });
    expect(store.get()).toMatchObject({ limitFallback: 'switch', limitFallbackAgent: 'grok' });
    expect(() => store.patch({ limitFallback: 'always' })).toThrow(SettingsError);
    expect(() => store.patch({ limitFallbackAgent: 'custom' })).toThrow(SettingsError);
  });
});
