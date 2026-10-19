import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STATE_VERSION, type BoardItem, type KanbanData, type Workspace } from '../shared/protocol.js';

// Fake PTYs: record what is typed, never start a real claude
interface FakePty {
  written: string[];
  write(data: string): void;
  kill(): void;
  resize(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}
const ptys: FakePty[] = [];
vi.mock('node-pty', () => ({
  spawn: () => {
    const p: FakePty = {
      written: [],
      write(data) {
        this.written.push(data);
      },
      kill() {},
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-items-'));
process.env.AGENTARMY_HOME = home;
const { ConsoleManager } = await import('./consoles.js');
const { buildServer } = await import('./server.js');
const { StateStore } = await import('./store.js');

const PORT = 4317;
const TOKEN = 't';
const HEADERS = { host: `127.0.0.1:${PORT}`, 'x-agentarmy-token': TOKEN };

async function newApp() {
  const manager = new ConsoleManager({
    port: PORT,
    token: TOKEN,
    onChange: () => {},
    sendTiming: { quietMs: 1, minWaitMs: 1, maxWaitMs: 5, pollMs: 1, verifyMs: 10_000 },
  });
  const app: FastifyInstance = await buildServer({ port: PORT, token: TOKEN, dev: false, manager });
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown) => {
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

describe('state migration', () => {
  it('loads a v2 file with no items and one Main workspace, and puts everything on it', () => {
    const file = path.join(home, 'v2.json');
    const consoles = [
      {
        id: 'c1',
        name: 'Ada',
        cwd: home,
        sessionId: '11111111-1111-1111-1111-111111111111',
        status: 'resting',
        statusChangedAt: 1,
        layout: { x: 0, y: 0, width: 700, height: 500 },
        createdAt: 1,
      },
    ];
    fs.writeFileSync(file, JSON.stringify({ version: 2, consoles, jobs: [], actions: [], projects: [], browsers: [] }));
    const state = new StateStore(file).load();
    expect(state.version).toBe(STATE_VERSION);
    expect(state.items).toEqual([]);
    expect(state.workspaces).toEqual([{ id: 'main', name: 'Main', createdAt: 0, order: 0 }]);

    const manager = new ConsoleManager({ port: PORT, token: TOKEN, onChange: () => {} });
    manager.restore(state, { resumeAll: false });
    expect(manager.get('c1')?.workspaceId).toBe('main');
    expect(manager.getState().activeWorkspaceId).toBe('main');
  });

  it('moves things on a deleted/unknown workspace to the first one', () => {
    const manager = new ConsoleManager({ port: PORT, token: TOKEN, onChange: () => {} });
    const ws: Workspace[] = [{ id: 'w2', name: 'Two', createdAt: 1, order: 0 }];
    const item: BoardItem = {
      id: 'i1',
      kind: 'note',
      workspaceId: 'gone',
      layout: { x: 0, y: 0, width: 200, height: 100 },
      data: { text: 'hi' },
      createdAt: 1,
      updatedAt: 1,
    };
    manager.restore(
      { version: STATE_VERSION, consoles: [], jobs: [], actions: [], projects: [], browsers: [], items: [item], workspaces: ws, activeWorkspaceId: 'nope' },
      { resumeAll: false },
    );
    expect(manager.items[0].workspaceId).toBe('w2');
    expect(manager.activeWorkspaceId).toBe('w2');
  });
});

describe('board items', () => {
  it('creates, updates and deletes an item, and broadcasts each change', async () => {
    const { app, manager, call } = await newApp();
    const events: string[] = [];
    manager.on('item', (i) => events.push(`item:${i.id}`));
    manager.on('item-removed', (id) => events.push(`removed:${id}`));

    const created = await call('POST', '/api/items', { kind: 'note', layout: { x: 10, y: 20 }, data: { text: '# Hi' } });
    expect(created.status).toBe(200);
    const item = created.body as BoardItem;
    expect(item).toMatchObject({ kind: 'note', workspaceId: 'main', layout: { x: 10, y: 20, width: 280, height: 220 }, data: { text: '# Hi' } });

    const patched = await call('PATCH', `/api/items/${item.id}`, { layout: { width: 300 }, data: { text: 'changed' }, color: 'teal' });
    expect(patched.body).toMatchObject({ layout: { x: 10, y: 20, width: 300 }, data: { text: 'changed' }, color: 'teal' });

    expect((await call('GET', '/api/state')).body.items).toHaveLength(1);
    expect((await call('DELETE', `/api/items/${item.id}`)).status).toBe(200);
    expect((await call('DELETE', `/api/items/${item.id}`)).status).toBe(404);
    expect(events).toEqual([`item:${item.id}`, `item:${item.id}`, `removed:${item.id}`]);
    await app.close();
  });

  it('fills kind defaults and validates input', async () => {
    const { app, call } = await newApp();
    const kanban = (await call('POST', '/api/items', { kind: 'kanban' })).body as BoardItem;
    expect((kanban.data as unknown as KanbanData).columns.map((c) => c.title)).toEqual(['To do', 'Doing', 'Done']);
    const checklist = (await call('POST', '/api/items', { kind: 'checklist' })).body as BoardItem;
    expect(checklist.data).toEqual({ title: 'Checklist', entries: [] });
    // A file item (agent D) is accepted with whatever data its renderer needs
    expect((await call('POST', '/api/items', { kind: 'file', data: { path: 'C:/x.ts' } })).status).toBe(200);

    expect((await call('POST', '/api/items', { kind: 'bogus' })).status).toBe(400);
    expect((await call('POST', '/api/items', { kind: 'note', layout: { x: 'a' } })).status).toBe(400);
    expect((await call('POST', '/api/items', { kind: 'note', layout: { width: 5 } })).status).toBe(400);
    expect((await call('POST', '/api/items', { kind: 'note', data: [1] })).status).toBe(400);
    expect((await call('POST', '/api/items', { kind: 'note', color: 'pink' })).status).toBe(400);
    expect((await call('POST', '/api/items', { kind: 'note', data: { text: 'x'.repeat(300_000) } })).status).toBe(400);
    expect((await call('PATCH', '/api/items/nope', { data: {} })).status).toBe(404);
    await app.close();
  });

  it('assigns a kanban card to an agent and marks it finished when the turn ends', async () => {
    const { app, manager, call } = await newApp();
    const agent = manager.create({ cwd: home });
    const board = (
      await call('POST', '/api/items', {
        kind: 'kanban',
        data: {
          title: 'Work',
          columns: [
            { id: 'todo', title: 'To do', cards: [{ id: 'k1', title: 'Fix login', description: 'Users get a 500' }] },
            { id: 'doing', title: 'Doing', cards: [] },
            { id: 'done', title: 'Done', cards: [] },
          ],
        },
      })
    ).body as BoardItem;

    const res = await call('POST', `/api/items/${board.id}/cards/k1/assign`, { consoleId: agent.id });
    expect(res.status).toBe(200);
    const data = res.body.data as KanbanData;
    expect(data.columns[0].cards).toEqual([]);
    expect(data.columns[1].cards[0]).toMatchObject({ id: 'k1', assignedConsoleId: agent.id });
    await vi.waitFor(() => expect(ptys[0].written.join('')).toContain('Fix login\n\nUsers get a 500'));

    // The agent works, then its turn ends
    const assignedAt = data.columns[1].cards[0].assignedAt!;
    manager.handleHook(agent.id, { hook_event_name: 'UserPromptSubmit' } as never);
    expect(manager.items[0].data.columns).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    manager.handleHook(agent.id, { hook_event_name: 'Stop' } as never);
    const card = (manager.items[0].data as unknown as KanbanData).columns[1].cards[0];
    expect(card.finishedAt).toBeGreaterThan(assignedAt);

    expect((await call('POST', `/api/items/${board.id}/cards/nope/assign`, { consoleId: agent.id })).status).toBe(404);
    expect((await call('POST', `/api/items/${board.id}/cards/k1/assign`, {})).status).toBe(400);
    await app.close();
  });
});

describe('workspaces', () => {
  it('creates a workspace, makes it active and puts new things there', async () => {
    const { app, manager, call } = await newApp();
    const ws = (await call('POST', '/api/workspaces', {})).body as Workspace;
    expect(ws.name).toBe('Workspace 2');
    expect(manager.activeWorkspaceId).toBe(ws.id);

    const c = manager.create({ cwd: home });
    expect(c.workspaceId).toBe(ws.id);
    const explicit = manager.create({ cwd: home, workspaceId: 'main' });
    expect(explicit.workspaceId).toBe('main');
    const item = (await call('POST', '/api/items', { kind: 'note' })).body as BoardItem;
    expect(item.workspaceId).toBe(ws.id);
    const tile = (await call('POST', '/api/browsers', { linkedConsoleId: explicit.id })).body;
    expect(tile.workspaceId).toBe('main'); // next to its console

    const listed = (await call('GET', '/api/workspaces')).body;
    expect(listed.workspaces.map((w: Workspace) => w.name)).toEqual(['Main', 'Workspace 2']);
    expect(listed.activeWorkspaceId).toBe(ws.id);
    await app.close();
  });

  it('renames, reorders, switches and stores a viewport per workspace', async () => {
    const { app, manager, call } = await newApp();
    const ws = (await call('POST', '/api/workspaces', { name: 'Docs' })).body as Workspace;
    expect((await call('PATCH', `/api/workspaces/${ws.id}`, { name: '  Research ' })).body.name).toBe('Research');
    expect((await call('PATCH', `/api/workspaces/${ws.id}`, { name: '' })).status).toBe(400);
    expect((await call('PATCH', `/api/workspaces/${ws.id}`, { viewport: { x: 1, y: 2, zoom: 0.5 } })).body.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect((await call('PUT', '/api/workspaces/order', { ids: [ws.id, 'main'] })).status).toBe(200);
    expect((await call('GET', '/api/workspaces')).body.workspaces[0].id).toBe(ws.id);
    expect((await call('PUT', '/api/workspaces/order', { ids: [ws.id] })).status).toBe(400);
    expect((await call('PUT', '/api/workspaces/active', { id: 'main' })).status).toBe(200);
    expect(manager.activeWorkspaceId).toBe('main');
    expect((await call('PUT', '/api/workspaces/active', { id: 'nope' })).status).toBe(404);
    await app.close();
  });

  it('moves consoles, projects and items, and only deletes empty workspaces unless told where to move', async () => {
    const { app, manager, call } = await newApp();
    const a = manager.create({ cwd: home });
    const b = manager.create({ cwd: home });
    const project = (await call('POST', '/api/projects', { name: 'P', consoleIds: [a.id, b.id] })).body;
    const note = (await call('POST', '/api/items', { kind: 'note' })).body as BoardItem;
    const ws = (await call('POST', '/api/workspaces', { name: 'Other' })).body as Workspace;

    // Moving one console of a project on its own takes it out of the project
    expect((await call('POST', `/api/workspaces/${ws.id}/move`, { consoleIds: [b.id] })).status).toBe(200);
    expect(manager.get(b.id)?.workspaceId).toBe(ws.id);
    expect(manager.get(b.id)?.projectId ?? null).toBeNull();
    // A project moves with all its consoles
    await call('POST', `/api/workspaces/${ws.id}/move`, { projectIds: [project.id], itemIds: [note.id] });
    expect(manager.get(a.id)?.workspaceId).toBe(ws.id);
    expect(manager.projects[0].workspaceId).toBe(ws.id);
    expect(manager.items[0].workspaceId).toBe(ws.id);

    const refused = await call('DELETE', `/api/workspaces/${ws.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.count).toBe(4);
    expect((await call('DELETE', `/api/workspaces/${ws.id}`, { moveTo: 'main' })).status).toBe(200);
    expect(manager.workspaces.map((w) => w.id)).toEqual(['main']);
    expect(manager.get(a.id)?.workspaceId).toBe('main');
    expect(manager.activeWorkspaceId).toBe('main');
    expect((await call('DELETE', '/api/workspaces/main')).status).toBe(400); // the last one stays
    await app.close();
  });
});
