import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type {
  ActionItem,
  AppSettings,
  BoardItem,
  BoardState,
  BrowserTile,
  ConsoleInfo,
  ConsoleLayout,
  ConsoleStatus,
  CreateConsoleRequest,
  Job,
  Loop,
  Project,
  UpdateConsoleRequest,
  Workspace,
} from '../shared/protocol.js';
import { DEFAULT_WORKSPACE_ID, STATE_VERSION } from '../shared/protocol.js';
import type { Shape } from '../shared/drawings.js';
import { adapterFor, outputTrackerFor } from './agents/index.js';
import type { OutputStatusTracker } from './agents/output-status.js';
import { validateCommand } from './agents/custom.js';
import { isAgentKind } from '../shared/agents.js';
import { removeSettingsFile } from './hook-settings.js';
import { statusFromHook, type HookPayload } from './hook-status.js';
import { pickConsoleName } from './console-names.js';
import { findFreeSlot, DEFAULT_SIZE } from './placement.js';
import { isDismissInput, PromptDetector, type ParsedDialog } from './prompt-detector.js';
import { Scrollback } from './scrollback.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const OUTPUT_BATCH_MS = 8;
const PROMPT_DEBOUNCE_MS = 400;
const HEURISTIC_TICK_MS = 500;
const PROMPT_CHECK_STATUSES = new Set<ConsoleStatus>(['starting', 'idle', 'resting']);
// Submitting typed text: Claude Code treats input that arrives right after a paste as part of the
// paste, so Enter is only pressed once the PTY output has gone quiet (the paste was rendered).
export interface SendTiming {
  quietMs: number; // no output for this long = the paste was handled
  minWaitMs: number;
  maxWaitMs: number; // upper bound for long pastes (scaled by length below it)
  pollMs: number;
  verifyMs: number; // no UserPromptSubmit by then (and not working) = press Enter once more
}
export const DEFAULT_SEND_TIMING: SendTiming = {
  quietMs: 150,
  minWaitMs: 250,
  maxWaitMs: 1500,
  pollMs: 25,
  verifyMs: 2500,
};
// claude.exe takes ~3-4s to start on Windows before it reports a missing conversation
const RESUME_FAILURE_WINDOW_MS = 10_000;
const STARTING_FALLBACK_MS = 15_000;
const STARTING_GIVE_UP_MS = 120_000;

// Variables that tie a process to the Claude Code session that launched GridHive;
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

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const MODEL_SWITCH_PATTERN = /Set\s*model\s*to/i;

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
  lastOutputAt: number;
  sendQueue: Promise<void>; // sendText calls to one console run one after another
  submitCheck: NodeJS.Timeout | null; // pending "did Enter submit?" check
  outputTail: string; // last bit of plain-text output, to spot "Set model to ..."
  heuristic: OutputStatusTracker | null; // CLIs without hooks: status from PTY output (agents/output-status.ts)
}

export interface ConsoleManagerOptions {
  port: number;
  token: string;
  dev?: boolean;
  onChange: () => void; // persist trigger
  settings?: () => AppSettings; // read at every launch, so changes apply to new/restarted consoles
  sendTiming?: Partial<SendTiming>;
}

export interface ConsoleManagerEvents {
  console: [ConsoleInfo];
  removed: [string];
  hook: [string, HookPayload]; // raw hook payloads, after status handling (jobs, todos, actions listen)
  'model-switch': [string]; // the screen showed "Set model to ..." (a /model command ran)
  output: [string, string]; // raw PTY output (id, data); previews/ watches it for dev-server URLs
  dialog: [string]; // the numbered dialog on screen changed (see dialogFor)
  job: [Job];
  'job-removed': [string];
  action: [ActionItem];
  'actions-removed': [string[]];
  project: [Project];
  'project-removed': [string];
  browser: [BrowserTile];
  'browser-removed': [string];
  loop: [Loop];
  'loop-removed': [string];
  item: [BoardItem];
  'item-removed': [string];
  workspaces: []; // list, order, names or the active tab changed (see workspaces.ts)
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
  readonly items: BoardItem[] = []; // board-items.ts
  readonly drawings: Shape[] = []; // drawings.ts (annotation layer)
  readonly loops: Loop[] = []; // loops.ts
  readonly workspaces: Workspace[] = [{ id: DEFAULT_WORKSPACE_ID, name: 'Main', createdAt: 0, order: 0 }]; // workspaces.ts
  activeWorkspaceId = DEFAULT_WORKSPACE_ID;
  private shuttingDown = false;
  // Set by accounts (account-routes.ts): resolves accountId 'auto' and returns CLAUDE_CONFIG_DIR for the console
  accountEnv: ((info: ConsoleInfo, mode: 'new' | 'resume') => Record<string, string>) | null = null;

