import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ConsoleInfo, CreateConsoleRequest, ServerMessage } from '../shared/protocol.js';
import type { AgentDetection } from '../shared/agents.js';
import type { ProvidersResponse } from '../shared/providers.js';
import { registerAccountRoutes } from './account-routes.js';
import { loginStamp, loginSucceeded, registerProviderRoutes } from './provider-routes.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { DEFAULT_SETTINGS } from './settings.js';

// Detection is mocked: no CLI is ever started by these tests
const detected: { agents: AgentDetection[] } = { agents: [] };
const detectCalls: { fresh?: boolean }[] = [];
vi.mock('./agents/index.js', () => ({
  detectAgents: vi.fn(async (_settings: unknown, options: { fresh?: boolean } = {}) => {
    detectCalls.push(options);
    return detected;
  }),
}));

let tmp: string;

function detection(id: AgentDetection['id'], installed: boolean, extra: Partial<AgentDetection> = {}): AgentDetection {
  return { id, label: id, installed, supportsResume: true, supportsHooks: false, supportsMcp: true, ...extra };
}

async function setup() {
  const ctx = fakeManager([fakeConsole('ada', 'idle')]);
  const created: { req: CreateConsoleRequest; info: ConsoleInfo }[] = [];
  ctx.manager.create = vi.fn((req: CreateConsoleRequest) => {
    const info: ConsoleInfo = {
      ...fakeConsole(`c${created.length}`, 'starting'),
      name: req.name ?? 'X',
      cwd: req.cwd,
      ...(req.accountId ? { accountId: req.accountId } : {}),
      ...(req.agent ? { agent: req.agent } : {}),
      ...(req.command ? { command: req.command } : {}),
    };
    created.push({ req, info });
    (ctx.manager as unknown as { register: (i: ConsoleInfo) => void }).register(info);
    return info;
  });
  ctx.manager.remove = vi.fn((id: string) => {
    (ctx.manager as unknown as { consoles: Map<string, unknown> }).consoles.delete(id);
    ctx.manager.emit('removed', id);
  });
  const messages: ServerMessage[] = [];
  const app = Fastify();
  const env = {
    CODEX_HOME: path.join(tmp, 'codex-default'),
    GEMINI_CLI_HOME: path.join(tmp, 'gemini-home'),
    XDG_DATA_HOME: path.join(tmp, 'xdg-data'),
  };
  const accounts = await registerAccountRoutes(app, {
    manager: ctx.manager,
    broadcast: (m) => messages.push(m),
    dataDir: path.join(tmp, 'home'),
    env,
    defaultDir: path.join(tmp, 'claude-default'),
    refreshMs: 60_000,
    loginPollMs: 60_000,
  });
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  registerProviderRoutes(app, {
    manager: ctx.manager,
    broadcast: (m) => messages.push(m),
    accounts,
    settings: () => settings,
    env,
    pollMs: 20,
    closeDelayMs: 10,
    platform: 'win32',
  });
  const exit = (id: string, exitCode: number) => {
    const info = ctx.manager.get(id)!;
    info.status = 'exited';
    info.exitCode = exitCode;
    ctx.manager.touch(id);
  };
  const events = () => messages.flatMap((m) => (m.type === 'provider-event' ? [m.event] : []));
  return { ...ctx, app, accounts, messages, created, env, exit, events };
}

