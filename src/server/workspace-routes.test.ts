import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LaunchTemplateResponse, Project } from '../shared/protocol.js';

// Fake PTYs: record what is typed, never start a real claude
interface FakePty {
  written: string[];
  killed: boolean;
  args: string[];
  write(data: string): void;
  kill(): void;
  resize(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}
const ptys: FakePty[] = [];
vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[] | string) => {
    const p: FakePty = {
      written: [],
      killed: false,
      args: Array.isArray(args) ? args : [args],
      write(data) {
        this.written.push(data);
      },
      kill() {
        this.killed = true;
      },
      resize() {},
      onData() {},
      onExit() {},
    };
    ptys.push(p);
    return p;
  },
}));
vi.mock('./claude-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-path.js')>()),
  resolveClaudeExecutable: () => 'claude',
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ws-'));
process.env.AGENTARMY_HOME = home;
const { ConsoleManager } = await import('./consoles.js');
const { buildServer } = await import('./server.js');
const { ProjectService } = await import('./projects.js');
const { FirstPromptQueue } = await import('./templates.js');

const PORT = 4317;
const TOKEN = 't';
const HEADERS = { host: `127.0.0.1:${PORT}`, 'x-agentarmy-token': TOKEN };

function newManager() {
  return new ConsoleManager({ port: PORT, token: TOKEN, onChange: () => {} });
}

async function newApp() {
  const manager = newManager();
  const app: FastifyInstance = await buildServer({ port: PORT, token: TOKEN, dev: false, manager });
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: HEADERS, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { app, manager, call };
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  ptys.length = 0;
});

describe('ProjectService', () => {
  it('moves a console between projects and deletes a project that becomes empty', () => {
    const manager = newManager();
    const projects = new ProjectService(manager);
    const a = manager.create({ cwd: home });
    const b = manager.create({ cwd: home });
    const p1 = projects.create({ name: 'One', consoleIds: [a.id, b.id] });
    expect(manager.get(a.id)?.projectId).toBe(p1.id);
    const p2 = projects.create({ name: 'Two', consoleIds: [a.id] });
    expect(p1.consoleIds).toEqual([b.id]);
    expect(manager.get(a.id)?.projectId).toBe(p2.id);
    expect(p2.color).not.toBe(p1.color);
    const removed: string[] = [];
    manager.on('project-removed', (id) => removed.push(id));
    projects.create({ name: 'Three', consoleIds: [b.id] });
    expect(removed).toEqual([p1.id]);
    expect(manager.projects.map((p) => p.name)).toEqual(['Two', 'Three']);
  });

  it('drops a removed console and deletes the empty project', () => {
    const manager = newManager();
    const projects = new ProjectService(manager);
    const a = manager.create({ cwd: home });
    const p = projects.create({ name: 'Solo', consoleIds: [a.id] });
    manager.remove(a.id);
    expect(manager.projects.find((x) => x.id === p.id)).toBeUndefined();
  });

  it('close suspends running members, open resumes them, resume-all skips closed projects', () => {
    const manager = newManager();
    const projects = new ProjectService(manager);
    const a = manager.create({ cwd: home });
    const b = manager.create({ cwd: home });
    const outside = manager.create({ cwd: home });
    const p = projects.create({ name: 'P', consoleIds: [a.id, b.id] });
    projects.close(p.id);
    expect(p.open).toBe(false);
    expect(manager.get(a.id)?.status).toBe('suspended');
    expect(manager.get(b.id)?.status).toBe('suspended');
    expect(ptys[0].killed && ptys[1].killed).toBe(true);
    manager.suspend(outside.id);
    expect(manager.resumeAll()).toBe(1);
    expect(manager.get(a.id)?.status).toBe('suspended');
    const before = ptys.length;
    projects.open(p.id);
    expect(p.open).toBe(true);
    expect(manager.get(a.id)?.status).toBe('starting');
    expect(ptys.length).toBe(before + 2);
    expect(ptys.at(-1)!.args.join(' ')).toContain('--resume');
  });

  it('ungroups on delete and keeps the consoles', () => {
    const manager = newManager();
    const projects = new ProjectService(manager);
    const a = manager.create({ cwd: home });
    const p = projects.create({ name: 'P', consoleIds: [a.id] });
    projects.remove(p.id);
    expect(manager.get(a.id)?.projectId).toBeNull();
    expect(manager.projects).toEqual([]);
  });
});

