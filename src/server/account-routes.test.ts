import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsState, ConsoleInfo, ServerMessage } from '../shared/protocol.js';
import { registerAccountRoutes } from './account-routes.js';
import { DEFAULT_ACCOUNT_ID } from './accounts.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

let tmp: string;

function writeLogin(dir: string, email: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
}

async function setup() {
  const ctx = fakeManager([fakeConsole('ada', 'idle')]);
  const created: ConsoleInfo[] = [];
  // No PTYs: create registers a fake console the way ConsoleManager would
  ctx.manager.create = vi.fn((req) => {
    const info = { ...fakeConsole(`c${created.length}`, 'starting'), name: req.name ?? 'X', cwd: req.cwd, accountId: req.accountId };
    created.push(info);
    (ctx.manager as unknown as { register: (i: ConsoleInfo) => void }).register(info);
    return info;
  });
  ctx.manager.remove = vi.fn((id: string) => {
    (ctx.manager as unknown as { consoles: Map<string, unknown> }).consoles.delete(id);
    ctx.manager.emit('removed', id);
  });
  const messages: ServerMessage[] = [];
  const app = Fastify();
  const dataDir = path.join(tmp, 'home');
  const service = await registerAccountRoutes(app, {
    manager: ctx.manager,
    broadcast: (m) => messages.push(m),
    dataDir,
    env: {},
    defaultDir: path.join(tmp, 'default'),
    refreshMs: 60_000,
    loginPollMs: 60_000,
  });
  writeLogin(path.join(tmp, 'default'), 'me@home.com');
  return { ...ctx, app, service, messages, created, dataDir };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-acct-routes-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('account routes', () => {
  it('lists, creates, renames, orders and removes accounts', async () => {
    const t = await setup();
    const list = (await t.app.inject({ method: 'GET', url: '/api/accounts' })).json() as AccountsState;
    expect(list.accounts.map((a) => [a.id, a.status])).toEqual([[DEFAULT_ACCOUNT_ID, 'ok']]);
    expect(list).toMatchObject({ autoSwitch: 'ask', newAgentAccount: 'auto' });

    const res = await t.app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'Work' } });
    expect(res.statusCode).toBe(200);
    const work = res.json();
    expect(work).toMatchObject({ name: 'Work', status: 'needs_login', isDefault: false });
    expect(work.configDir).toBe(path.join(t.dataDir, 'accounts', work.id));
    expect(fs.existsSync(path.join(t.dataDir, 'accounts.json'))).toBe(true);
    expect(t.messages.some((m) => m.type === 'accounts')).toBe(true);

    expect((await t.app.inject({ method: 'PATCH', url: `/api/accounts/${work.id}`, payload: { name: 'Job' } })).json().name).toBe('Job');
    const ordered = (await t.app.inject({ method: 'PATCH', url: '/api/accounts', payload: { order: [work.id], autoSwitch: 'ask' } })).json();
    expect(ordered.accounts.map((a: { id: string }) => a.id)).toEqual([work.id, DEFAULT_ACCOUNT_ID]);
    expect(ordered.autoSwitch).toBe('ask');
    expect((await t.app.inject({ method: 'PATCH', url: '/api/accounts', payload: { autoSwitch: 'x' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/accounts', payload: {} })).statusCode).toBe(400);

    expect((await t.app.inject({ method: 'DELETE', url: `/api/accounts/${DEFAULT_ACCOUNT_ID}` })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/accounts/${work.id}` })).json()).toEqual({ ok: true });
    expect(fs.existsSync(work.configDir)).toBe(false);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/accounts/nope' })).statusCode).toBe(404);
  });

  it('gives consoles their account config dir and resolves Auto', async () => {
    const t = await setup();
    const env = t.manager.accountEnv!;
    // One account only: nothing changes, nothing is recorded
    const solo: ConsoleInfo = { ...fakeConsole('x'), accountId: 'auto' };
    expect(env(solo, 'new')).toEqual({});
    expect(solo.accountId).toBeUndefined();

    const work = t.service.store.create('Work');
    writeLogin(work.configDir, 'me@work.com');
    t.service.store.patch({ order: [work.id, DEFAULT_ACCOUNT_ID] });
    const auto: ConsoleInfo = { ...fakeConsole('y'), accountId: 'auto' };
    expect(env(auto, 'new')).toEqual({ CLAUDE_CONFIG_DIR: work.configDir });
    expect(auto.accountId).toBe(work.id);
    // Limited: Auto falls back to the next one
    t.service.store.markLimited(work.id, { resetsAt: Date.now() + 60_000 });
    const next: ConsoleInfo = { ...fakeConsole('z'), accountId: 'auto' };
    expect(env(next, 'new')).toEqual({});
    expect(next.accountId).toBe(DEFAULT_ACCOUNT_ID);
    // A removed account falls back to the default
    const orphan: ConsoleInfo = { ...fakeConsole('o'), accountId: 'gone' };
    expect(env(orphan, 'resume')).toEqual({});
    expect(orphan.accountId).toBeUndefined();
  });

  it('opens a Login console, types /login when the session starts, and closes it after the login', async () => {
    vi.useFakeTimers();
    const t = await setup();
    const work = t.service.store.create('Work');
    const res = await t.app.inject({ method: 'POST', url: `/api/accounts/${work.id}/login` });
    const login = res.json() as ConsoleInfo;
    expect(login).toMatchObject({ name: 'Login · Work', cwd: os.homedir(), accountId: work.id, role: 'Login' });
    expect(t.service.store.state().loginConsoles).toEqual({ [work.id]: login.id });
    // A second click reuses it
    expect((await t.app.inject({ method: 'POST', url: `/api/accounts/${work.id}/login` })).json().id).toBe(login.id);

    t.manager.get(login.id)!.status = 'idle';
    t.manager.emit('hook', login.id, { hook_event_name: 'SessionStart' });
    vi.advanceTimersByTime(1500);
    expect(t.typed).toEqual([{ id: login.id, text: '/login' }]);

    // The user logs in; Claude Code writes the account metadata
    writeLogin(work.configDir, 'me@work.com');
    t.manager.emit('output', login.id, 'Login successful. Press Enter to continue');
    vi.advanceTimersByTime(400);
    expect(t.service.store.get(work.id)?.status).toBe('ok');
    expect(t.service.store.state().loginConsoles).toEqual({});
    vi.advanceTimersByTime(1600);
    expect(t.manager.get(login.id)).toBeUndefined();
  });

  it('clear-limit makes an account available again', async () => {
    const t = await setup();
    t.service.store.markLimited(DEFAULT_ACCOUNT_ID, { resetsAt: Date.now() + 60_000 });
    const res = await t.app.inject({ method: 'POST', url: `/api/accounts/${DEFAULT_ACCOUNT_ID}/clear-limit` });
    expect(res.json().status).toBe('ok');
  });
});