const until = async (fn: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-prov-routes-'));
  detected.agents = [
    detection('claude', true, { version: '2.1.302', path: 'C:\\bin\\claude.exe' }),
    detection('codex', true, { version: 'codex-cli 0.0.0-fake', path: 'C:\\Program Files\\fake\\codex.cmd' }),
    detection('gemini', false, { error: 'Could not find "gemini" on PATH.' }),
    detection('opencode', false),
    detection('grok', false),
    detection('custom', true),
  ];
  detectCalls.length = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/providers', () => {
  it('lists every provider with install, login and account status; caches for 30 s', async () => {
    const t = await setup();
    fs.mkdirSync(t.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(t.env.CODEX_HOME, 'auth.json'), '{}');
    const res = (await t.app.inject({ method: 'GET', url: '/api/providers' })).json() as ProvidersResponse;
    expect(res.providers.map((p) => p.id)).toEqual(['claude', 'codex', 'gemini', 'opencode', 'grok']);
    expect(res.defaultAgent).toBe('claude');
    const codex = res.providers.find((p) => p.id === 'codex')!;
    expect(codex).toMatchObject({
      installed: true,
      version: 'codex-cli 0.0.0-fake',
      loggedIn: true,
      loginMethod: 'login file',
      billing: 'Subscription or API key',
      accountEnvVar: 'CODEX_HOME',
      multiAccount: true,
      usageAvailable: false,
      installCommand: 'npm i -g @openai/codex',
    });
    expect(codex.accounts).toEqual([
      expect.objectContaining({ id: 'codex-default', isDefault: true, loggedIn: true, configDir: path.resolve(t.env.CODEX_HOME) }),
    ]);
    const gemini = res.providers.find((p) => p.id === 'gemini')!;
    expect(gemini).toMatchObject({ installed: false, loggedIn: false, installCommand: 'npm i -g @google/gemini-cli' });
    expect(res.providers.find((p) => p.id === 'claude')).toMatchObject({ usageAvailable: true, loggedIn: false });
    expect(res.providers.find((p) => p.id === 'grok')).toMatchObject({ multiAccount: false, installCommand: 'irm https://x.ai/cli/install.ps1 | iex' });

    await t.app.inject({ method: 'GET', url: '/api/providers' });
    expect(detectCalls).toHaveLength(1);
    await t.app.inject({ method: 'GET', url: '/api/providers?fresh=1' });
    expect(detectCalls.at(-1)).toEqual({ fresh: true });
  });

  it('adds provider accounts through POST /api/providers/:id/accounts', async () => {
    const t = await setup();
    const created = (await t.app.inject({ method: 'POST', url: '/api/providers/codex/accounts', payload: { name: 'Work' } })).json();
    expect(created).toMatchObject({ provider: 'codex', name: 'Work', status: 'needs_login' });
    const bad = await t.app.inject({ method: 'POST', url: '/api/providers/grok/accounts', payload: { name: 'Two' } });
    expect(bad.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/providers/nope/accounts', payload: { name: 'X' } })).statusCode).toBe(404);
    const res = (await t.app.inject({ method: 'GET', url: '/api/providers' })).json() as ProvidersResponse;
    expect(res.providers.find((p) => p.id === 'codex')!.accounts.map((a) => a.name)).toEqual(['Default', 'Work']);
  });
});

describe('account env per provider', () => {
  it('gives a Codex console its account CODEX_HOME and drops accounts of another CLI', async () => {
    const t = await setup();
    const work = t.accounts.store.create('Work', 'codex');
    const claudeWork = t.accounts.store.create('Claude work');
    const env = (info: Partial<ConsoleInfo>) => t.manager.accountEnv!({ ...fakeConsole('x'), ...info } as ConsoleInfo, 'new');
    expect(env({ agent: 'codex', accountId: work.id })).toEqual({ CODEX_HOME: work.configDir });
    expect(env({ agent: 'codex', accountId: 'codex-default' })).toEqual({});
    expect(env({ agent: 'codex', accountId: claudeWork.id })).toEqual({});
    expect(env({ agent: 'codex', accountId: 'auto' })).toEqual({}); // nobody logged in: the CLI default
    fs.writeFileSync(path.join(work.configDir, 'auth.json'), '{}');
    expect(env({ agent: 'codex', accountId: 'auto' })).toEqual({ CODEX_HOME: work.configDir });
    expect(env({ agent: 'claude', accountId: claudeWork.id })).toEqual({ CLAUDE_CONFIG_DIR: claudeWork.configDir });
    expect(env({ agent: 'claude', accountId: work.id })).toEqual({});
    // Login consoles are custom commands: they use their account's provider
    expect(env({ agent: 'custom', accountId: work.id })).toEqual({ CODEX_HOME: work.configDir });
    expect(env({ agent: 'custom' })).toEqual({});
  });
});