describe('FirstPromptQueue', () => {
  it('sends the prompt once, when the console first becomes idle', async () => {
    const manager = newManager();
    const queue = new FirstPromptQueue(manager, 0);
    const a = manager.create({ cwd: home });
    queue.add(a.id, 'hello');
    manager.handleHook(a.id, { hook_event_name: 'SessionStart', session_id: a.sessionId });
    // sendText types on the next tick (sends to one console are queued)
    await vi.waitFor(() => expect(ptys[0].written).toContain('hello'));
    manager.handleHook(a.id, { hook_event_name: 'UserPromptSubmit' });
    manager.handleHook(a.id, { hook_event_name: 'SessionStart', session_id: a.sessionId });
    expect(ptys[0].written.filter((w) => w === 'hello').length).toBe(1);
    expect(queue.has(a.id)).toBe(false);
  });

  it('gives up after the timeout', () => {
    vi.useFakeTimers();
    try {
      const manager = newManager();
      const queue = new FirstPromptQueue(manager, 0);
      const a = manager.create({ cwd: home });
      queue.add(a.id, 'late', 1000);
      vi.advanceTimersByTime(1001);
      manager.handleHook(a.id, { hook_event_name: 'SessionStart', session_id: a.sessionId });
      expect(ptys[0].written).not.toContain('late');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('workspace routes', () => {
  it('POST /api/consoles/:id/send: 404 unknown, 409 not running, 200 running', async () => {
    const { app, manager, call } = await newApp();
    const a = manager.create({ cwd: home });
    expect((await call('POST', '/api/consoles/nope/send', { text: 'x' })).status).toBe(404);
    expect((await call('POST', `/api/consoles/${a.id}/send`, {})).status).toBe(400);
    const ok = await call('POST', `/api/consoles/${a.id}/send`, { text: 'hi' });
    expect(ok).toEqual({ status: 200, body: { ok: true } });
    expect(ptys[0].written).toContain('hi');
    manager.suspend(a.id);
    expect((await call('POST', `/api/consoles/${a.id}/send`, { text: 'x' })).status).toBe(409);
    await app.close();
  });

  it('project CRUD + open/close over HTTP', async () => {
    const { app, manager, call } = await newApp();
    const a = manager.create({ cwd: home });
    expect((await call('POST', '/api/projects', { name: '', consoleIds: [a.id] })).status).toBe(400);
    expect((await call('POST', '/api/projects', { name: 'X', consoleIds: ['nope'] })).status).toBe(400);
    const created = await call('POST', '/api/projects', { name: 'X', consoleIds: [a.id] });
    const p = created.body as Project;
    expect(p).toMatchObject({ name: 'X', open: true, consoleIds: [a.id] });
    const patched = await call('PATCH', `/api/projects/${p.id}`, { name: 'Y', color: 'teal' });
    expect(patched.body).toMatchObject({ name: 'Y', color: 'teal' });
    expect((await call('PATCH', `/api/projects/${p.id}`, { color: 'pink' })).status).toBe(400);
    expect((await call('POST', `/api/projects/${p.id}/close`)).body).toMatchObject({ open: false });
    expect(manager.get(a.id)?.status).toBe('suspended');
    expect((await call('POST', `/api/projects/${p.id}/open`)).body).toMatchObject({ open: true });
    expect(manager.get(a.id)?.status).toBe('starting');
    expect((await call('DELETE', `/api/projects/${p.id}`)).body).toEqual({ ok: true });
    expect((await call('DELETE', `/api/projects/${p.id}`)).status).toBe(404);
    await app.close();
  });

  it('lists templates and launches one with projects, roles and queued prompts', async () => {
    const { app, manager, call } = await newApp();
    const list = await call('GET', '/api/templates');
    expect(list.body.map((t: { id: string }) => t.id)).toContain('dev-hq');
    expect((await call('POST', '/api/templates/nope/launch', { cwd: home })).status).toBe(404);
    expect((await call('POST', '/api/templates/dev-hq/launch', {})).status).toBe(400);
    const res = await call('POST', '/api/templates/dev-hq/launch', { cwd: home, projectName: 'Shop' });
    expect(res.status).toBe(200);
    const body = res.body as LaunchTemplateResponse;
    expect(body.consoles).toHaveLength(13);
    expect(body.projects.map((p) => p.name)).toEqual([
      'Shop · Orchestrator',
      'Shop · Frontend',
      'Shop · Backend',
      'Shop · Reviewers',
    ]);
    const orchestrator = body.consoles.find((c) => c.role === 'Orchestrator')!;
    expect(orchestrator.projectId).toBe(body.projects[0].id);
    expect(body.consoles.filter((c) => c.role === 'Frontend')).toHaveLength(4);
    for (const c of body.consoles) expect(manager.get(c.id)?.projectId).toBeTruthy();
    // Second launch goes below the first instead of on top of it
    const again = await call('POST', '/api/templates/solo-reviewer/launch', { cwd: home });
    const top = Math.min(...(again.body as LaunchTemplateResponse).consoles.map((c) => c.layout.y));
    const bottom = Math.max(...body.consoles.map((c) => c.layout.y + c.layout.height));
    expect(top).toBeGreaterThan(bottom);
    await app.close();
  });

  it('POST /api/git/clone validates input', async () => {
    const { app, call } = await newApp();
    const bad = await call('POST', '/api/git/clone', { url: 'ext::sh -c calc', parent: home });
    expect(bad.status).toBe(400);
    expect((await call('POST', '/api/git/clone', { url: 'a/b', parent: path.join(home, 'nope') })).status).toBe(400);
    await app.close();
  });
});
