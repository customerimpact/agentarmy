import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, DEFAULT_ACCOUNT_ID } from './accounts.js';

// Accounts of the other CLIs (accounts.json v2): migration, config dirs, env per provider
let tmp: string;
const now = Date.UTC(2026, 9, 19, 12);

function makeStore(file: string | null = path.join(tmp, 'home', 'accounts.json')) {
  return new AccountStore({
    file,
    accountsDir: path.join(tmp, 'home', 'accounts'),
    defaultDir: path.join(tmp, 'claude-default'),
    providerDirs: { codex: path.join(tmp, 'codex-default'), gemini: path.join(tmp, 'gemini-home'), opencode: path.join(tmp, 'xdg-data') },
    env: {},
    now: () => now,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-acct-prov-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('accounts.json v1 -> v2 migration', () => {
  it('keeps every v1 record and field, marks them Claude and adds the other CLIs defaults', () => {
    const file = path.join(tmp, 'home', 'accounts.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const v1 = {
      version: 1,
      accounts: [
        { id: 'default', name: 'Default', lastSeenAt: 5, createdAt: 1 },
        { id: 'ab12cd34', name: 'Work', limitedAt: now - 1000, limitResetsAt: now + 3_600_000, limitLabel: 'weekly limit', lastSeenAt: 7, createdAt: 2 },
      ],
      autoSwitch: 'on',
      newAgentAccount: 'ab12cd34',
    };
    fs.writeFileSync(file, JSON.stringify(v1));
    const store = makeStore(file);
    const state = store.state();
    expect(state.accounts.map((a) => [a.id, a.name, a.provider])).toEqual([
      ['default', 'Default', 'claude'],
      ['ab12cd34', 'Work', 'claude'],
    ]);
    expect(state.autoSwitch).toBe('on');
    expect(state.newAgentAccount).toBe('ab12cd34');
    // v1 location of the extra Claude account is unchanged
    expect(state.accounts[1].configDir).toBe(path.join(tmp, 'home', 'accounts', 'ab12cd34'));
    expect(state.providerAccounts?.map((a) => a.id)).toEqual(['codex-default', 'gemini-default', 'opencode-default', 'grok-default']);

    store.rename('ab12cd34', 'Work 2'); // any save writes v2
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; accounts: Record<string, unknown>[] };
    expect(saved.version).toBe(2);
    const work = saved.accounts.find((a) => a.id === 'ab12cd34')!;
    expect(work).toMatchObject({ provider: 'claude', name: 'Work 2', limitLabel: 'weekly limit', limitResetsAt: now + 3_600_000, createdAt: 2 });
    expect(saved.accounts.filter((a) => a.provider === 'codex')).toHaveLength(1);
    // Loading v2 again changes nothing
    expect(makeStore(file).state().accounts.map((a) => a.id)).toEqual(['default', 'ab12cd34']);
  });
});

describe('provider accounts', () => {
  it('creates a Codex account in accounts/codex/<id> and gives its consoles CODEX_HOME', () => {
    const store = makeStore();
    const work = store.create('Work', 'codex');
    expect(work.provider).toBe('codex');
    expect(work.configDir).toBe(path.join(tmp, 'home', 'accounts', 'codex', work.id));
    expect(fs.existsSync(work.configDir)).toBe(true);
    expect(work.status).toBe('needs_login');
    expect(store.envFor(work.id)).toEqual({ CODEX_HOME: work.configDir });
    expect(store.envFor('codex-default')).toEqual({});
    // Claude lists stay Claude-only (auto-switch, pickers)
    expect(store.list().map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID]);
    expect(store.list('codex').map((a) => a.id)).toEqual(['codex-default', work.id]);
    expect(store.providerOf(work.id)).toBe('codex');

    fs.writeFileSync(path.join(work.configDir, 'auth.json'), '{}');
    expect(store.get(work.id)?.status).toBe('ok');
  });

  it('gemini and opencode accounts get GEMINI_CLI_HOME / XDG_DATA_HOME', () => {
    const store = makeStore();
    const g = store.create('Personal', 'gemini');
    const o = store.create('Team', 'opencode');
    expect(store.envFor(g.id)).toEqual({ GEMINI_CLI_HOME: path.join(tmp, 'home', 'accounts', 'gemini', g.id) });
    expect(store.envFor(o.id)).toEqual({ XDG_DATA_HOME: path.join(tmp, 'home', 'accounts', 'opencode', o.id) });
    expect(store.get('gemini-default')?.configDir).toBe(path.join(tmp, 'gemini-home'));
  });

  it('protects defaults, deletes extra dirs, refuses single-account CLIs', () => {
    const store = makeStore();
    expect(() => store.remove('codex-default')).toThrow(/cannot be removed/);
    expect(() => store.create('Second', 'grok')).toThrow(/one account only/);
    const work = store.create('Work', 'codex');
    store.remove(work.id);
    expect(fs.existsSync(work.configDir)).toBe(false);
    expect(store.list('codex').map((a) => a.id)).toEqual(['codex-default']);
  });

  it('resolves accounts per provider for new consoles', () => {
    const store = makeStore();
    const work = store.create('Work', 'codex');
    // Nothing logged in: auto falls back to the CLI default
    expect(store.resolveForNew('auto', 'codex')).toBe('codex-default');
    fs.writeFileSync(path.join(work.configDir, 'auth.json'), '{}');
    expect(store.resolveForNew('auto', 'codex')).toBe(work.id);
    expect(store.resolveForNew(work.id, 'codex')).toBe(work.id);
    expect(() => store.resolveForNew(work.id, 'claude')).toThrow(/not a Claude Code account/);
    // "New agents use" is a Claude choice
    expect(() => store.patch({ newAgentAccount: work.id })).toThrow(/Unknown account/);
    expect(store.transcriptRoots().map((r) => r.accountId)).toEqual([DEFAULT_ACCOUNT_ID]);
  });
});
