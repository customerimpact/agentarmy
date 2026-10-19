import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ConsoleInfo,
  ConsoleStatus,
  Loop,
  LoopGoal,
  LoopInput,
  LoopRunEntry,
  LoopStop,
  LoopTarget,
  LoopTrigger,
} from '../shared/protocol.js';
import {
  compileMatcher,
  LOOP_MAX_EVERY_MINUTES,
  LOOP_MAX_IDLE_SECONDS,
  LOOP_MIN_EVERY_MINUTES,
  LOOP_MIN_IDLE_SECONDS,
  loopPromptText,
  parseGoalVerdict,
  type OutputMatcher,
} from '../shared/loops.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import { BadRequestError } from './projects.js';

// Loops: re-send a prompt to some consoles on a schedule, when they go idle, or when their output
// matches, until a stop condition retires the loop. Loops live in manager.loops (persisted with the
// board); the per-console bookkeeping below is in memory only.

// Only these are typed into; 'working' is skipped (the run waits), needs_you never gets loop text
const READY = new Set<ConsoleStatus>(['idle', 'resting']);
const TICK_MS = 1000;
const MAX_HISTORY = 20;
const OUTPUT_TAIL = 4000;
const GOAL_WAIT_MS = 30 * 60_000; // run the goal command anyway if a target never ends its turn
export const GOAL_COMMAND_TIMEOUT_MS = 2 * 60_000;
const MAX_PROMPT = 8000;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Claude Code moves the cursor (ESC[1C) instead of printing spaces; turn those into spaces first
const CURSOR_FORWARD = /\x1b\[\d*C/g;

export function stripAnsi(data: string): string {
  return data.replace(CURSOR_FORWARD, ' ').replace(ANSI_PATTERN, '');
}

export interface CommandResult {
  code: number | null;
  output: string; // last bit of stdout + stderr
  timedOut: boolean;
}

export type CommandRunner = (command: string, cwd: string) => Promise<CommandResult>;

// The user's own goal command, run through the OS shell in the target folder
export const runShellCommand: CommandRunner = (command, cwd) =>
  new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, output: String(err), timedOut: false });
      return;
    }
    const keep = (d: Buffer): void => {
      output = (output + d.toString('utf8')).slice(-2000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GOAL_COMMAND_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, output, timedOut });
    });
  });

export interface LoopServiceOptions {
  now?: () => number;
  tickMs?: number; // 0 = no interval (tests call tick())
  runCommand?: CommandRunner;
  onRun?: (loop: Loop, consoles: ConsoleInfo[]) => void; // recap log
}

interface Runtime {
  matcher: OutputMatcher | null;
  output: Map<string, string>; // console -> ANSI-stripped output tail
  disarmed: Set<string>; // output trigger: wait for the end of the turn we started (its echo would match)
  pendingOutput: Set<string>; // matched while not ready; sent once it rests
  idleFired: Map<string, number>; // console -> statusChangedAt we already fired for
  awaiting: Map<string, number>; // console -> when we typed into it (turn not ended yet)
  checking: boolean; // goal command running
}

// ---------- Validation ----------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function intIn(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestError(`${what} must be a number`);
  const n = Math.round(value);
  if (n < min || n > max) throw new BadRequestError(`${what} must be between ${min} and ${max}`);
  return n;
}

export function parseTarget(raw: unknown): LoopTarget {
  if (!isObj(raw)) throw new BadRequestError('target is required');
  switch (raw.kind) {
    case 'all':
      return { kind: 'all' };
    case 'project':
      if (typeof raw.id !== 'string' || !raw.id) throw new BadRequestError('target.id is required');
      return { kind: 'project', id: raw.id };
    case 'consoles': {
      const ids = Array.isArray(raw.ids) ? [...new Set(raw.ids.filter((x): x is string => typeof x === 'string' && !!x))] : [];
      if (!ids.length) throw new BadRequestError('Pick at least one console');
      return { kind: 'consoles', ids };
    }
    default:
      throw new BadRequestError("target.kind must be 'consoles', 'project' or 'all'");
  }
}

