import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ActionItem, ConsoleInfo, Job, Project } from '../shared/protocol';
import type { ConsoleManager } from './consoles';
import { buildRecap, formatDuration, localDate, recapMarkdown, recapMessages, type RecapEvent } from './recap-build';
import { RecapLog, RecapScheduler } from './recap';
import { SettingsStore } from './settings';

const DAY = '2026-10-18';
const at = (hh: number, mm = 0) => new Date(`${DAY}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime();
const ada = { c: 'c1', n: 'Ada', r: 'Frontend', p: 'p1', pn: 'Shop', cwd: 'C:/dev/shop' };
const bex = { c: 'c2', n: 'Bex', cwd: 'C:/dev/api' };

const events: RecapEvent[] = [
  { t: at(9), type: 'prompt', ...ada, text: 'Build the cart' },
  { t: at(9, 1), type: 'file', ...ada, text: 'src/cart.tsx' },
  { t: at(9, 2), type: 'file', ...ada, text: 'src/cart.test.tsx' },
  { t: at(9, 3), type: 'command', ...ada, text: 'npm test' },
  { t: at(9, 5), type: 'action_open', ...ada, id: 'a1', kind: 'needs_you', text: 'Ada needs you', detail: 'Allow npm install?' },
  { t: at(9, 8), type: 'action_resolved', ...ada, id: 'a1', kind: 'needs_you', waited: 3 * 60_000 },
  { t: at(9, 10), type: 'todo_done', ...ada, text: 'Cart component' },
  { t: at(9, 11), type: 'job', ...bex, id: 'j1', dir: 'in', peer: 'Ada', text: 'Add cart API', status: 'sent' },
  { t: at(9, 11), type: 'job', ...ada, id: 'j1', dir: 'out', peer: 'Bex', text: 'Add cart API', status: 'sent' },
  { t: at(9, 30), type: 'job', ...bex, id: 'j1', dir: 'in', peer: 'Ada', text: 'Add cart API', status: 'done', detail: 'POST /cart added' },
  { t: at(9, 30), type: 'job', ...ada, id: 'j1', dir: 'out', peer: 'Bex', text: 'Add cart API', status: 'done', detail: 'POST /cart added' },
  { t: at(9, 40), type: 'turn', ...ada, text: 'The cart works and has tests.' },
  { t: at(9, 41), type: 'preview', ...ada, text: 'http://localhost:5173/' },
  { t: at(10), type: 'action_open', ...bex, id: 'a2', kind: 'request', text: 'Need the Stripe key' },
  { t: at(10, 5), type: 'action_open', ...bex, id: 'a3', kind: 'error', text: 'Bex hit an error', detail: 'API overloaded' },
];

describe('buildRecap (past day)', () => {
  const recap = buildRecap(DAY, events, { now: at(23) + 86_400_000 });

  it('groups agents by project, or by folder without one', () => {
    expect(recap.isToday).toBe(false);
    expect(recap.projects.map((p) => p.name)).toEqual(['api', 'Shop']);
    expect(recap.projects[1].agents[0]).toMatchObject({ name: 'Ada', role: 'Frontend', prompts: 1 });
  });

  it('collects jobs, todos, files, highlights, needs-you waits and errors', () => {
    const a = recap.projects[1].agents[0];
    expect(a.jobsSent).toEqual([{ title: 'Add cart API', status: 'done', peer: 'Bex', result: 'POST /cart added' }]);
    expect(a.todosCompleted).toEqual(['Cart component']);
    expect(a.files).toEqual(['src/cart.tsx', 'src/cart.test.tsx']);
    expect(a.highlights).toEqual(['Ran `npm test`', 'Opened preview http://localhost:5173/', 'The cart works and has tests.']);
    expect(a.needsYou).toEqual({ count: 1, waitedMs: 180_000, longestMs: 180_000, open: 0 });
    const b = recap.projects[0].agents[0];
    expect(b.jobsReceived).toEqual([{ title: 'Add cart API', status: 'done', peer: 'Ada', result: 'POST /cart added' }]);
    expect(b.errors).toEqual(['Bex hit an error: API overloaded']);
  });

  it('lists requests still open at the end of the log', () => {
    expect(recap.openActions).toEqual([{ title: 'Need the Stripe key', agent: 'Bex', openedAt: at(10) }]);
    expect(recap.totals).toEqual({ agents: 2, prompts: 1, jobsDone: 1, todosCompleted: 1, files: 2, needsYou: 1 });
  });

  it('renders Markdown', () => {
    const md = recapMarkdown(recap);
    expect(md).toContain('# AgentArmy recap · Sun 18 Oct 2026');
    expect(md).toContain('2 agents · 1 prompt · 1 job done · 1 todo completed · 2 files touched · 1 needs-you');
    expect(md).toContain('## Shop (`C:/dev/shop`)');
    expect(md).toContain('### Ada (Frontend)');
    expect(md).toContain('needed you 1× (waited 3m, longest 3m)');
    expect(md).toContain('- Job from Ada: **Add cart API** — done: POST /cart added');
    expect(md).toContain('- Sent **Add cart API** to Bex — done');
    expect(md).toContain('- Files: `src/cart.tsx`, `src/cart.test.tsx`');
    expect(md).toContain('## Open action items\n- Bex: Need the Stripe key (since 10:00)');
  });

  it('says so when nothing happened', () => {
    expect(recapMarkdown(buildRecap(DAY, [], { now: at(12) }))).toContain('No agent activity was recorded on this day.');
  });
});

describe('buildRecap (today, with live state)', () => {
  it('adds what is next from live todos and the live action inbox', () => {
    const consoles = [
      { id: 'c1', name: 'Ada', cwd: 'C:/dev/shop', projectId: 'p1', todos: [
        { content: 'Cart component', status: 'completed' },
        { content: 'Checkout', status: 'in_progress', activeForm: 'Building checkout' },
        { content: 'Docs', status: 'pending' },
      ] },
      { id: 'c3', name: 'Cy', cwd: 'C:/dev/idle', todos: [] },
    ] as unknown as ConsoleInfo[];
    const actions: ActionItem[] = [
      { id: 'a9', consoleId: 'c1', kind: 'needs_you', title: 'Ada needs you', createdAt: at(11, 50) },
      { id: 'a1', consoleId: 'c1', kind: 'needs_you', title: 'old', createdAt: at(9), resolvedAt: at(9, 1) },
    ];
    const projects = [{ id: 'p1', name: 'Shop' }] as Project[];
    const recap = buildRecap(DAY, events, { now: at(12), live: { consoles, actions, projects } });
    const a = recap.projects.find((p) => p.name === 'Shop')!.agents[0];
    expect(a.next.map((t) => t.content)).toEqual(['Checkout', 'Docs']);
    expect(a.needsYou).toMatchObject({ count: 2, open: 1, longestMs: 10 * 60_000 });
    expect(recap.openActions.map((o) => o.title)).toEqual(['Ada needs you']);
    expect(recap.projects.flatMap((p) => p.agents.map((x) => x.name))).not.toContain('Cy');
    expect(recapMarkdown(recap)).toContain('- Next: Building checkout (in progress), Docs');
  });
});

describe('recap helpers', () => {
  it('formats durations', () => {
    expect([formatDuration(4000), formatDuration(150_000), formatDuration(3 * 3600_000), formatDuration(90 * 60_000)]).toEqual(['4s', '3m', '3h', '1h 30m']);
  });

  it('splits long messages for Discord and converts headings for Slack', () => {
    const md = ['# Title', '**bold**', ...Array.from({ length: 200 }, (_, i) => `- line ${i} ${'x'.repeat(20)}`)].join('\n');
    const discord = recapMessages(md, 'discord');
    expect(discord.length).toBeGreaterThan(1);
    expect(discord.every((m) => m.length <= 1900)).toBe(true);
    expect(discord.join('\n')).toBe(md);
    const slack = recapMessages(md, 'slack');
    expect(slack[0].startsWith('*Title*\n*bold*')).toBe(true);
  });
});

// ---------- RecapLog against a fake manager ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-recap-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeManager() {
  const consoles = new Map<string, ConsoleInfo>();
  const m = Object.assign(new EventEmitter(), {
    projects: [] as Project[],
    actions: [] as ActionItem[],
    get: (id: string) => consoles.get(id),
    list: () => [...consoles.values()],
  });
  const add = (info: Partial<ConsoleInfo> & { id: string }) => {
    const full = { name: info.id, cwd: tmp, status: 'idle', ...info } as ConsoleInfo;
    consoles.set(info.id, full);
    return full;
  };
  return { manager: m as unknown as ConsoleManager, emitter: m, add };
}

describe('RecapLog', () => {
  it('records hooks, todos, jobs and actions to a JSONL file and builds the recap', async () => {
    const dir = path.join(tmp, 'recaps');
    let now = at(14);
    const { manager, emitter, add } = fakeManager();
    const log = new RecapLog(manager, dir, () => now);
    const ada = add({ id: 'c1', name: 'Ada' });
    add({ id: 'c2', name: 'Bex' });

    emitter.emit('hook', 'c1', { hook_event_name: 'UserPromptSubmit', prompt: 'do it' });
    emitter.emit('hook', 'c1', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'src', 'a.ts') } });
    emitter.emit('hook', 'c1', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'src', 'a.ts') } });
    emitter.emit('hook', 'c1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    emitter.emit('hook', 'c1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npx vitest run' } });
    emitter.emit('hook', 'c1', { hook_event_name: 'Stop', last_assistant_message: 'All green.' });

    emitter.emit('console', ada); // baseline
    ada.todos = [{ content: 'Write a.ts', status: 'completed' }, { content: 'Ship', status: 'pending' }];
    emitter.emit('console', ada);
    emitter.emit('console', ada);

    const job: Job = { id: 'j1', fromId: 'c1', toId: 'c2', title: 'Review a.ts', message: 'm', status: 'sent', createdAt: now, updatedAt: now };
    emitter.emit('job', job);
    emitter.emit('job', job); // no change, not logged again
    emitter.emit('job', { ...job, status: 'done', result: 'LGTM' });

    const action: ActionItem = { id: 'a1', consoleId: 'c1', kind: 'needs_you', title: 'Ada needs you', createdAt: now };
    emitter.emit('action', action);
    now += 90_000;
    emitter.emit('action', { ...action, resolvedAt: now, resolvedBy: 'auto' });
    log.recordPreview('c1', 'http://localhost:5173/');
    log.recordPreview('c1', 'http://localhost:5173/');

    const lines = (await log.read(DAY)).map((e) => e.type);
    expect(lines).toEqual(['prompt', 'file', 'command', 'turn', 'todo_done', 'job', 'job', 'job', 'job', 'action_open', 'action_resolved', 'preview']);
    expect(fs.readFileSync(path.join(dir, `${DAY}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(12);

    const { recap, markdown } = await log.recap(DAY);
    const a = recap.projects[0].agents.find((x) => x.name === 'Ada')!;
    expect(a.files).toEqual(['src/a.ts']);
    expect(a.todosCompleted).toEqual(['Write a.ts']);
    expect(a.next).toEqual([{ content: 'Ship', status: 'pending' }]);
    expect(a.needsYou).toMatchObject({ count: 1, waitedMs: 90_000 });
    expect(markdown).toContain('Sent **Review a.ts** to Bex — done');
    expect(markdown).toContain('Ran `npx vitest run`');
    expect(markdown).not.toContain('ls -la');
  });

  it('ignores actions restored from an earlier run', async () => {
    const { manager, emitter } = fakeManager();
    const log = new RecapLog(manager, null, () => at(15));
    emitter.emit('action', { id: 'old', consoleId: null, kind: 'request', title: 'x', createdAt: at(8) });
    expect(await log.read(DAY)).toEqual([]);
  });
});

