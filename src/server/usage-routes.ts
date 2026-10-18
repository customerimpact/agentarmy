import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ActionItem, ConsoleInfo, ServerMessage } from '../shared/protocol.js';
import {
  USAGE_RANGES,
  type AccountUsage,
  emptyTotals,
  type BudgetStatus,
  type UsageBroadcast,
  type UsageRange,
  type UsageReport,
  type UsageTotals,
} from '../shared/usage.js';
import { defaultTranscriptPath } from './activity.js';
import { textResult } from './bridge-tools.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import type { SettingsStore } from './settings.js';
import {
  DEFAULT_ACCOUNT,
  MAX_AGE_MS,
  accountForFile,
  getTranscriptRoots,
  onTranscriptRootsChange,
  type TranscriptRoot,
  type UsageRecord,
  UsageIndex,
  addRecord,
  attribute,
  breakdown,
  dayBuckets,
  listTranscripts,
  rangeStart,
  startOfLocalDay,
  sumRecords,
  type Candidate,
} from './usage.js';
import {
  BudgetMonitor,
  budgetDetail,
  budgetStatuses,
  budgetTitle,
  jobsBlockedFor,
  overallJobsPaused,
  type BudgetSettings,
} from './usage-budgets.js';

// Wires the usage index to the board: background scans, live-console tailing, GET /api/usage,
// the 'usage' WebSocket broadcast, budget alerts (ActionItem kind 'budget') and the job gate.

export interface UsageTiming {
  tickMs: number; // broadcast + budget check
  liveMs: number; // re-read transcripts of the board's consoles
  rescanMs: number; // re-read recently modified known files
  fullScanMs: number; // walk the transcript folders again for new files
  sliceMs: number; // work this long, then yield to the event loop
  startupBudgetMs: number; // the first scan stops after this; later full scans pick up the rest
}

const DEFAULT_TIMING: UsageTiming = {
  tickMs: 15_000,
  liveMs: 5_000,
  rescanMs: 60_000,
  fullScanMs: 5 * 60_000,
  sliceMs: 40,
  startupBudgetMs: 3 * 60_000,
};
const RECENT_MS = 6 * 60 * 60 * 1000;
const MAX_PAST_SESSIONS = 50;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface UsageServiceOptions {
  manager: ConsoleManager;
  settings: SettingsStore;
  broadcast: (msg: ServerMessage) => void;
  roots?: TranscriptRoot[]; // fixed roots (tests); default follows setTranscriptRoots
  timing?: Partial<UsageTiming>;
  now?: () => number;
}

export class UsageService {
  readonly index: UsageIndex;
  private readonly timing: UsageTiming;
  private fixedRoots: TranscriptRoot[] | undefined;
  private unsubscribeRoots: (() => void) | null = null;
  private readonly now: () => number;
  private readonly monitor = new BudgetMonitor();
  private transcripts = new Map<string, Set<string>>(); // console id -> transcript files seen in hooks
  private lastSession = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private lastBroadcast = '';
  scanning = true;

  constructor(private readonly options: UsageServiceOptions) {
    this.now = options.now ?? Date.now;
    this.index = new UsageIndex(this.now);
    this.fixedRoots = options.roots;
    const envTick = Number(process.env.AGENTARMY_USAGE_TICK_MS);
    this.timing = {
      ...DEFAULT_TIMING,
      ...(envTick > 0 ? { tickMs: envTick, liveMs: Math.min(envTick, DEFAULT_TIMING.liveMs) } : {}),
      ...options.timing,
    };
    const { manager } = options;
    manager.on('console', (info) => this.onConsole(info));
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('removed', (id) => {
      this.transcripts.delete(id);
      this.lastSession.delete(id);
    });
  }

  private get roots(): TranscriptRoot[] {
    return this.fixedRoots ?? getTranscriptRoots();
  }