export function parseTrigger(raw: unknown): LoopTrigger {
  if (!isObj(raw)) throw new BadRequestError('trigger is required');
  switch (raw.kind) {
    case 'schedule':
      return { kind: 'schedule', everyMinutes: intIn(raw.everyMinutes, LOOP_MIN_EVERY_MINUTES, LOOP_MAX_EVERY_MINUTES, 'everyMinutes') };
    case 'idle':
      return { kind: 'idle', afterSeconds: intIn(raw.afterSeconds, LOOP_MIN_IDLE_SECONDS, LOOP_MAX_IDLE_SECONDS, 'afterSeconds') };
    case 'output': {
      const match = typeof raw.match === 'string' ? raw.match.trim() : '';
      if (!match) throw new BadRequestError('Type the text to watch for');
      if (match.length > 300) throw new BadRequestError('The output match is too long (300 characters max)');
      try {
        compileMatcher(match);
      } catch (err) {
        throw new BadRequestError(`Invalid regular expression: ${(err as Error).message}`);
      }
      return { kind: 'output', match };
    }
    default:
      throw new BadRequestError("trigger.kind must be 'schedule', 'idle' or 'output'");
  }
}

function parseGoal(raw: unknown): LoopGoal | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) throw new BadRequestError('stop.whenGoal must be an object');
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 200) : undefined;
  if (raw.kind === 'agent') return { kind: 'agent', ...(description ? { description } : {}) };
  if (raw.kind === 'command') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) throw new BadRequestError('Type the goal command');
    if (command.length > 1000) throw new BadRequestError('The goal command is too long');
    const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : undefined;
    if (cwd && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) throw new BadRequestError(`Not a folder: ${cwd}`);
    return { kind: 'command', command, ...(cwd ? { cwd } : {}), ...(description ? { description } : {}) };
  }
  throw new BadRequestError("stop.whenGoal.kind must be 'command' or 'agent'");
}

export function parseStop(raw: unknown): LoopStop {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) throw new BadRequestError('stop must be an object');
  const stop: LoopStop = {};
  if (raw.afterRuns !== undefined && raw.afterRuns !== null) stop.afterRuns = intIn(raw.afterRuns, 1, 10_000, 'afterRuns');
  if (raw.afterMinutes !== undefined && raw.afterMinutes !== null) stop.afterMinutes = intIn(raw.afterMinutes, 1, 100_000, 'afterMinutes');
  const goal = parseGoal(raw.whenGoal);
  if (goal) stop.whenGoal = goal;
  return stop;
}

function commandOf(stop: LoopStop | undefined): string | null {
  return stop?.whenGoal?.kind === 'command' ? stop.whenGoal.command : null;
}

// ---------- Service ----------

export class LoopService {
  private runtime = new Map<string, Runtime>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly runCommand: CommandRunner;

  constructor(
    private readonly manager: ConsoleManager,
    private readonly options: LoopServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? runShellCommand;
    manager.on('output', (id, data) => this.onOutput(id, data));
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('removed', (id) => this.onRemoved(id));
  }

  get loops(): Loop[] {
    return this.manager.loops;
  }

