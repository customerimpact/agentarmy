import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type {
  ActionItem,
  BoardState,
  BrowserTile,
  ConsoleInfo,
  ConsoleLayout,
  ConsoleStatus,
  CreateConsoleRequest,
  Job,
  Project,
  UpdateConsoleRequest,
} from '../shared/protocol.js';
import { STATE_VERSION } from '../shared/protocol.js';
import { buildSpawnCommand, resolveClaudeExecutable } from './claude-path.js';
import { removeSettingsFile, writeSettingsFile } from './hook-settings.js';
import { statusFromHook, type HookPayload } from './hook-status.js';
import { pickConsoleName } from './console-names.js';
import { findFreeSlot, DEFAULT_SIZE } from './placement.js';
import { isDismissInput, PromptDetector } from './prompt-detector.js';
import { Scrollback } from './scrollback.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const OUTPUT_BATCH_MS = 8;
const PROMPT_DEBOUNCE_MS = 400;
const PROMPT_CHECK_STATUSES = new Set<ConsoleStatus>(['starting', 'idle', 'resting']);
// claude.exe takes ~3-4s to start on Windows before it reports a missing conversation
const RESUME_FAILURE_WINDOW_MS = 10_000;

// Variables that tie a process to the Claude Code session that launched agentarmy;
// inheriting them would make every console think it is a nested child session.
const PARENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
];

type OutputListener = (data: string) => void;

interface LiveConsole {
  info: ConsoleInfo;
  pty: pty.IPty | null;
  scrollback: Scrollback;
  listeners: Set<OutputListener>;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  cols: number;
  rows: number;
  detector: PromptDetector;
  promptTimer: NodeJS.Timeout | null;
  promptPrevStatus: ConsoleStatus | null; // set while needs_you comes from the screen, not a hook
}

export interface ConsoleManagerOptions {
  port: number;
  token: string;
  dev?: boolean;
  onChange: () => void; // persist trigger
}

export interface ConsoleManagerEvents {
  console: [ConsoleInfo];
  removed: [string];
  hook: [string, HookPayload]; // raw hook payloads, after status handling (jobs, todos, actions listen)
  job: [Job];
  'job-removed': [string];
  action: [ActionItem];
  'actions-removed': [string[]];
  project: [Project];
  'project-removed': [string];
  browser: [BrowserTile];
  'browser-removed': [string];
}

export class ConsoleManager extends EventEmitter<ConsoleManagerEvents> {
  private consoles = new Map<string, LiveConsole>();
  private viewport: BoardState['viewport'];
  // Owned by the feature modules (jobs.ts, actions.ts, projects.ts, browsers/); persisted with the board.
  // Mutate in place, then call emit(<event>, item) and persist().
  readonly jobs: Job[] = [];
  readonly actions: ActionItem[] = [];
  readonly projects: Project[] = [];
  readonly browsers: BrowserTile[] = [];
  private shuttingDown = false;
  private claudePath: string | null = null;

  constructor(private readonly options: ConsoleManagerOptions) {
    super();
  }

  getState(): BoardState {
    return {
      version: STATE_VERSION,
      consoles: [...this.consoles.values()].map((c) => c.info),
      jobs: this.jobs,
      actions: this.actions,
      projects: this.projects,
      browsers: this.browsers,
      ...(this.viewport ? { viewport: this.viewport } : {}),
    };
  }

  get(id: string): ConsoleInfo | undefined {
    return this.consoles.get(id)?.info;
  }

  list(): ConsoleInfo[] {
    return [...this.consoles.values()].map((c) => c.info);
  }

  persist(): void {
    this.options.onChange();
  }

  // Broadcast + persist after a feature module changed a console's fields (todos, model, projectId...)
  touch(id: string): void {
    const live = this.consoles.get(id);
    if (live) this.changed(live);
  }

