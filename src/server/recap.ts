import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ActionItem, ConsoleInfo, Job, RecapResponse, WebhookKind } from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import type { SettingsStore } from './settings.js';
import { postWebhook } from './webhooks.js';
import { buildRecap, isRecapDate, localDate, recapMarkdown, recapMessages, type RecapEvent } from './recap-build.js';

// The day's notable events, appended to <AGENTARMY_HOME>/recaps/<YYYY-MM-DD>.jsonl (one small JSON
// object per line), and the daily recap built from them. dir null keeps everything in memory (tests).

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// Shell commands worth a line in the recap; everything else is noise
const NOTABLE_COMMAND =
  /\b(test|tests|vitest|jest|pytest|playwright|build|lint|typecheck|tsc|deploy|publish|release|migrate|git\s+(commit|push|merge|tag|rebase)|gh\s+pr|docker\s+(build|compose))\b/i;
const MAX_TEXT = 300;
const MAX_DETAIL = 600;

type Obj = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function relPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file).replace(/\\/g, '/');
}

export class RecapLog {
  private memory = new Map<string, RecapEvent[]>();
  private writes: Promise<void> = Promise.resolve();
  private seen = new Set<string>(); // per-day dedupe keys (files, commands, todos)
  private seenDate = '';
  private todos = new Map<string, Map<string, string>>(); // console -> todo key -> status
  private jobStatus = new Map<string, string>();
  private actionState = new Map<string, 'open' | 'resolved'>();
  private readonly startedAt: number;

  constructor(
    private readonly manager: ConsoleManager,
    readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('console', (info) => this.onConsole(info));
    manager.on('job', (job) => this.onJob(job));
    manager.on('action', (action) => this.onAction(action));
  }

  private context(consoleId: string | null): Pick<RecapEvent, 'c' | 'n' | 'r' | 'p' | 'pn' | 'cwd'> {
    const info = consoleId ? this.manager.get(consoleId) : undefined;
    if (!info) return { c: consoleId };
    const project = info.projectId ? this.manager.projects.find((p) => p.id === info.projectId) : undefined;
    return {
      c: info.id,
      n: info.name,
      ...(info.role ? { r: info.role } : {}),
      ...(info.projectId ? { p: info.projectId } : {}),
      ...(project ? { pn: project.name } : {}),
      cwd: info.cwd,
    };
  }