  start(): void {
    const ms = this.options.tickMs ?? TICK_MS;
    if (!ms || this.timer) return;
    this.timer = setInterval(() => this.tick(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(id: string): Loop {
    const loop = this.loops.find((l) => l.id === id);
    if (!loop) throw new NotFoundError(`Unknown loop ${id}`);
    return loop;
  }

  create(raw: unknown): Loop {
    if (!isObj(raw)) throw new BadRequestError('Expected a JSON object');
    const input = raw as Partial<LoopInput>;
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new BadRequestError('Type the prompt the loop sends');
    if (prompt.length > MAX_PROMPT) throw new BadRequestError('The prompt is too long');
    const target = parseTarget(input.target);
    this.checkTarget(target);
    const trigger = parseTrigger(input.trigger);
    const stop = parseStop(input.stop);
    if (commandOf(stop) && input.confirmCommand !== true) {
      throw new BadRequestError('Confirm the goal command first (it runs on this computer)');
    }
    const now = this.now();
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : prompt.replace(/\s+/g, ' ').slice(0, 40);
    const loop: Loop = {
      id: crypto.randomUUID(),
      name,
      prompt,
      target,
      trigger,
      stop,
      enabled: input.enabled !== false,
      runs: 0,
      lastRunAt: null,
      createdAt: now,
      startedAt: now,
      history: [],
    };
    this.loops.push(loop);
    this.changed(loop);
    return loop;
  }

  update(id: string, raw: unknown): Loop {
    const loop = this.get(id);
    if (!isObj(raw)) throw new BadRequestError('Expected a JSON object');
    const input = raw as Partial<LoopInput>;
    if (input.prompt !== undefined) {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) throw new BadRequestError('Type the prompt the loop sends');
      if (prompt.length > MAX_PROMPT) throw new BadRequestError('The prompt is too long');
      loop.prompt = prompt;
    }
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) throw new BadRequestError('name cannot be empty');
      loop.name = input.name.trim().slice(0, 80);
    }
    if (input.target !== undefined) {
      const target = parseTarget(input.target);
      this.checkTarget(target);
      loop.target = target;
    }
    if (input.trigger !== undefined) {
      loop.trigger = parseTrigger(input.trigger);
      this.runtime.delete(loop.id);
    }
    if (input.stop !== undefined) {
      const stop = parseStop(input.stop);
      const command = commandOf(stop);
      if (command && command !== commandOf(loop.stop) && input.confirmCommand !== true) {
        throw new BadRequestError('Confirm the goal command first (it runs on this computer)');
      }
      loop.stop = stop;
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean');
      if (input.enabled && !loop.enabled) {
        // Re-enabling starts the stop clock again; a retired loop also starts counting runs again
        loop.startedAt = this.now();
        if (loop.retiredAt) {
          loop.runs = 0;
          delete loop.retiredAt;
          delete loop.retiredReason;
        }
        this.runtime.delete(loop.id);
      }
      loop.enabled = input.enabled;
    }
    this.changed(loop);
    return loop;
  }

  remove(id: string): void {
    const index = this.loops.findIndex((l) => l.id === id);
    if (index < 0) throw new NotFoundError(`Unknown loop ${id}`);
    this.loops.splice(index, 1);
    this.runtime.delete(id);
    this.manager.emit('loop-removed', id);
    this.manager.persist();
  }

  // Run now: types into the ready targets whatever the trigger says
  runNow(id: string): Loop {
    const loop = this.get(id);
    this.run(loop, this.targets(loop), true);
    return loop;
  }

  targets(loop: Pick<Loop, 'target'>): ConsoleInfo[] {
    const t = loop.target;
    if (t.kind === 'all') return this.manager.list();
    if (t.kind === 'project') {
      const project = this.manager.projects.find((p) => p.id === t.id);
      return (project?.consoleIds ?? []).map((id) => this.manager.get(id)).filter((c): c is ConsoleInfo => !!c);
    }
    return t.ids.map((id) => this.manager.get(id)).filter((c): c is ConsoleInfo => !!c);
  }

  // Called every second: stop clocks, schedules, idle timers, queued output matches, goal timeouts
  tick(): void {
    const now = this.now();
    for (const loop of [...this.loops]) {
      if (!loop.enabled) continue;
      if (loop.stop.afterMinutes && now - loop.startedAt >= loop.stop.afterMinutes * 60_000) {
        this.retire(loop, `after ${loop.stop.afterMinutes} min`);
        continue;
      }
      const rt = this.rt(loop);
      this.checkGoalTimeout(loop, rt, now);
      const targets = this.targets(loop);
      switch (loop.trigger.kind) {
        case 'schedule': {
          const due = (loop.lastRunAt ?? loop.startedAt) + loop.trigger.everyMinutes * 60_000;
          // A due run waits until at least one target is ready instead of logging empty runs
          if (now >= due && targets.some((c) => this.isReady(c))) this.run(loop, targets);
          break;
        }
        case 'idle': {
          const ms = loop.trigger.afterSeconds * 1000;
          const due = targets.filter(
            // Consoles already idle when the loop started count from the start, not from long ago
            (c) =>
              this.isReady(c) &&
              now - Math.max(c.statusChangedAt, loop.startedAt) >= ms &&
              rt.idleFired.get(c.id) !== c.statusChangedAt,
          );
          if (!due.length) break;
          for (const c of due) rt.idleFired.set(c.id, c.statusChangedAt);
          this.run(loop, due);
          break;
        }
        case 'output': {
          const ready = targets.filter((c) => rt.pendingOutput.has(c.id) && this.isReady(c));
          if (!ready.length) break;
          for (const c of ready) rt.pendingOutput.delete(c.id);
          this.run(loop, ready);
          break;
        }
      }
    }
  }