  // Types text into the console like a paste, then presses Enter
  sendText(id: string, text: string): boolean {
    const live = this.consoles.get(id);
    if (!live?.pty) return false;
    const proc = live.pty;
    // Bracketed paste keeps multi-line text in one prompt instead of submitting at each newline
    proc.write(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
    setTimeout(() => {
      if (live.pty === proc) proc.write('\r');
    }, 60);
    return true;
  }

  // Stops the process but keeps the console and its conversation (resume with restart())
  suspend(id: string): ConsoleInfo {
    const live = this.require(id);
    this.killPty(live);
    live.scrollback.clear();
    live.promptPrevStatus = null;
    live.info.status = 'suspended';
    live.info.statusDetail = undefined;
    live.info.statusChangedAt = Date.now();
    this.changed(live);
    return live.info;
  }

  setViewport(viewport: NonNullable<BoardState['viewport']>): void {
    this.viewport = viewport;
    this.options.onChange();
  }

  // With resumeAll false, live consoles come back 'suspended' so the user decides when to spend tokens
  restore(state: BoardState, options: { resumeAll: boolean }): void {
    this.viewport = state.viewport;
    this.jobs.push(...state.jobs);
    this.actions.push(...state.actions);
    this.projects.push(...state.projects);
    this.browsers.push(...state.browsers);
    const closedProjects = new Set(state.projects.filter((p) => !p.open).map((p) => p.id));
    for (const info of state.consoles) {
      const live = this.register({ ...info });
      if (info.status === 'exited') continue;
      // Consoles of a closed project stay stopped until the project is opened again
      if (info.projectId && closedProjects.has(info.projectId)) {
        live.info.status = 'suspended';
        continue;
      }
      if (options.resumeAll) {
        this.launch(live, 'resume');
        continue;
      }
      live.info.status = 'suspended';
      live.info.statusDetail = undefined;
      live.info.statusChangedAt = Date.now();
    }
    this.options.onChange();
  }

  resumeAll(): number {
    let resumed = 0;
    for (const live of this.consoles.values()) {
      if (live.info.status !== 'suspended') continue;
      this.launch(live, 'resume');
      resumed++;
    }
    return resumed;
  }

  create(req: CreateConsoleRequest): ConsoleInfo {
    const cwd = path.resolve(req.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Not a directory: ${cwd}`);
    }
    const now = Date.now();
    const info: ConsoleInfo = {
      id: crypto.randomUUID(),
      name:
        req.name?.trim() || pickConsoleName([...this.consoles.values()].map((c) => c.info.name)),
      cwd,
      sessionId: crypto.randomUUID(),
      status: 'starting',
      statusChangedAt: now,
      layout: this.initialLayout(req.layout),
      createdAt: now,
    };
    const live = this.register(info);
    this.launch(live, 'new');
    return info;
  }

  update(id: string, req: UpdateConsoleRequest): ConsoleInfo {
    const live = this.require(id);
    if (req.name !== undefined && req.name.trim()) live.info.name = req.name.trim();
    if (req.layout) live.info.layout = { ...live.info.layout, ...req.layout };
    this.changed(live);
    return live.info;
  }

  restart(id: string): ConsoleInfo {
    const live = this.require(id);
    this.killPty(live);
    live.scrollback.clear();
    this.launch(live, 'resume');
    return live.info;
  }

  remove(id: string): void {
    const live = this.require(id);
    this.killPty(live);
    if (live.flushTimer) clearTimeout(live.flushTimer);
    if (live.promptTimer) clearTimeout(live.promptTimer);
    live.listeners.clear();
    this.consoles.delete(id);
    removeSettingsFile(id);
    this.emit('removed', id);
    this.options.onChange();
  }

  // Returns the scrollback so the caller can send it before any streamed output
  attach(id: string, listener: OutputListener): string {
    const live = this.require(id);
    this.flushOutput(live);
    live.listeners.add(listener);
    return live.scrollback.read();
  }

  detach(id: string, listener: OutputListener): void {
    this.consoles.get(id)?.listeners.delete(listener);
  }

  input(id: string, data: string): void {
    const live = this.consoles.get(id);
    if (!live?.pty) return;
    live.pty.write(data);
    if (isDismissInput(data)) {
      // The dialog is answered; only a fresh redraw of it should count from now on
      live.detector.reset();
      if (live.promptPrevStatus) this.schedulePromptCheck(live);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.consoles.get(id);
    if (!live) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 2 || cols > 1000 || rows < 2 || rows > 500) return;
    live.cols = cols;
    live.rows = rows;
    try {
      live.pty?.resize(cols, rows);
    } catch {
      // the PTY may have exited between the check and the call
    }
  }

  handleHook(id: string, payload: HookPayload): void {
    this.applyHookStatus(id, payload);
    if (this.consoles.has(id)) this.emit('hook', id, payload);
  }

  private applyHookStatus(id: string, payload: HookPayload): void {
    const live = this.consoles.get(id);
    if (!live || live.info.status === 'exited' || live.info.status === 'suspended') return;
    if (this.options.dev) console.log(`[hook ${id.slice(0, 8)}]`, JSON.stringify(payload));
    // A hook means Claude moved on, so it replaces any status we guessed from the screen
    const guessedFrom = live.promptPrevStatus;
    if (guessedFrom) {
      live.promptPrevStatus = null;
      live.info.statusDetail = undefined;
    }
    const update = statusFromHook(payload) ?? (guessedFrom ? { status: guessedFrom } : null);
    if (!update) return;
    if (update.status === 'working') live.detector.reset();
    else if (update.status && PROMPT_CHECK_STATUSES.has(update.status))
      this.schedulePromptCheck(live);
    let dirty = guessedFrom !== null;
    if (update.sessionId && update.sessionId !== live.info.sessionId) {
      live.info.sessionId = update.sessionId;
      dirty = true;
    }
    if (update.status && update.status !== live.info.status) {
      live.info.status = update.status;
      live.info.statusChangedAt = Date.now();
      dirty = true;
    }
    if (update.status) {
      // A note from a failed resume should survive SessionStart and clear on the first real turn
      const keep = update.status === 'idle' ? live.info.statusDetail : undefined;
      const detail = update.statusDetail ?? keep;
      if (detail !== live.info.statusDetail) {
        live.info.statusDetail = detail;
        dirty = true;
      }
    }
    if (dirty) this.changed(live);
  }

  private schedulePromptCheck(live: LiveConsole): void {
    if (live.promptTimer) clearTimeout(live.promptTimer);
    live.promptTimer = setTimeout(() => {
      live.promptTimer = null;
      this.checkPrompt(live);
    }, PROMPT_DEBOUNCE_MS);
  }

  private checkPrompt(live: LiveConsole): void {
    if (!this.consoles.has(live.info.id) || !live.pty) return;
    const detail = live.detector.detect();
    const { info } = live;
    if (live.promptPrevStatus) {
      if (detail) return;
      info.status = live.promptPrevStatus;
      info.statusDetail = undefined;
      live.promptPrevStatus = null;
    } else {
      // While 'working', dialogs are permission prompts that the Notification hook already reports
      if (!detail || !PROMPT_CHECK_STATUSES.has(info.status)) return;
      live.promptPrevStatus = info.status;
      info.status = 'needs_you';
      info.statusDetail = detail;
    }
    info.statusChangedAt = Date.now();
    this.changed(live);
  }

  // Flags first so the exits we cause are not persisted as 'exited'
  shutdown(): void {
    this.shuttingDown = true;
    for (const live of this.consoles.values()) {
      if (live.flushTimer) clearTimeout(live.flushTimer);
      if (live.promptTimer) clearTimeout(live.promptTimer);
      this.killPty(live);
    }
  }

  private initialLayout(requested: Partial<ConsoleLayout> = {}): ConsoleLayout {
    const size = {
      width: requested.width ?? DEFAULT_SIZE.width,
      height: requested.height ?? DEFAULT_SIZE.height,
    };
    if (requested.x !== undefined && requested.y !== undefined) {
      return { x: requested.x, y: requested.y, ...size };
    }
    return findFreeSlot(
      [...this.consoles.values()].map((c) => c.info.layout),
      size,
    );
  }

  private register(info: ConsoleInfo): LiveConsole {
    const live: LiveConsole = {
      info,
      pty: null,
      scrollback: new Scrollback(),
      listeners: new Set(),
      pending: '',
      flushTimer: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      detector: new PromptDetector(),
      promptTimer: null,
      promptPrevStatus: null,
    };
    this.consoles.set(info.id, live);
    return live;
  }

  private require(id: string): LiveConsole {
    const live = this.consoles.get(id);
    if (!live) throw new NotFoundError(`Unknown console ${id}`);
    return live;
  }

  private changed(live: LiveConsole): void {
    this.emit('console', live.info);
    this.options.onChange();
  }

  private launch(live: LiveConsole, mode: 'new' | 'resume', detail?: string): void {
    const { info } = live;
    info.status = 'starting';
    info.statusDetail = detail;
    info.statusChangedAt = Date.now();
    delete info.exitCode;
    live.detector.reset();
    live.promptPrevStatus = null;

    let proc: pty.IPty;
    try {
      this.claudePath ??= resolveClaudeExecutable();
      if (!fs.existsSync(info.cwd)) throw new Error(`Folder no longer exists: ${info.cwd}`);
      const settingsFile = writeSettingsFile(info.id, this.options.port, this.options.token);
      const sessionFlag = mode === 'new' ? '--session-id' : '--resume';
      const command = buildSpawnCommand(this.claudePath, [
        sessionFlag,
        info.sessionId,
        '--settings',
        settingsFile,
      ]);
      proc = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: live.cols,
        rows: live.rows,
        cwd: info.cwd,
        env: this.childEnv(),
      });
    } catch (err) {
      info.status = 'exited';
      info.statusDetail = err instanceof Error ? err.message : String(err);
      this.changed(live);
      return;
    }

    live.pty = proc;
    const startedAt = Date.now();
    this.changed(live);

    proc.onData((data) => {
      if (live.pty !== proc) return;
      live.scrollback.append(data);
      live.detector.feed(data);
      this.schedulePromptCheck(live);
      if (live.listeners.size === 0) return;
      live.pending += data;
      live.flushTimer ??= setTimeout(() => this.flushOutput(live), OUTPUT_BATCH_MS);
    });

    proc.onExit(({ exitCode }) => {
      // Ignore exits of PTYs we replaced or killed on purpose
      if (live.pty !== proc || this.shuttingDown) return;
      live.pty = null;
      this.flushOutput(live);
      const quickFailure = Date.now() - startedAt < RESUME_FAILURE_WINDOW_MS && exitCode !== 0;
      if (mode === 'resume' && quickFailure && this.consoles.has(info.id)) {
        info.sessionId = crypto.randomUUID();
        this.launch(live, 'new', 'Could not resume the previous conversation; started a new one');
        return;
      }
      info.status = 'exited';
      info.exitCode = exitCode;
      info.statusChangedAt = Date.now();
      this.changed(live);
    });
  }

  private flushOutput(live: LiveConsole): void {
    if (live.flushTimer) {
      clearTimeout(live.flushTimer);
      live.flushTimer = null;
    }
    if (!live.pending) return;
    const data = live.pending;
    live.pending = '';
    for (const listener of live.listeners) listener(data);
  }

  private killPty(live: LiveConsole): void {
    const proc = live.pty;
    live.pty = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !PARENT_SESSION_ENV.includes(key.toUpperCase())) env[key] = value;
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    return env;
  }
}

export class NotFoundError extends Error {}