  private once(key: string): boolean {
    const today = localDate(this.now());
    if (today !== this.seenDate) {
      this.seenDate = today;
      this.seen.clear();
    }
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  record(type: RecapEvent['type'], consoleId: string | null, fields: Partial<RecapEvent> = {}): RecapEvent {
    const ev: RecapEvent = { t: this.now(), type, ...this.context(consoleId), ...fields };
    if (ev.text) ev.text = clip(ev.text, MAX_TEXT);
    if (ev.detail) ev.detail = clip(ev.detail, MAX_DETAIL);
    const date = localDate(ev.t);
    if (!this.dir) {
      const list = this.memory.get(date) ?? [];
      list.push(ev);
      this.memory.set(date, list);
      return ev;
    }
    const file = path.join(this.dir, `${date}.jsonl`);
    const line = `${JSON.stringify(ev)}\n`;
    this.writes = this.writes
      .then(() => fs.promises.mkdir(this.dir!, { recursive: true }))
      .then(() => fs.promises.appendFile(file, line))
      .catch((err: unknown) => console.warn(`[agentarmy] Could not write the recap log: ${String(err)}`));
    return ev;
  }

  async read(date: string): Promise<RecapEvent[]> {
    if (!this.dir) return [...(this.memory.get(date) ?? [])];
    await this.writes;
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(this.dir, `${date}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const events: RecapEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as RecapEvent;
        if (ev && typeof ev.t === 'number' && typeof ev.type === 'string') events.push(ev);
      } catch {
        // a line cut short by a crash; skip it
      }
    }
    return events;
  }

  async recap(date: string): Promise<{ recap: ReturnType<typeof buildRecap>; markdown: string }> {
    const live = { consoles: this.manager.list(), actions: this.manager.actions, projects: this.manager.projects };
    const recap = buildRecap(date, await this.read(date), { live, now: this.now() });
    return { recap, markdown: recapMarkdown(recap) };
  }

  onHook(consoleId: string, payload: HookPayload): void {
    const info = this.manager.get(consoleId);
    if (!info) return;
    const event = payload.hook_event_name;
    if (event === 'UserPromptSubmit') {
      this.record('prompt', consoleId, { text: str(payload.prompt) ?? '' });
    } else if (event === 'Stop') {
      const said = str(payload.last_assistant_message);
      if (said) this.record('turn', consoleId, { text: said });
    } else if (event === 'PreToolUse') {
      const tool = str(payload.tool_name) ?? '';
      const input = (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) as Obj;
      if (FILE_TOOLS.has(tool)) {
        const file = str(input.file_path) ?? str(input.notebook_path);
        if (file) {
          const rel = relPath(file, info.cwd);
          if (this.once(`file|${consoleId}|${rel}`)) this.record('file', consoleId, { text: rel });
        }
      } else if (tool === 'Bash' || tool === 'PowerShell') {
        const command = str(input.command);
        if (command && NOTABLE_COMMAND.test(command)) {
          const short = clip(command, 100);
          if (this.once(`cmd|${consoleId}|${short}`)) this.record('command', consoleId, { text: short });
        }
      }
    }
  }

  onConsole(info: ConsoleInfo): void {
    const current = new Map((info.todos ?? []).map((t) => [t.id ?? t.content, t.status] as const));
    const previous = this.todos.get(info.id);
    this.todos.set(info.id, current);
    // First sight (server start, resumed console): take a baseline instead of logging old work
    if (!previous) return;
    for (const t of info.todos ?? []) {
      const key = t.id ?? t.content;
      if (t.status !== 'completed' || previous.get(key) === 'completed') continue;
      if (this.once(`todo|${info.id}|${t.content}`)) this.record('todo_done', info.id, { text: t.content });
    }
  }

  onJob(job: Job): void {
    if (this.jobStatus.get(job.id) === job.status) return;
    this.jobStatus.set(job.id, job.status);
    const name = (id: string | null) => (id ? (this.manager.get(id)?.name ?? 'a closed agent') : 'you');
    const fields = { id: job.id, text: job.title, status: job.status, ...(job.result ? { detail: job.result } : {}) };
    this.record('job', job.toId, { ...fields, dir: 'in', peer: name(job.fromId) });
    if (job.fromId) this.record('job', job.fromId, { ...fields, dir: 'out', peer: name(job.toId) });
  }

  onAction(action: ActionItem): void {
    const state = this.actionState.get(action.id);
    if (!action.resolvedAt) {
      // Items restored from disk were opened in an earlier run (and probably logged then)
      if (state || action.createdAt < this.startedAt) return;
      this.actionState.set(action.id, 'open');
      this.record('action_open', action.consoleId, {
        id: action.id,
        kind: action.kind,
        text: action.title,
        ...(action.detail ? { detail: action.detail } : {}),
      });
      return;
    }
    if (state !== 'open') return;
    this.actionState.set(action.id, 'resolved');
    this.record('action_resolved', action.consoleId, {
      id: action.id,
      kind: action.kind,
      waited: Math.max(0, action.resolvedAt - action.createdAt),
    });
  }

  recordPreview(consoleId: string, url: string): void {
    if (this.once(`preview|${consoleId}|${url}`)) this.record('preview', consoleId, { text: url });
  }
}

// ---------- Sending ----------

type FetchLike = Parameters<typeof postWebhook>[3];

export function configuredKinds(settings: SettingsStore): WebhookKind[] {
  const s = settings.get();
  return (['slack', 'discord'] as const).filter((k) => (k === 'slack' ? s.slackWebhookUrl : s.discordWebhookUrl));
}

export async function sendRecap(markdown: string, kinds: WebhookKind[], settings: SettingsStore, fetchImpl?: FetchLike): Promise<void> {
  const s = settings.get();
  for (const kind of kinds) {
    const url = kind === 'slack' ? s.slackWebhookUrl : s.discordWebhookUrl;
    if (!url) continue;
    // In order, one after another, so the channel reads top to bottom
    for (const text of recapMessages(markdown, kind)) await postWebhook(kind, url, text, fetchImpl);
  }
}

// Settings > Daily recap: once a day, at or after recapTime, post today's recap
export class RecapScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastSent: string | null = null;
  private sending = false;

  constructor(
    private readonly log: RecapLog,
    private readonly settings: SettingsStore,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl?: FetchLike,
  ) {
    this.lastSent = this.readMarker();
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Returns true when it sent
  async tick(): Promise<boolean> {
    const s = this.settings.get();
    if (!s.recapAutoSend || this.sending) return false;
    const now = new Date(this.now());
    const today = localDate(now.getTime());
    if (this.lastSent === today) return false;
    const [h, m] = s.recapTime.split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return false;
    const kinds = configuredKinds(this.settings);
    if (!kinds.length) return false;
    this.sending = true;
    try {
      const { markdown } = await this.log.recap(today);
      await sendRecap(markdown, kinds, this.settings, this.fetchImpl);
      this.lastSent = today;
      this.writeMarker(today);
      return true;
    } catch (err) {
      console.warn(`[agentarmy] Daily recap not sent: ${(err as Error).message}`);
      this.lastSent = today; // one attempt a day; a broken webhook should not post every 30 s
      return false;
    } finally {
      this.sending = false;
    }
  }

  private markerFile(): string | null {
    return this.log.dir ? path.join(this.log.dir, 'auto-sent.json') : null;
  }

  private readMarker(): string | null {
    const file = this.markerFile();
    if (!file) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { date?: unknown };
      return typeof data.date === 'string' ? data.date : null;
    } catch {
      return null;
    }
  }

  private writeMarker(date: string): void {
    const file = this.markerFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ date }));
    } catch {
      // worst case it sends again after a restart
    }
  }
}

// ---------- Routes ----------

export interface RecapRouteOptions {
  manager: ConsoleManager;
  settings: SettingsStore;
  dir: string | null;
}

export function registerRecapRoutes(app: FastifyInstance, options: RecapRouteOptions): RecapLog {
  const { manager, settings } = options;
  const log = new RecapLog(manager, options.dir);
  const scheduler = new RecapScheduler(log, settings);
  scheduler.start();
  app.addHook('onClose', async () => scheduler.stop());

  app.get('/api/recap', async (request, reply) => {
    const { date } = request.query as { date?: string };
    const day = date ?? localDate(Date.now());
    if (!isRecapDate(day)) return reply.code(400).send({ error: 'date must look like YYYY-MM-DD' });
    const { recap, markdown } = await log.recap(day);
    const response: RecapResponse = { recap, markdown, canSend: configuredKinds(settings) };
    return response;
  });

  app.post('/api/recap/send', async (request, reply) => {
    const body = (request.body ?? {}) as { date?: unknown; kind?: unknown };
    const day = body.date === undefined ? localDate(Date.now()) : body.date;
    if (!isRecapDate(day)) return reply.code(400).send({ error: 'date must look like YYYY-MM-DD' });
    if (body.kind !== undefined && body.kind !== 'slack' && body.kind !== 'discord') {
      return reply.code(400).send({ error: 'kind must be "slack" or "discord"' });
    }
    const kinds = configuredKinds(settings).filter((k) => body.kind === undefined || k === body.kind);
    if (!kinds.length) return reply.code(400).send({ error: 'No Slack or Discord webhook is set (Settings > Notifications)' });
    try {
      await sendRecap((await log.recap(day)).markdown, kinds, settings);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    return { sent: kinds };
  });

  return log;
}