  private isReady(c: ConsoleInfo): boolean {
    return READY.has(c.status) && !c.paused;
  }

  private rt(loop: Loop): Runtime {
    let rt = this.runtime.get(loop.id);
    if (!rt) {
      let matcher: OutputMatcher | null = null;
      if (loop.trigger.kind === 'output') {
        try {
          matcher = compileMatcher(loop.trigger.match);
        } catch {
          matcher = null;
        }
      }
      rt = {
        matcher,
        output: new Map(),
        disarmed: new Set(),
        pendingOutput: new Set(),
        idleFired: new Map(),
        awaiting: new Map(),
        checking: false,
      };
      this.runtime.set(loop.id, rt);
    }
    return rt;
  }

  private run(loop: Loop, consoles: ConsoleInfo[], manual = false): void {
    const now = this.now();
    const rt = this.rt(loop);
    const text = loopPromptText(loop);
    const sent: ConsoleInfo[] = [];
    const skipped: string[] = [];
    for (const c of consoles) {
      if (this.isReady(c) && this.manager.sendText(c.id, text)) {
        sent.push(c);
        rt.awaiting.set(c.id, now);
        rt.disarmed.add(c.id);
        rt.output.delete(c.id);
      } else {
        skipped.push(`${c.name} (${c.paused ? 'paused' : c.status.replace('_', ' ')})`);
      }
    }
    if (!sent.length && !manual) return;
    const entry: LoopRunEntry = {
      at: now,
      sentTo: sent.map((c) => c.name),
      skipped,
      ...(sent.length ? {} : { note: consoles.length ? 'No target was ready' : 'No target console' }),
    };
    if (sent.length) {
      loop.runs++;
      loop.lastRunAt = now;
    }
    this.log(loop, entry);
    if (sent.length) this.options.onRun?.(loop, sent);
    if (sent.length && loop.stop.afterRuns && loop.runs >= loop.stop.afterRuns && loop.enabled) {
      this.retire(loop, `after ${loop.runs} ${loop.runs === 1 ? 'run' : 'runs'}`);
      return;
    }
    this.changed(loop);
  }

  private onOutput(id: string, data: string): void {
    for (const loop of this.loops) {
      if (!loop.enabled || loop.trigger.kind !== 'output') continue;
      if (!this.targets(loop).some((c) => c.id === id)) continue;
      const rt = this.rt(loop);
      if (!rt.matcher || rt.disarmed.has(id) || rt.pendingOutput.has(id)) continue;
      const tail = ((rt.output.get(id) ?? '') + stripAnsi(data)).slice(-OUTPUT_TAIL);
      if (rt.matcher(tail)) {
        rt.output.delete(id);
        rt.pendingOutput.add(id);
      } else {
        rt.output.set(id, tail);
      }
    }
  }