  start(): void {
    // Accounts added or removed: scan their transcript folders right away
    if (!this.fixedRoots) {
      this.unsubscribeRoots = onTranscriptRootsChange(() => void this.enqueue(() => this.fullScan(60_000)).then(() => this.tick()));
    }
    const every = (ms: number, fn: () => unknown): void => {
      const timer = setInterval(() => void fn(), ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    void this.enqueue(() => this.fullScan(this.timing.startupBudgetMs)).finally(() => {
      this.scanning = false;
      this.tick();
    });
    every(this.timing.tickMs, () => this.tick());
    every(this.timing.liveMs, () => this.enqueue(() => this.readLive()));
    every(this.timing.rescanMs, () => this.enqueue(() => this.rescanRecent()));
    every(this.timing.fullScanMs, () => this.enqueue(() => this.fullScan(60_000)));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeRoots?.();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // Scans run one at a time
  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.queue.then(() => (this.stopped ? undefined : fn())).catch(() => undefined);
    this.queue = next;
    return next;
  }

  // Waits for queued scans (tests)
  async idle(): Promise<void> {
    await this.queue;
  }

  // Keeps every session id a console has had, so usage from before a /clear still counts for it
  private onConsole(info: ConsoleInfo): void {
    const last = this.lastSession.get(info.id);
    if (last && last !== info.sessionId) {
      const past = (info.pastSessionIds ?? []).filter((s) => s !== last && s !== info.sessionId);
      info.pastSessionIds = [...past, last].slice(-MAX_PAST_SESSIONS);
      this.options.manager.persist();
    }
    this.lastSession.set(info.id, info.sessionId);
  }

  private onHook(id: string, payload: HookPayload): void {
    const file = (payload as Record<string, unknown>).transcript_path;
    if (typeof file === 'string' && file.endsWith('.jsonl')) {
      let set = this.transcripts.get(id);
      if (!set) this.transcripts.set(id, (set = new Set()));
      set.add(file);
    }
    // A finished turn just wrote its usage; pick it up without waiting for the next poll
    if (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'SessionEnd') {
      setTimeout(() => void this.enqueue(() => this.readLive([id])), 300).unref?.();
    }
  }

  private liveFiles(ids?: string[]): string[] {
    const files = new Set<string>();
    for (const c of this.options.manager.list()) {
      if (ids && !ids.includes(c.id)) continue;
      for (const f of this.transcripts.get(c.id) ?? []) files.add(f);
      for (const s of [c.sessionId, ...(c.pastSessionIds ?? [])]) files.add(defaultTranscriptPath(c.cwd, s));
    }
    return [...files];
  }

  async readLive(ids?: string[]): Promise<void> {
    const roots = this.roots;
    for (const file of this.liveFiles(ids)) await this.index.readFile(file, undefined, accountForFile(file, roots));
  }

  private async readCandidates(candidates: Candidate[], budgetMs: number): Promise<void> {
    const start = Date.now();
    let slice = Date.now();
    for (const c of candidates) {
      if (this.stopped || Date.now() - start > budgetMs) return;
      if (!this.index.needsRead(c)) continue;
      await this.index.readFile(c.file, c, c.accountId);
      if (Date.now() - slice > this.timing.sliceMs) {
        await yieldNow();
        slice = Date.now();
      }
    }
  }

  async fullScan(budgetMs: number): Promise<void> {
    const candidates = await listTranscripts(this.roots, this.now() - MAX_AGE_MS);
    // The board's own consoles first, so their numbers show up quickly
    const live = new Set(this.liveFiles());
    candidates.sort((a, b) => Number(live.has(b.file)) - Number(live.has(a.file)));
    await this.readCandidates(candidates, budgetMs);
    this.index.prune();
  }

  private async rescanRecent(): Promise<void> {
    const cutoff = this.now() - RECENT_MS;
    const recent = [...this.index.knownFiles().entries()].filter(([, s]) => s.mtimeMs >= cutoff).map(([f]) => f);
    for (const file of recent) {
      if (this.stopped) return;
      await this.index.readFile(file);
    }
  }

  // ---------- numbers ----------

  private budgetSettings(): BudgetSettings {
    return this.options.settings.get();
  }

  private machineTotals(now: number): UsageReport['machineTotals'] {
    const records = [...this.index.records.values()];
    return {
      today: sumRecords(records, startOfLocalDay(now)),
      last5h: sumRecords(records, now - 5 * HOUR_MS),
      last7d: sumRecords(records, now - 7 * DAY_MS),
    };
  }

  // Today / 5 h / 7 d per account; every configured account is listed, even with no usage yet
  private byAccount(now: number): AccountUsage[] {
    const ids = new Set(this.roots.map((r) => r.accountId));
    const groups = new Map<string, UsageRecord[]>();
    for (const r of this.index.records.values()) {
      const id = r.accountId ?? DEFAULT_ACCOUNT;
      ids.add(id);
      let list = groups.get(id);
      if (!list) groups.set(id, (list = []));
      list.push(r);
    }
    return [...ids].map((accountId) => {
      const list = groups.get(accountId) ?? [];
      return {
        accountId,
        today: sumRecords(list, startOfLocalDay(now)),
        last5h: sumRecords(list, now - 5 * HOUR_MS),
        last7d: sumRecords(list, now - 7 * DAY_MS),
      };
    });
  }

  private budgets(now: number, machine: UsageReport['machineTotals']): BudgetStatus[] {
    const consoles = this.options.manager.list();
    const projectToday = new Map<string, UsageTotals>();
    const from = startOfLocalDay(now);
    for (const r of attribute(this.index.records.values(), consoles)) {
      if (r.ts < from || !r.projectId) continue;
      let t = projectToday.get(r.projectId);
      if (!t) projectToday.set(r.projectId, (t = emptyTotals()));
      addRecord(t, r);
    }
    return budgetStatuses(this.budgetSettings(), { machine, projectToday, projects: this.options.manager.projects });
  }

  report(range: UsageRange): UsageReport {
    const now = this.now();
    const from = rangeStart(range, now);
    const { manager } = this.options;
    const consoles = manager.list();
    const attributed = attribute(this.index.records.values(), consoles);
    const days = range === '30d' ? 30 : 7;
    const machineTotals = this.machineTotals(now);
    const budgets = this.budgets(now, machineTotals);
    return {
      range,
      from,
      generatedAt: now,
      scanning: this.scanning,
      ...breakdown(attributed, from, consoles, manager.projects),
      byDay: dayBuckets(attributed, days, now),
      machineByDay: dayBuckets(this.index.records.values(), days, now),
      machineTotals,
      byAccount: this.byAccount(now),
      budgets,
      jobsPaused: overallJobsPaused(this.budgetSettings(), budgets),
    };
  }

  snapshot(): UsageBroadcast {
    const now = this.now();
    const consoles = this.options.manager.list();
    const perConsole: UsageBroadcast['consoles'] = {};
    const today = emptyTotals();
    const todayFrom = startOfLocalDay(now);
    for (const r of attribute(this.index.records.values(), consoles)) {
      const t = (perConsole[r.consoleId] ??= { total: 0, weighted: 0, costUsd: 0 });
      const one = emptyTotals();
      addRecord(one, r);
      t.total += one.total;
      t.weighted += one.weighted;
      t.costUsd += one.costUsd;
      if (r.ts >= todayFrom) addRecord(today, r);
    }
    const machine = this.machineTotals(now);
    const budgets = this.budgets(now, machine);
    return {
      at: now,
      scanning: this.scanning,
      consoles: perConsole,
      today,
      machine,
      byAccount: this.byAccount(now),
      budgets,
      jobsPaused: overallJobsPaused(this.budgetSettings(), budgets),
    };
  }

  // Returns why a job from this console may not be sent right now, or null
  jobBlockReason(consoleId: string): string | null {
    const settings = this.budgetSettings();
    if (!settings.pauseJobsAtBudget) return null;
    const now = this.now();
    const sender = this.options.manager.get(consoleId);
    const blocked = jobsBlockedFor(settings, this.budgets(now, this.machineTotals(now)), sender?.projectId);
    if (!blocked) return null;
    return (
      `New jobs are paused: ${budgetTitle(blocked, 100)} (${budgetDetail(blocked, false).replace(/\.$/, '')}). ` +
      'Do not retry now. Tell the user, or wait until usage drops or the budget is raised in Settings > Usage & budgets.'
    );
  }

  // Broadcast when the numbers changed, and file / resolve budget alerts
  tick(): void {
    if (this.stopped) return;
    const snap = this.snapshot();
    const { at: _at, ...rest } = snap;
    const key = JSON.stringify(rest);
    if (key !== this.lastBroadcast) {
      this.lastBroadcast = key;
      this.options.broadcast({ type: 'usage', usage: snap });
    }
    const { alerts, cleared } = this.monitor.evaluate(snap.budgets);
    for (const key of cleared) this.resolveBudget(key);
    const pauses = this.budgetSettings().pauseJobsAtBudget;
    for (const alert of alerts) this.fileAlert(alert.budget, alert.level, alert.level === 100 && pauses);
  }

  private budgetItems(key: string): ActionItem[] {
    return this.options.manager.actions.filter(
      (a) => a.kind === 'budget' && !a.resolvedAt && (a as ActionItem & { budgetKey?: string }).budgetKey === key,
    );
  }

  private fileAlert(budget: BudgetStatus, level: 80 | 100, paused: boolean): void {
    const { manager } = this.options;
    const title = budgetTitle(budget, level);
    const open = this.budgetItems(budget.key);
    if (open.some((a) => a.title === title)) return;
    // The 100% item replaces the 80% one
    for (const item of open) this.resolveItem(item);
    const item: ActionItem & { budgetKey: string } = {
      id: crypto.randomUUID(),
      consoleId: null,
      kind: 'budget',
      title,
      detail: budgetDetail(budget, paused),
      createdAt: Date.now(),
      budgetKey: budget.key,
    };
    manager.actions.push(item);
    manager.emit('action', item);
    manager.persist();
  }

  private resolveBudget(key: string): void {
    for (const item of this.budgetItems(key)) this.resolveItem(item);
  }

  private resolveItem(item: ActionItem): void {
    item.resolvedAt = Date.now();
    item.resolvedBy = 'auto';
    this.options.manager.emit('action', item);
    this.options.manager.persist();
  }
}

export interface UsageRouteOptions {
  manager: ConsoleManager;
  settings: SettingsStore;
  broadcast: (msg: ServerMessage) => void;
  roots?: TranscriptRoot[];
  timing?: Partial<UsageTiming>;
  now?: () => number;
  autoStart?: boolean; // default true
}

// Register before the orchestration routes so the job gate runs ahead of their handlers
export async function registerUsageRoutes(app: FastifyInstance, options: UsageRouteOptions): Promise<UsageService> {
  // Unit tests build servers too; never let them scan the developer's real transcripts
  const roots = options.roots ?? (process.env.VITEST ? [] : undefined);
  const service = new UsageService({ ...options, roots });
  if (options.autoStart !== false) service.start();
  app.addHook('onClose', async () => service.stop());

  app.get('/api/usage', async (request, reply) => {
    const raw = (request.query as Record<string, unknown> | undefined)?.range;
    const range = (typeof raw === 'string' && raw ? raw : 'today') as UsageRange;
    if (!USAGE_RANGES.includes(range)) {
      return reply.code(400).send({ error: `range must be one of ${USAGE_RANGES.join(', ')}` });
    }
    return service.report(range);
  });

  // The compact numbers a tab needs right after it connects (later ones arrive over the socket)
  app.get('/api/usage/live', async () => service.snapshot());

  // "Pause new jobs at 100%": agent-to-agent jobs go through the bridge (MCP tool or REST)
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST') return;
    const match = /^\/bridge\/([^/?]+)\/(jobs|tools\/send_job)(?:\?|$)/.exec(request.url);
    if (!match) return;
    const reason = service.jobBlockReason(decodeURIComponent(match[1]));
    if (!reason) return;
    if (match[2] === 'jobs') return reply.code(429).send({ error: reason });
    return reply.send(textResult(reason, true));
  });

  return service;
}