  constructor(private readonly options: ConsoleManagerOptions) {
    super();
    // Every feature module (jobs, actions, stuck alerts, webhooks, ...) listens to the same events
    this.setMaxListeners(50);
  }

  getState(): BoardState {
    return {
      version: STATE_VERSION,
      consoles: [...this.consoles.values()].map((c) => c.info),
      jobs: this.jobs,
      actions: this.actions,
      projects: this.projects,
      browsers: this.browsers,
      items: this.items,
      drawings: this.drawings,
      loops: this.loops,
      workspaces: this.workspaces,
      activeWorkspaceId: this.activeWorkspaceId,
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

  // Types text into the console like a paste, then presses Enter once Claude Code has taken the
  // paste in. Returns false when the console has no running process.
  sendText(id: string, text: string): boolean {
    const live = this.consoles.get(id);
    if (!live?.pty) return false;
    const proc = live.pty;
    live.sendQueue = live.sendQueue
      .then(() => this.typeAndSubmit(live, proc, text))
      .catch(() => undefined);
    return true;
  }

  private async typeAndSubmit(live: LiveConsole, proc: pty.IPty, text: string): Promise<void> {
    if (live.pty !== proc) return;
    const t = this.sendTiming;
    // Bracketed paste keeps multi-line text in one prompt instead of submitting at each newline
    proc.write(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
    const start = Date.now();
    live.lastOutputAt = start;
    // Long pastes take Claude Code longer to collapse into "[Pasted text #1 +N lines]"
    const maxWait = Math.min(t.maxWaitMs, Math.max(t.minWaitMs * 4, t.minWaitMs + text.length / 2));
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        const now = Date.now();
        const elapsed = now - start;
        const quiet = now - live.lastOutputAt >= t.quietMs;
        if (live.pty !== proc || elapsed >= maxWait || (elapsed >= t.minWaitMs && quiet)) resolve();
        else setTimeout(poll, t.pollMs);
      };
      setTimeout(poll, t.pollMs);
    });
    if (live.pty !== proc) return;
    proc.write('\r');
    live.heuristic?.noteInput('\r');
    // No UserPromptSubmit hook from other CLIs would cancel the check, so never press Enter twice there
    if (live.heuristic) return;
    // Slash commands (e.g. /model) do not fire UserPromptSubmit; a second Enter could pick a menu item
    if (text.trimStart().startsWith('/')) return;
    if (live.submitCheck) clearTimeout(live.submitCheck);
    live.submitCheck = setTimeout(() => {
      live.submitCheck = null;
      if (live.pty !== proc || live.info.status === 'working') return;
      proc.write('\r'); // the first Enter was swallowed; try exactly once more
    }, t.verifyMs);
    live.submitCheck.unref?.();
  }

  private get sendTiming(): SendTiming {
    return { ...DEFAULT_SEND_TIMING, ...this.options.sendTiming };
  }