describe('install', () => {
  it('opens an Install console and reports success when it exits 0', async () => {
    const t = await setup();
    const res = await t.app.inject({ method: 'POST', url: '/api/providers/gemini/install' });
    expect(res.statusCode).toBe(200);
    const { req, info } = t.created[0];
    expect(req).toMatchObject({ cwd: os.homedir(), name: 'Install · Gemini', agent: 'custom', command: 'npm i -g @google/gemini-cli' });
    expect(info.role).toBe('Install');
    // A second click shows the same console
    expect((await t.app.inject({ method: 'POST', url: '/api/providers/gemini/install' })).json().id).toBe(info.id);
    const status = (await t.app.inject({ method: 'GET', url: '/api/providers' })).json() as ProvidersResponse;
    expect(status.providers.find((p) => p.id === 'gemini')!.installConsoleId).toBe(info.id);

    detected.agents = detected.agents.map((a) => (a.id === 'gemini' ? detection('gemini', true, { version: '0.64.0' }) : a));
    t.exit(info.id, 0);
    await until(() => t.events().length > 0);
    expect(t.events()).toEqual([{ kind: 'installed', provider: 'gemini', label: 'Gemini CLI' }]);
    expect(detectCalls.some((c) => c.fresh)).toBe(true);
  });

  it('reports a failed install and keeps the terminal open', async () => {
    const t = await setup();
    const info = (await t.app.inject({ method: 'POST', url: '/api/providers/opencode/install' })).json() as ConsoleInfo;
    t.exit(info.id, 1);
    await until(() => t.events().length > 0);
    expect(t.events()).toEqual([{ kind: 'install-failed', provider: 'opencode', label: 'OpenCode', exitCode: 1 }]);
    expect(t.manager.get(info.id)).toBeTruthy();
  });
});

describe('login', () => {
  it('runs codex login on the account CODEX_HOME and closes once auth.json appears', async () => {
    const t = await setup();
    const work = t.accounts.store.create('Work', 'codex');
    const res = await t.app.inject({ method: 'POST', url: '/api/providers/codex/login', payload: { accountId: work.id } });
    expect(res.statusCode).toBe(200);
    const { req, info } = t.created[0];
    expect(req).toMatchObject({ agent: 'custom', command: '"C:\\Program Files\\fake\\codex.cmd" login', accountId: work.id, name: 'Login · Codex Work' });
    expect(info.role).toBe('Login');
    expect(t.accounts.store.state().loginConsoles[work.id]).toBe(info.id);
    // The env the console gets: its own CODEX_HOME (the user logs in there, we never type anything)
    expect(t.manager.accountEnv!(info, 'new')).toEqual({ CODEX_HOME: work.configDir });
    expect(t.typed).toEqual([]);

    fs.writeFileSync(path.join(work.configDir, 'auth.json'), '{}');
    await until(() => !t.manager.get(info.id));
    expect(t.events()).toEqual([{ kind: 'logged-in', provider: 'codex', label: 'Codex CLI', accountId: work.id, accountName: 'Work' }]);
    expect(t.accounts.store.state().loginConsoles[work.id]).toBeUndefined();
  });

  it('counts exit code 0 as done; refuses a CLI that is not installed or an account of another CLI', async () => {
    const t = await setup();
    const info = (await t.app.inject({ method: 'POST', url: '/api/providers/codex/login', payload: {} })).json() as ConsoleInfo;
    expect(t.created[0].req.accountId).toBeUndefined(); // the default account needs no env var
    t.exit(info.id, 0);
    await until(() => !t.manager.get(info.id));
    const gemini = await t.app.inject({ method: 'POST', url: '/api/providers/gemini/login', payload: {} });
    expect(gemini.statusCode).toBe(400);
    expect(gemini.json().error).toMatch(/not installed/);
    const wrong = await t.app.inject({ method: 'POST', url: '/api/providers/codex/login', payload: { accountId: 'default' } });
    expect(wrong.json().error).toMatch(/not a Codex CLI account/);
  });

  it('notices a rewritten login file, not just a new one', () => {
    const dir = path.join(tmp, 'acc');
    expect(loginStamp('codex', dir)).toBe(0);
    expect(loginSucceeded(0, 0)).toBe(false);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, '{}');
    const before = loginStamp('codex', dir);
    expect(loginSucceeded(0, before)).toBe(true);
    expect(loginSucceeded(before, before)).toBe(false);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(loginSucceeded(before, loginStamp('codex', dir))).toBe(true);
  });
});