  private onHook(id: string, payload: HookPayload): void {
    const event = payload.hook_event_name;
    if (event !== 'Stop' && event !== 'StopFailure' && event !== 'SessionEnd') return;
    for (const loop of [...this.loops]) {
      const rt = this.runtime.get(loop.id);
      if (!rt) continue;
      // The turn we started is over: watch the output again, from a clean slate
      if (rt.disarmed.delete(id)) rt.output.delete(id);
      if (!rt.awaiting.has(id)) continue;
      rt.awaiting.delete(id);
      const goal = loop.stop.whenGoal;
      if (!goal || !loop.enabled) continue;
      if (goal.kind === 'agent' && event === 'Stop') {
        const verdict = parseGoalVerdict(typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '');
        const name = this.manager.get(id)?.name ?? 'The agent';
        if (verdict === null) continue;
        loop.lastGoal = { at: this.now(), met: verdict, detail: `${name} said ${verdict ? 'GOAL MET' : 'GOAL NOT MET'}` };
        if (verdict) this.retire(loop, 'goal met');
        else this.changed(loop);
      } else if (goal.kind === 'command' && rt.awaiting.size === 0) {
        void this.checkCommand(loop, goal);
      }
    }
  }

  private checkGoalTimeout(loop: Loop, rt: Runtime, now: number): void {
    if (!rt.awaiting.size) return;
    const oldest = Math.min(...rt.awaiting.values());
    if (now - oldest < GOAL_WAIT_MS) return;
    rt.awaiting.clear();
    const goal = loop.stop.whenGoal;
    if (goal?.kind === 'command') void this.checkCommand(loop, goal);
  }

  // Runs the goal command once the targets' turns ended; exit 0 retires the loop
  async checkCommand(loop: Loop, goal: Extract<LoopGoal, { kind: 'command' }>): Promise<void> {
    const rt = this.rt(loop);
    if (rt.checking) return;
    rt.checking = true;
    try {
      const cwd = goal.cwd ?? this.targets(loop)[0]?.cwd ?? process.cwd();
      const result = await this.runCommand(goal.command, cwd);
      if (!this.loops.includes(loop)) return;
      const met = result.code === 0;
      const detail = result.timedOut
        ? 'timed out after 2 min'
        : result.code === null
          ? `could not run: ${result.output.trim().slice(-200)}`
          : `exit code ${result.code}`;
      loop.lastGoal = { at: this.now(), met, detail: `\`${goal.command}\` ${detail}` };
      if (met && loop.enabled) this.retire(loop, 'goal met');
      else this.changed(loop);
    } finally {
      rt.checking = false;
    }
  }

  private onRemoved(id: string): void {
    for (const rt of this.runtime.values()) {
      rt.output.delete(id);
      rt.disarmed.delete(id);
      rt.pendingOutput.delete(id);
      rt.idleFired.delete(id);
      rt.awaiting.delete(id);
    }
  }

  private retire(loop: Loop, reason: string): void {
    loop.enabled = false;
    loop.retiredAt = this.now();
    loop.retiredReason = reason;
    this.runtime.delete(loop.id);
    this.log(loop, { at: loop.retiredAt, sentTo: [], skipped: [], note: `Retired: ${reason}` });
    this.changed(loop);
  }

  private log(loop: Loop, entry: LoopRunEntry): void {
    const history = loop.history ?? (loop.history = []);
    history.push(entry);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  }

  private checkTarget(target: LoopTarget): void {
    if (target.kind === 'project' && !this.manager.projects.some((p) => p.id === target.id)) {
      throw new BadRequestError(`Unknown project ${target.id}`);
    }
    if (target.kind === 'consoles') {
      const unknown = target.ids.find((id) => !this.manager.get(id));
      if (unknown) throw new BadRequestError(`Unknown console ${unknown}`);
    }
  }

  private changed(loop: Loop): void {
    if (!this.loops.includes(loop)) return;
    this.manager.emit('loop', loop);
    this.manager.persist();
  }
}

// ---------- Routes ----------

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

export function registerLoopRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager } & LoopServiceOptions,
): LoopService {
  const { manager, ...rest } = options;
  const loops = new LoopService(manager, rest);
  loops.start();
  app.addHook('onClose', async () => loops.stop());

  app.get('/api/loops', async () => loops.loops);

  app.post('/api/loops', async (request, reply) => {
    try {
      return loops.create(request.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/loops/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return loops.update(id, request.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/loops/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      loops.remove(id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/loops/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return loops.runNow(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return loops;
}