describe('RecapScheduler', () => {
  it('sends once a day after the configured time, only when enabled and a webhook is set', async () => {
    const { manager } = fakeManager();
    let now = at(17, 59);
    const log = new RecapLog(manager, null, () => now);
    const settings = new SettingsStore(null);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const scheduler = new RecapScheduler(log, settings, () => now, fetchImpl);
    expect(await scheduler.tick()).toBe(false); // off by default
    settings.patch({ recapAutoSend: true, recapTime: '18:00', discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' });
    expect(await scheduler.tick()).toBe(false); // too early
    now = at(18, 0);
    expect(await scheduler.tick()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body).content).toContain('AgentArmy recap');
    expect(await scheduler.tick()).toBe(false); // already sent today
    expect(localDate(now)).toBe(DAY);
  });
});

describe('recap and preview routes', () => {
  it('serves the recap, validates dates, and refuses to send without a webhook', async () => {
    const { ConsoleManager } = await import('./consoles.js');
    const { buildServer } = await import('./server.js');
    const manager = new ConsoleManager({ port: 4317, token: 't', onChange: () => {} });
    const app = await buildServer({ port: 4317, token: 't', dev: false, manager });
    const headers = { host: '127.0.0.1:4317', 'x-agentarmy-token': 't' };
    try {
      const ok = await app.inject({ url: `/api/recap?date=${DAY}`, headers });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ recap: { date: DAY, projects: [] }, canSend: [] });
      expect(ok.json().markdown).toContain('No agent activity');
      expect((await app.inject({ url: '/api/recap?date=2026-13-40', headers })).statusCode).toBe(400);
      const send = await app.inject({ method: 'POST', url: '/api/recap/send', headers, payload: { date: DAY } });
      expect(send.statusCode).toBe(400);
      expect(send.json().error).toContain('No Slack or Discord webhook');
      expect((await app.inject({ url: '/api/previews/offers', headers })).json()).toEqual([]);
      expect((await app.inject({ method: 'DELETE', url: '/api/previews/offers/nope', headers })).statusCode).toBe(404);
      expect((await app.inject({ url: '/api/recap', headers: { host: headers.host } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
