import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol.js';
import { estimateCostUsd, formatTokens, priceFor, weightedTokens } from '../shared/usage.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { registerOrchestrationRoutes } from './orchestration-routes.js';
import { SettingsStore } from './settings.js';
import {
  UsageIndex,
  attribute,
  breakdown,
  dayBuckets,
  listTranscripts,
  parseUsageLine,
  rangeStart,
  sessionIdFromPath,
  startOfLocalDay,
  sumRecords,
} from './usage.js';
import { BudgetMonitor, budgetStatuses, jobsBlockedFor, validateBudgetSetting } from './usage-budgets.js';
import { registerUsageRoutes } from './usage-routes.js';

const NOW = new Date(2026, 9, 18, 15, 0, 0).getTime(); // local 15:00

function line(opts: {
  id: string;
  ts?: number;
  model?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  sessionId?: string;
}): string {
  return JSON.stringify({
    parentUuid: 'x',
    message: {
      model: opts.model ?? 'claude-opus-5-5',
      id: opts.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: opts.input ?? 10,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 5,
        cache_creation: { ephemeral_1h_input_tokens: opts.cacheCreate ?? 0, ephemeral_5m_input_tokens: 0 },
      },
    },
    requestId: `req-${opts.id}`,
    type: 'assistant',
    uuid: `u-${opts.id}`,
    timestamp: new Date(opts.ts ?? NOW - 60_000).toISOString(),
    sessionId: opts.sessionId ?? 's1',
  });
}

const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'mention "usage" and "assistant"' } });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-usage-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseUsageLine', () => {
  it('reads tokens, model and timestamp from assistant entries only', () => {
    const r = parseUsageLine(line({ id: 'm1', input: 3, output: 7, cacheCreate: 100, cacheRead: 2000 }), 'sess', NOW);
    expect(r).toMatchObject({ id: 'm1', sessionId: 'sess', model: 'claude-opus-5-5', input: 3, output: 7, cacheCreate: 100, cacheCreate1h: 100, cacheRead: 2000 });
    expect(r!.ts).toBe(NOW - 60_000);
    expect(parseUsageLine(userLine, 's', NOW)).toBeNull();
    expect(parseUsageLine('{"type":"assistant","usage":', 's', NOW)).toBeNull(); // half a line
    expect(parseUsageLine(line({ id: 'x', model: '<synthetic>' }), 's', NOW)).toBeNull();
  });

  it('maps subagent transcripts to their parent session', () => {
    expect(sessionIdFromPath(path.join('p', 'C--dev', 'abc.jsonl'))).toBe('abc');
    expect(sessionIdFromPath(path.join('p', 'C--dev', 'abc', 'subagents', 'workflows', 'wf_1', 'agent-1.jsonl'))).toBe('abc');
  });
});

describe('UsageIndex', () => {
  it('deduplicates streamed copies of one message and keeps several models apart', () => {
    const index = new UsageIndex(() => NOW);
    const text = [
      line({ id: 'm1', output: 50 }),
      line({ id: 'm1', output: 50 }), // second content block of the same message
      line({ id: 'm2', model: 'claude-haiku-5-5', output: 20 }),
      userLine,
    ].join('\n');
    expect(index.ingestText(text, 's1')).toBe(2);
    expect(index.ingestText(line({ id: 'm1', output: 50 }), 's1')).toBe(0);
    const totals = sumRecords(index.records.values(), 0);
    expect(totals.output).toBe(70);
    expect(totals.messages).toBe(2);
  });

  it('reads files incrementally and waits for a partial last line', async () => {
    const index = new UsageIndex(() => NOW);
    const file = path.join(dir, 'sess-a.jsonl');
    const second = line({ id: 'b', output: 9 });
    fs.writeFileSync(file, `${line({ id: 'a' })}\n${second.slice(0, 40)}`);
    expect(await index.readFile(file)).toBe(1);
    const offset = index.knownFiles().get(file)!.offset;
    expect(offset).toBe(Buffer.byteLength(line({ id: 'a' })) + 1);
    fs.appendFileSync(file, `${second.slice(40)}\n`);
    expect(await index.readFile(file)).toBe(1);
    expect(index.records.get('b')?.sessionId).toBe('sess-a');
    expect(await index.readFile(file)).toBe(0); // nothing new
    // Truncated / rewritten file starts over; ids dedupe
    fs.writeFileSync(file, `${line({ id: 'c' })}\n`);
    expect(await index.readFile(file)).toBe(1);
    expect(index.records.size).toBe(3);
  });

  it('ignores records older than 31 days and lists only recent files', async () => {
    const index = new UsageIndex(() => NOW);
    index.ingestText(line({ id: 'old', ts: NOW - 40 * 24 * 3600_000 }), 's');
    expect(index.records.size).toBe(0);
    const proj = path.join(dir, 'C--dev-x');
    fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, 's1.jsonl'), '');
    fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-1.jsonl'), '');
    fs.writeFileSync(path.join(proj, 'notes.txt'), '');
    const found = await listTranscripts([{ accountId: 'default', dir }], 0);
    expect(found.map((c) => path.basename(c.file)).sort()).toEqual(['agent-1.jsonl', 's1.jsonl']);
    expect(await listTranscripts([{ accountId: 'default', dir }], Date.now() + 60_000)).toEqual([]);
  });
});