  private clearSubmitCheck(live: LiveConsole): void {
    if (live.submitCheck) clearTimeout(live.submitCheck);
    live.submitCheck = null;
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
    this.items.push(...(state.items ?? []));
    this.drawings.push(...(state.drawings ?? []));
    this.loops.push(...(state.loops ?? []));
    if (state.workspaces?.length) this.workspaces.splice(0, this.workspaces.length, ...state.workspaces);
    const wsIds = new Set(this.workspaces.map((w) => w.id));
    const wsOf = (id: string | undefined): string => (id && wsIds.has(id) ? id : this.workspaces[0].id);
    for (const x of [...state.consoles, ...this.projects, ...this.browsers, ...this.items]) x.workspaceId = wsOf(x.workspaceId);
    for (const d of this.drawings) d.workspaceId = wsOf(d.workspaceId);
    this.activeWorkspaceId = wsOf(state.activeWorkspaceId);
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
    // Consoles of a closed project wait for POST /api/projects/:id/open instead
    const closedProjects = new Set(this.projects.filter((p) => !p.open).map((p) => p.id));
    for (const live of this.consoles.values()) {
      if (live.info.status !== 'suspended') continue;
      if (live.info.projectId && closedProjects.has(live.info.projectId)) continue;
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
    if (req.agent !== undefined && !isAgentKind(req.agent)) throw new Error(`Unknown agent: ${String(req.agent)}`);
    const agent = req.agent && req.agent !== 'claude' ? req.agent : undefined;
    const command = agent === 'custom' ? validateCommand(req.command) : undefined;
    const launchModel = typeof req.model === 'string' && req.model.trim() ? req.model.trim() : undefined;
    if (launchModel && !LAUNCH_MODEL_RE.test(launchModel)) throw new Error(`Not a model name: ${launchModel}`);
    const now = Date.now();
    const info: ConsoleInfo = {
      id: crypto.randomUUID(),
      name:
        req.name?.trim() || pickConsoleName([...this.consoles.values()].map((c) => c.info.name)),
      cwd,
      sessionId: crypto.randomUUID(),
      status: 'starting',
      statusChangedAt: now,
      layout: this.initialLayout(req.layout, this.workspaceFor(req.workspaceId)),
      createdAt: now,
      workspaceId: this.workspaceFor(req.workspaceId),
      // Claude Code always gets an account ('auto'); other CLIs only when one was asked for (account-routes.ts)
      ...(req.accountId || (!agent && this.accountEnv) ? { accountId: req.accountId || 'auto' } : {}),
      ...(agent ? { agent } : {}),
      ...(command ? { command } : {}),
      ...(launchModel && agent !== 'custom' ? { launchModel } : {}),
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
    this.clearSubmitCheck(live);
    live.listeners.clear();
    this.consoles.delete(id);
    this.lastDialog.delete(id);
    removeSettingsFile(id);
    adapterFor(live.info.agent).removeConsoleFiles?.(id);
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

  // Terminal size the board last set (a phone mirrors it instead of resizing the PTY)
  size(id: string): { cols: number; rows: number } | null {
    const live = this.consoles.get(id);
    return live ? { cols: live.cols, rows: live.rows } : null;
  }

  detach(id: string, listener: OutputListener): void {
    this.consoles.get(id)?.listeners.delete(listener);
  }

  // The numbered dialog currently on screen (permission prompt, trust dialog, question), if any
  dialogFor(id: string): ParsedDialog | null {
    return this.consoles.get(id)?.detector.dialog() ?? null;
  }

  private lastDialog = new Map<string, string>();

  private refreshDialog(live: LiveConsole): void {
    const json = JSON.stringify(live.detector.dialog());
    // While waiting, always re-announce: a resize repaint can leave an identical old dialog in the
    // tail, so "unchanged" does not mean the inbox item has it (the inbox ignores no-op updates)
    if (this.lastDialog.get(live.info.id) === json && live.info.status !== 'needs_you') return;
    this.lastDialog.set(live.info.id, json);
    this.emit('dialog', live.info.id);
  }

  // Answers a dialog from the Actions tab: presses the option's key, then types the text answer.
  // A digit usually picks the option at once; if the same list is redrawn instead, press Enter.
  answerPrompt(id: string, answer: { key?: string; text?: string }, delayMs = 400): boolean {
    const live = this.consoles.get(id);
    if (!live?.pty) return false;
    const proc = live.pty;
    if (answer.key) {
      proc.write(answer.key === 'esc' ? '\x1b' : answer.key);
      live.detector.reset();
      if (live.promptPrevStatus) this.schedulePromptCheck(live);
    }
    const text = answer.text;
    if (text) {
      if (!answer.key) return this.sendText(id, text);
      setTimeout(() => {
        if (live.pty === proc) this.sendText(id, text);
      }, delayMs).unref?.();
    } else if (answer.key && answer.key !== 'esc') {
      setTimeout(() => {
        if (live.pty !== proc) return;
        const still = live.detector.dialog();
        // Only while still waiting: a repaint can show the old dialog after it was answered
        if (live.info.status === 'needs_you' && still?.options.some((o) => o.key === answer.key)) proc.write('\r');
      }, delayMs * 2).unref?.();
    }
    return true;
  }

  input(id: string, data: string): void {
    const live = this.consoles.get(id);
    if (!live?.pty) return;
    live.pty.write(data);
    live.heuristic?.noteInput(data);
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
    const live = this.consoles.get(id);
    // The prompt went through, so no second Enter is needed
    if (live && payload.hook_event_name === 'UserPromptSubmit') this.clearSubmitCheck(live);
    // Other CLIs' relays (e.g. Codex notify) carry that CLI's own session id, used to resume it
    const agentSession = payload.agent_session_id;
    if (live && live.info.agent && typeof agentSession === 'string' && agentSession && agentSession !== live.info.agentSessionId) {
      live.info.agentSessionId = agentSession;
      this.changed(live);
    }
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
    this.refreshDialog(live);
    // Claude Code dialogs only; other CLIs get needs_you from their output tracker
    if (live.heuristic) return;
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
      this.clearSubmitCheck(live);
      this.killPty(live);
    }
  }

  // A known workspace id, or the active one
  workspaceFor(requested: string | undefined): string {
    return requested && this.workspaces.some((w) => w.id === requested) ? requested : this.activeWorkspaceId;
  }

  private initialLayout(requested: Partial<ConsoleLayout> = {}, workspaceId?: string): ConsoleLayout {
    const size = {
      width: requested.width ?? DEFAULT_SIZE.width,
      height: requested.height ?? DEFAULT_SIZE.height,
    };
    if (requested.x !== undefined && requested.y !== undefined) {
      return { x: requested.x, y: requested.y, ...size };
    }
    return findFreeSlot(
      [...this.consoles.values()]
        .filter((c) => !workspaceId || (c.info.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId)
        .map((c) => c.info.layout),
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
      lastOutputAt: 0,
      sendQueue: Promise.resolve(),
      submitCheck: null,
      outputTail: '',
      heuristic: null,
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
    // Claude Code, Codex, Gemini CLI, OpenCode or a custom command (see src/server/agents)
    const adapter = adapterFor(info.agent);
    const tracker = outputTrackerFor(adapter);
    live.heuristic = tracker;

    let proc: pty.IPty;
    try {
      const settings = this.options.settings?.();
      const command = adapter.buildLaunch(info, mode, {
        port: this.options.port,
        token: this.options.token,
        settings,
        // API keys are only withheld from Claude Code (they would bill API credits instead of the plan)
        baseEnv: adapter.id === 'claude' ? this.childEnv(settings) : childEnv(process.env, { enableTasks: settings?.enableTasks ?? true, useApiKey: true }),
        ...(adapter.id === 'claude' && this.accountEnv ? { accountEnv: () => this.accountEnv?.(info, mode) ?? {} } : {}),
      });
      // Other CLIs' accounts: CODEX_HOME / GEMINI_CLI_HOME / XDG_DATA_HOME of the chosen account
      if (adapter.id !== 'claude' && info.accountId && this.accountEnv) Object.assign(command.env, this.accountEnv(info, mode));
      proc = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: live.cols,
        rows: live.rows,
        cwd: info.cwd,
        env: command.env,
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

    // Safety net: if the SessionStart hook never reaches us, call the console ready once its
    // screen has drawn and gone quiet, instead of showing 'starting' forever
    const startWatch = setInterval(() => {
      const now = Date.now();
      if (live.pty !== proc || info.status !== 'starting' || now - startedAt > STARTING_GIVE_UP_MS) {
        clearInterval(startWatch);
        return;
      }
      if (now - startedAt < STARTING_FALLBACK_MS || live.lastOutputAt < startedAt || now - live.lastOutputAt < 1500) return;
      clearInterval(startWatch);
      info.status = 'idle';
      info.statusChangedAt = now;
      this.changed(live);
    }, 1000);
    startWatch.unref?.();

    if (tracker) {
      const heuristicWatch = setInterval(() => {
        if (live.pty !== proc) {
          clearInterval(heuristicWatch);
          return;
        }
        this.applyHeuristic(live, tracker);
      }, HEURISTIC_TICK_MS);
      heuristicWatch.unref?.();
    }

    proc.onData((data) => {
      if (live.pty !== proc) return;
      live.lastOutputAt = Date.now();
      tracker?.feed(data, live.lastOutputAt);
      this.watchModelSwitch(live, data);
      if (this.listenerCount('output')) this.emit('output', live.info.id, data);
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
      if (mode === 'resume' && quickFailure && adapter.supportsResume && this.consoles.has(info.id)) {
        if (adapter.id === 'claude') info.sessionId = crypto.randomUUID();
        else delete info.agentSessionId;
        this.launch(live, 'new', 'Could not resume the previous conversation; started a new one');
        return;
      }
      info.status = 'exited';
      info.exitCode = exitCode;
      info.statusChangedAt = Date.now();
      this.changed(live);
    });
  }

  // Status for CLIs without hooks, from their PTY output (see agents/output-status.ts)
  private applyHeuristic(live: LiveConsole, tracker: OutputStatusTracker): void {
    const { info } = live;
    const next = tracker.evaluate(info.status);
    if (!next) return;
    // A note from a failed resume stays until the first real turn, like with Claude Code
    const detail = next.detail ?? (next.status === 'idle' ? info.statusDetail : undefined);
    if (next.status === info.status && detail === info.statusDetail) return;
    if (next.status !== info.status) info.statusChangedAt = Date.now();
    info.status = next.status;
    info.statusDetail = detail;
    this.changed(live);
  }

  // "/model haiku" leaves no hook behind; its confirmation on screen is the cue to re-read the model
  private watchModelSwitch(live: LiveConsole, data: string): void {
    // Claude Code draws spaces as cursor moves (ESC[1C), so the plain text reads "Setmodelto"
    const text = live.outputTail + data.replace(ANSI_PATTERN, '');
    // Keep a short tail so a phrase split across two chunks is still found
    live.outputTail = text.slice(-32);
    if (!MODEL_SWITCH_PATTERN.test(text)) return;
    live.outputTail = '';
    this.emit('model-switch', live.info.id);
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

  private childEnv(settings?: AppSettings): Record<string, string> {
    return childEnv(process.env, settings);
  }
}

// API keys make Claude Code bill API credits instead of the user's subscription login,
// so consoles never see them unless AGENTARMY_USE_API_KEY=1 opts in.
const API_KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function childEnv(
  source: NodeJS.ProcessEnv,
  settings?: Pick<AppSettings, 'useApiKey' | 'enableTasks'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const dropKeys = source.AGENTARMY_USE_API_KEY !== '1' && !settings?.useApiKey;
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value === undefined || PARENT_SESSION_ENV.includes(upper)) continue;
    if (dropKeys && API_KEY_ENV.includes(upper)) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Task tools (TaskCreate/TaskUpdate) feed the Progress tab; Claude Code only offers them with this flag
  if (settings?.enableTasks === false) delete env.CLAUDE_CODE_ENABLE_TASKS;
  else env.CLAUDE_CODE_ENABLE_TASKS ??= '1';
  return env;
}

// Model aliases / ids for --model / -m: "sonnet", "gpt-5.5-codex", "xai/grok-4", "claude-opus-4-1[1m]"
export const LAUNCH_MODEL_RE = /^[A-Za-z0-9._:/@\-[\]]{1,200}$/;

export class NotFoundError extends Error {}