describe('attribution and ranges', () => {
  const index = new UsageIndex(() => NOW);
  index.ingestText(
    [
      line({ id: 'a1', sessionId: 'x', output: 100, ts: NOW - 60_000 }), // ada, current session
      line({ id: 'a2', output: 50, ts: NOW - 2 * 24 * 3600_000 }), // ada, past session, 2 days ago
      line({ id: 'b1', output: 30, model: 'claude-sonnet-5-5', ts: NOW - 6 * 3600_000 }), // bex, 6h ago
      line({ id: 'z1', output: 1000, ts: NOW - 30 * 60_000 }), // some other Claude Code session
    ].join('\n'),
    '',
  );
  // Session ids come from the lines here (no fallback): re-key them
  index.records.get('a1')!.sessionId = 'ada-session';
  index.records.get('a2')!.sessionId = 'ada-old';
  index.records.get('b1')!.sessionId = 'bex-session';
  index.records.get('z1')!.sessionId = 'elsewhere';

  const ada = { ...fakeConsole('ada'), pastSessionIds: ['ada-old'], projectId: 'p1' };
  const bex = fakeConsole('bex');
  const projects = [{ id: 'p1', name: 'Web', color: 'blue' as const, consoleIds: ['ada'], open: true, createdAt: 1 }];

  it('attributes by current and past session ids and buckets by project', () => {
    const attributed = attribute(index.records.values(), [ada, bex]);
    expect(attributed.map((r) => r.id).sort()).toEqual(['a1', 'a2', 'b1']);
    const week = breakdown(attributed, rangeStart('7d', NOW), [ada, bex], projects);
    expect(week.totals.output).toBe(180);
    expect(week.byConsole.map((r) => [r.label, r.output])).toEqual([['Ada', 150], ['Bex', 30]]);
    expect(week.byProject.map((r) => [r.label, r.output])).toEqual([['Web', 150], ['No project', 30]]);
    expect(week.byModel.map((r) => r.key).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('applies today / 5h / 7d ranges and day buckets', () => {
    const all = [...index.records.values()];
    expect(sumRecords(all, rangeStart('5h', NOW)).output).toBe(1100);
    expect(sumRecords(all, rangeStart('today', NOW)).output).toBe(1130);
    expect(sumRecords(all, rangeStart('7d', NOW)).output).toBe(1180);
    expect(rangeStart('today', NOW)).toBe(startOfLocalDay(NOW));
    const days = dayBuckets(all, 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[6].output).toBe(1130);
    expect(days[4].output).toBe(50);
  });
});

describe('prices', () => {
  it('estimates API-equivalent cost per model family', () => {
    expect(priceFor('claude-opus-5-5[1m]').input).toBe(4);
    expect(priceFor('claude-sonnet-4-5-20250929').input).toBe(3);
    expect(priceFor('claude-haiku-5-5').output).toBe(0.5);
    expect(priceFor('claude-fable-5-1').input).toBe(10);
    const cost = estimateCostUsd('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheCreate: 0, cacheRead: 1_000_000 });
    expect(cost).toBeCloseTo(4 + 20 + 0.2);
    expect(weightedTokens({ input: 1, output: 2, cacheCreate: 3, cacheRead: 100 })).toBe(16);
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
  });
});

describe('budgets', () => {
  const totals = (weighted: number) => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: weighted, weighted, costUsd: 0, messages: 1 });
  const settings = { budgetDailyTokens: 1000, budgetWeeklyTokens: 0, budget5hTokens: 500, projectDailyBudgets: { p1: 100 }, pauseJobsAtBudget: true };
  const projects = [{ id: 'p1', name: 'Web', color: 'blue' as const, consoleIds: [], open: true, createdAt: 1 }];

  it('validates budget settings', () => {
    const fail = (m: string) => new Error(m);
    expect(validateBudgetSetting('budgetDailyTokens', 5.4, fail)).toEqual({ budgetDailyTokens: 5 });
    expect(() => validateBudgetSetting('budgetDailyTokens', -1, fail)).toThrow();
    expect(validateBudgetSetting('projectDailyBudgets', { p1: 10, p2: 0 }, fail)).toEqual({ projectDailyBudgets: { p1: 10 } });
    expect(() => validateBudgetSetting('projectDailyBudgets', { 'bad id!': 1 }, fail)).toThrow();
  });

  it('alerts once at 80% and once at 100%, and re-arms when usage drops', () => {
    const monitor = new BudgetMonitor();
    const at = (today: number, last5h = 0, project = 0) =>
      budgetStatuses(settings, {
        machine: { today: totals(today), last5h: totals(last5h), last7d: totals(today) },
        projectToday: new Map([['p1', totals(project)]]),
        projects,
      });
    expect(monitor.evaluate(at(500)).alerts).toEqual([]);
    expect(monitor.evaluate(at(850)).alerts.map((a) => [a.budget.key, a.level])).toEqual([['daily', 80]]);
    expect(monitor.evaluate(at(900)).alerts).toEqual([]);
    const full = at(1200, 600, 100);
    expect(monitor.evaluate(full).alerts.map((a) => [a.budget.key, a.level])).toEqual([
      ['daily', 100],
      ['5h', 100],
      ['project:p1', 100],
    ]);
    expect(jobsBlockedFor(settings, full, null)?.key).toBe('daily');
    expect(jobsBlockedFor({ ...settings, pauseJobsAtBudget: false }, full, null)).toBeNull();
    const projectOnly = at(10, 0, 150);
    expect(jobsBlockedFor(settings, projectOnly, null)).toBeNull();
    expect(jobsBlockedFor(settings, projectOnly, 'p1')?.key).toBe('project:p1');
    // A new day: usage falls back to zero, the budgets re-arm
    expect(monitor.evaluate(at(0)).cleared).toEqual(['daily', '5h', 'project:p1']);
    expect(monitor.evaluate(at(820)).alerts.map((a) => a.level)).toEqual([80]);
  });
});

describe('usage routes', () => {
  async function setup(now = NOW) {
    const ctx = fakeManager([fakeConsole('ada', 'idle'), fakeConsole('bex', 'idle')]);
    const settings = new SettingsStore(null);
    const messages: ServerMessage[] = [];
    const app = Fastify();
    const usage = await registerUsageRoutes(app, {
      manager: ctx.manager,
      settings,
      broadcast: (m) => messages.push(m),
      roots: [{ accountId: 'default', dir }],
      now: () => now,
      autoStart: false,
    });
    await registerOrchestrationRoutes(app, { manager: ctx.manager, port: 1, token: 't' });
    return { ...ctx, app, usage, settings, messages };
  }

  it('reports usage per console and for the whole machine', async () => {
    fs.mkdirSync(path.join(dir, 'proj'));
    fs.writeFileSync(path.join(dir, 'proj', 'ada-session.jsonl'), `${line({ id: 'a', output: 1200 })}\n`);
    fs.writeFileSync(path.join(dir, 'proj', 'other.jsonl'), `${line({ id: 'o', output: 300 })}\n`);
    const { app, usage, messages } = await setup();
    await usage.fullScan(10_000);
    const report = (await app.inject({ method: 'GET', url: '/api/usage?range=today' })).json();
    expect(report.totals.output).toBe(1200);
    expect(report.byConsole[0]).toMatchObject({ key: 'ada', label: 'Ada', output: 1200 });
    expect(report.machineTotals.today.output).toBe(1500);
    expect((await app.inject({ method: 'GET', url: '/api/usage?range=year' })).statusCode).toBe(400);
    usage.tick();
    expect(messages.at(-1)).toMatchObject({ type: 'usage' });
    const snap = (messages.at(-1) as Extract<ServerMessage, { type: 'usage' }>).usage;
    expect(snap.consoles.ada.total).toBe(1210);
    const count = messages.length;
    usage.tick(); // nothing changed: no second broadcast
    expect(messages.length).toBe(count);
  });

  it('keeps the old session id when a console switches session', async () => {
    const { manager } = await setup();
    const info = manager.get('ada')!;
    manager.touch('ada'); // remember the first session
    info.sessionId = 'ada-new';
    manager.touch('ada');
    expect(manager.get('ada')!.pastSessionIds).toEqual(['ada-session']);
  });

  it('files budget actions and blocks send_job at 100% when pausing is on', async () => {
    fs.writeFileSync(path.join(dir, 'x.jsonl'), `${line({ id: 'big', output: 2000 })}\n`);
    const { app, usage, settings, manager } = await setup();
    await usage.fullScan(10_000);
    settings.patch({ budgetDailyTokens: 1000, pauseJobsAtBudget: true });
    usage.tick();
    const open = manager.actions.filter((a) => a.kind === 'budget' && !a.resolvedAt);
    expect(open.map((a) => a.title)).toEqual(['Today budget at 100%']);
    expect(open[0].detail).toMatch(/paused/);
    usage.tick();
    expect(manager.actions.filter((a) => a.kind === 'budget')).toHaveLength(1);

    const tool = await app.inject({ method: 'POST', url: '/bridge/ada/tools/send_job', payload: { to: 'bex', title: 't', message: 'm' } });
    expect(tool.json()).toMatchObject({ isError: true });
    expect(tool.json().content[0].text).toMatch(/New jobs are paused/);
    const rest = await app.inject({ method: 'POST', url: '/bridge/ada/jobs', payload: { to: 'bex', title: 't', message: 'm' } });
    expect(rest.statusCode).toBe(429);
    expect(manager.jobs).toHaveLength(0);

    settings.patch({ pauseJobsAtBudget: false });
    const ok = await app.inject({ method: 'POST', url: '/bridge/ada/jobs', payload: { to: 'bex', title: 't', message: 'm' } });
    expect(ok.statusCode).toBe(200);
    expect(manager.jobs).toHaveLength(1);
  });
});

describe('accounts', () => {
  it('tags records with the account of their transcript root and reports byAccount', async () => {
    const work = path.join(dir, 'work', 'projects', 'proj');
    const home = path.join(dir, 'home', 'projects', 'proj');
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 's1.jsonl'), `${line({ id: 'h', output: 100 })}\n`);
    fs.writeFileSync(path.join(work, 's2.jsonl'), `${line({ id: 'w', output: 40, ts: NOW - 3 * 24 * 3600_000 })}\n`);
    const ctx = fakeManager([]);
    const app = Fastify();
    const usage = await registerUsageRoutes(app, {
      manager: ctx.manager,
      settings: new SettingsStore(null),
      broadcast: () => {},
      roots: [
        { accountId: 'default', dir: path.join(dir, 'home', 'projects') },
        { accountId: 'work', dir: path.join(dir, 'work', 'projects') },
      ],
      now: () => NOW,
      autoStart: false,
    });
    await usage.fullScan(10_000);
    expect(usage.index.records.get('w')?.accountId).toBe('work');
    const report = (await app.inject({ method: 'GET', url: '/api/usage?range=7d' })).json();
    const byId = Object.fromEntries(report.byAccount.map((a: { accountId: string }) => [a.accountId, a]));
    expect(byId.default.today.output).toBe(100);
    expect(byId.work.today.output).toBe(0);
    expect(byId.work.last7d.output).toBe(40);
    expect(usage.snapshot().byAccount).toHaveLength(2);
  });

  it('re-scans when setTranscriptRoots changes the account folders', async () => {
    const { setTranscriptRoots, getTranscriptRoots, accountForFile, resetTranscriptRoots } = await import('./usage.js');
    const extra = path.join(dir, 'acct', 'projects');
    fs.mkdirSync(path.join(extra, 'p'), { recursive: true });
    fs.writeFileSync(path.join(extra, 'p', 's.jsonl'), `${line({ id: 'acct-1', output: 7 })}\n`);
    const ctx = fakeManager([]);
    const { UsageService } = await import('./usage-routes.js');
    // Never let the test scan the real ~/.claude: start with an empty root set
    setTranscriptRoots([{ accountId: 'default', dir: path.join(dir, 'none') }]);
    const service = new UsageService({ manager: ctx.manager, settings: new SettingsStore(null), broadcast: () => {}, now: () => NOW });
    service.start();
    try {
      await service.idle();
      expect(service.index.records.size).toBe(0);
      setTranscriptRoots([{ accountId: 'acct', dir: extra }]);
      expect(getTranscriptRoots()[0]).toEqual({ accountId: 'acct', dir: path.resolve(extra) });
      expect(accountForFile(path.join(extra, 'p', 's.jsonl'), getTranscriptRoots())).toBe('acct');
      await new Promise((r) => setTimeout(r, 50));
      await service.idle();
      expect(service.index.records.get('acct-1')?.accountId).toBe('acct');
    } finally {
      service.stop();
      resetTranscriptRoots();
    }
  });
});
