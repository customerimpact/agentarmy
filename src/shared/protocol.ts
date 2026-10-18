// Contract between the local server (src/server) and the browser UI (src/web).
// Both sides import from here; change it only with both sides in mind.

import type { UsageBroadcast } from './usage.js';

export const DEFAULT_PORT = 4317;
export const STATE_VERSION = 2; // v1 files load with empty jobs/actions

export type ConsoleStatus =
  | 'starting' // PTY spawned, no SessionStart hook yet
  | 'idle' // session ready, waiting for the first prompt
  | 'working' // prompt submitted or tools running
  | 'needs_you' // permission prompt or question waiting on the user
  | 'resting' // turn finished (Stop hook), waiting for the next prompt
  | 'error' // StopFailure hook (API error)
  | 'exited' // PTY process ended
  | 'suspended'; // restored from disk, not yet relaunched (see POST /api/resume-all)

export interface ConsoleLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConsoleInfo {
  id: string; // our id, stable across restarts
  name: string;
  cwd: string;
  sessionId: string; // Claude Code session id (UUID), updated from SessionStart hooks
  status: ConsoleStatus;
  statusDetail?: string; // e.g. the Notification message
  statusChangedAt: number; // epoch ms
  layout: ConsoleLayout;
  createdAt: number;
  exitCode?: number;
  todos?: TodoItem[]; // the agent's own task list, read from TodoWrite / Task* tool hooks
  activity?: string; // last tool use in plain words, e.g. "Edit src/app.ts" or "Bash: npm test"
  model?: string; // e.g. 'claude-opus-5-5', from hook payloads or the transcript
  projectId?: string | null; // the project (named group) this console belongs to
  role?: string; // e.g. 'Orchestrator', 'Frontend', 'Reviewer' (set by templates or the user)
  pastSessionIds?: string[]; // earlier Claude Code session ids (after /clear or a failed resume), for usage totals
  git?: ConsoleGit; // set when the console works in its own git worktree + branch
  gitStats?: GitStats; // branch + working tree vs base, refreshed by the server
  accountId?: string; // Claude Code account (config dir) it runs on; undefined = the default ~/.claude
}

// ---------- Worktree + review (each agent on its own branch) ----------
// Worktrees live next to the repo, outside it: <repoRoot>/../<repoName>.worktrees/<slug>-<short>
// Killing a console keeps its worktree and branch; only "Discard branch" removes them.

export interface ConsoleGit {
  repoRoot: string; // the checkout the agent branched from; merges happen here
  branch: string; // agentarmy/<name-slug>-<short>
  baseRef: string; // branch name (or commit) of repoRoot when the worktree was made
  worktree: string; // absolute path of the agent's worktree
}

export interface GitStats {
  added: number;
  removed: number;
  files: number; // changed files (committed on the branch + uncommitted)
  ahead: number;
  dirty: boolean; // uncommitted changes in the worktree
  at: number;
}

export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  added: number | null; // null for binary files
  removed: number | null;
}

export interface GitSummary {
  git: ConsoleGit;
  missing: boolean; // worktree folder is gone
  ahead: number;
  behind: number;
  committed: GitFileChange[]; // merge-base(base, branch)..branch
  uncommitted: GitFileChange[]; // worktree vs HEAD, untracked included
  mainDirty: boolean; // the main checkout has uncommitted tracked changes (blocks merge)
  mainBranch: string | null; // branch checked out in repoRoot (null = detached)
  stats: GitStats;
}

export interface GitDiffResponse {
  file: string;
  scope: 'committed' | 'uncommitted';
  diff: string; // unified diff text
  truncated: boolean; // cut server-side (very large diff)
}

export interface GitRepoInfo {
  repoRoot: string | null; // null when the folder is not inside a git repo
  branch: string | null;
}

export interface GitMergeConflict {
  error: string;
  conflicts: string[];
}

// ---------- Projects (named groups of consoles, drawn as a frame on the board) ----------
// Closing a project stops its consoles (they become 'suspended') and hides them from the board.
// Opening it relaunches them with --resume, so the work continues where it stopped.

export const PROJECT_COLORS = ['orange', 'amber', 'rose', 'violet', 'blue', 'teal', 'green'] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export interface Project {
  id: string;
  name: string;
  color: ProjectColor;
  consoleIds: string[]; // order = order inside the frame grid
  open: boolean;
  createdAt: number;
}

export interface CreateProjectRequest {
  name: string;
  consoleIds: string[]; // consoles move out of any other project
  color?: ProjectColor;
}

export interface UpdateProjectRequest {
  name?: string;
  color?: ProjectColor;
  consoleIds?: string[];
}

// ---------- Templates (one click launches a project of agents with roles) ----------

export interface TemplateTeam {
  name: string; // frame title, e.g. 'Frontend'
  role: string; // console role
  count: number;
  prompt?: string; // first message typed into each console once it is ready
}

export interface Template {
  id: string;
  name: string;
  description: string;
  orchestrator: boolean; // adds an orchestrator console wired to every other console
  teams: TemplateTeam[];
}

export interface LaunchTemplateRequest {
  cwd: string;
  projectName?: string;
  origin?: { x: number; y: number }; // board position for the top-left of the layout
  worktrees?: boolean; // give each agent (not the orchestrator) its own branch + worktree
  accountId?: string; // 'auto' (default) or an account id, for every console of the launch
}

export interface LaunchTemplateResponse {
  projects: Project[];
  consoles: ConsoleInfo[];
}

// ---------- Git clone ----------

export interface CloneRequest {
  url: string; // https or ssh git URL, or 'owner/repo' shorthand for GitHub
  parent: string; // folder the repo is cloned into
}

export interface CloneResponse {
  path: string; // absolute path of the new checkout
}

// ---------- Browser tiles (live Chromium views on the board that agents can drive) ----------

export interface BrowserTile {
  id: string;
  url: string;
  title: string;
  layout: ConsoleLayout;
  linkedConsoleId?: string | null; // the console whose agent drives this browser
  cursor?: { x: number; y: number; t: number; click?: boolean } | null; // last agent pointer position (page px); click = pressed at t
  error?: string | null; // set when the browser process could not start or crashed
}

// ---------- Agent-to-agent jobs (the lines between consoles on the board) ----------
// An orchestrator console sends a job to another console through the agentarmy MCP tools.
// sent -> working (target submitted it) -> done | failed (target reported, or its turn ended)

export type JobStatus = 'sent' | 'working' | 'done' | 'failed';

export interface Job {
  id: string;
  fromId: string | null; // sending console; null when the user sent it
  toId: string;
  title: string; // short label drawn on the line
  message: string; // full text typed into the target
  status: JobStatus;
  result?: string; // the target's report
  createdAt: number;
  updatedAt: number;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

// ---------- Action inbox (things waiting on the user) ----------
// 'needs_you' items open when a console starts waiting on you and resolve themselves when it moves on.
// 'error' items open on StopFailure. 'request' items are filed by an agent (MCP tool) and the user closes them.

// 'stuck' items open when a working console stalls, loops on one tool call or runs very long.
export type ActionKind = 'needs_you' | 'error' | 'request' | 'stuck' | 'budget' | 'account'; // budget: a usage budget hit 80% / 100%; account: limit hit / account switched

export interface ActionOption {
  key: string; // needs_you: keystroke sent to the dialog ('1'); stuck: 'nudge' | 'interrupt' | 'ignore'
  label: string;
}

export interface ActionItem {
  id: string;
  consoleId: string | null;
  kind: ActionKind;
  title: string;
  detail?: string;
  question?: string; // the dialog's question, read from the screen
  options?: ActionOption[]; // answer buttons (POST /api/actions/:id/answer { key })
  allowText?: boolean; // the dialog takes a typed answer (POST .../answer { text })
  context?: string[]; // last few terminal lines above the dialog
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: 'auto' | 'user';
}

export interface AnswerActionRequest {
  key?: string; // one of the item's option keys
  text?: string; // typed answer (needs allowText, or no options at all)
}

export interface BoardState {
  version: typeof STATE_VERSION;
  consoles: ConsoleInfo[];
  jobs: Job[]; // newest last, capped server-side
  actions: ActionItem[]; // newest last; resolved ones are capped server-side
  projects: Project[];
  browsers: BrowserTile[];
  viewport?: { x: number; y: number; zoom: number };
}

// ---------- REST (all require ?token= or header x-agentarmy-token) ----------
// GET    /api/state                      -> BoardState
// POST   /api/consoles   CreateConsoleRequest -> ConsoleInfo
// PATCH  /api/consoles/:id UpdateConsoleRequest -> ConsoleInfo
// DELETE /api/consoles/:id               -> { ok: true }   (kills the PTY)
// POST   /api/consoles/:id/restart       -> ConsoleInfo    (relaunch with --resume; also resumes a suspended console)
// POST   /api/resume-all                 -> { resumed: number } (relaunch every suspended console with --resume)
// PUT    /api/viewport  { x, y, zoom }   -> { ok: true }
// GET    /api/fs/list?path=<dir>         -> FsListResponse (folder picker; path omitted = home dir)
// PATCH  /api/actions/:id  { resolved: boolean } -> ActionItem
// POST   /api/actions/:id/answer AnswerActionRequest -> ActionItem (types the answer into the console)
// POST   /api/actions/clear-resolved     -> { removed: number }
// DELETE /api/jobs/:id                   -> { ok: true }
// POST   /api/consoles/:id/send  { text } -> { ok: true }  (types text + Enter, bracketed paste)
// POST   /api/projects   CreateProjectRequest -> Project
// PATCH  /api/projects/:id UpdateProjectRequest -> Project
// DELETE /api/projects/:id               -> { ok: true }   (ungroups; consoles stay)
// POST   /api/projects/:id/close         -> Project        (stop consoles, hide them)
// POST   /api/projects/:id/open          -> Project        (show and --resume them)
// GET    /api/templates                  -> Template[]
// POST   /api/templates/:id/launch LaunchTemplateRequest -> LaunchTemplateResponse
// POST   /api/git/clone  CloneRequest    -> CloneResponse
// GET    /api/git/info?path=             -> GitRepoInfo
// GET    /api/consoles/:id/git/summary   -> GitSummary
// GET    /api/consoles/:id/git/diff?file=&scope=committed|uncommitted -> GitDiffResponse
// POST   /api/consoles/:id/git/commit { message } -> GitSummary
// POST   /api/consoles/:id/git/merge     -> GitSummary  (409 GitMergeConflict when refused/conflicted)
// POST   /api/consoles/:id/git/discard   -> { ok: true } (removes console, worktree and branch)
// POST   /api/browsers   { url?, layout?, linkedConsoleId? } -> BrowserTile
// PATCH  /api/browsers/:id { url?, layout?, linkedConsoleId? } -> BrowserTile
// DELETE /api/browsers/:id               -> { ok: true }
// POST   /hook/:consoleId                <- Claude Code HTTP hook POSTs (token in query string)
//
// ---------- Bridge (used by the agentarmy MCP server running inside each console) ----------
// Token in the query string only, like /hook. :consoleId is the calling console.
// GET    /bridge/:consoleId/agents                     -> BridgeAgent[] (others, nearest first)
// POST   /bridge/:consoleId/jobs   BridgeSendJob       -> Job   (types the job into the target)
// GET    /bridge/:consoleId/jobs                       -> Job[] (jobs this console sent or received)
// POST   /bridge/:consoleId/jobs/:jobId/report BridgeReport -> Job (also tells the sender)
// POST   /bridge/:consoleId/actions BridgeRequestAction -> ActionItem

export interface BridgeAgent {
  id: string;
  name: string;
  status: ConsoleStatus;
  cwd: string;
  distance: number; // board pixels between centers
}

export interface BridgeSendJob {
  to: string; // console name (case-insensitive) or id
  title: string;
  message: string;
}

export interface BridgeReport {
  result: string;
  status?: 'done' | 'failed'; // default done
}

export interface BridgeRequestAction {
  title: string;
  detail?: string;
}

export interface CreateConsoleRequest {
  cwd: string;
  name?: string; // defaults to a friendly unique name (Ada, Bex, ...)
  layout?: Partial<ConsoleLayout>;
  worktree?: boolean; // isolated branch: create a git worktree and run the agent there
  accountId?: string; // 'auto' (default) = highest-priority account that is not limited, or an account id
}

export interface UpdateConsoleRequest {
  name?: string;
  layout?: Partial<ConsoleLayout>;
}

export interface FsEntry {
  name: string;
  path: string; // absolute
}

export interface FsListResponse {
  path: string; // absolute, normalized
  parent: string | null;
  dirs: FsEntry[]; // directories only, sorted, hidden ones excluded
  roots: string[]; // drive letters on Windows (e.g. 'C:\\'), ['/'] elsewhere
}

// ---------- Settings (persisted in <AGENTARMY_HOME>/settings.json) ----------
// GET    /api/settings                         -> PublicSettings
// PATCH  /api/settings  SettingsPatch          -> PublicSettings (validated; broadcast as 'settings')
// POST   /api/settings/reset                   -> PublicSettings (everything back to defaults)
// POST   /api/settings/test-webhook { kind }   -> { ok: true }  (posts a test message)
// POST   /api/settings/test-ntfy               -> { ok: true }  (pushes a test message to the phone)
// POST   /api/settings/ntfy-topic              -> NtfyTopic     (full topic, for the subscribe QR code)
// Claude Code settings only apply to consoles launched or restarted after the change.

export type PermissionModeSetting = '' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type StartupResume = 'ask' | 'always' | 'never';
export type WebhookKind = 'slack' | 'discord';

export interface AppSettings {
  model: string; // '' = Claude Code's own default; else passed as --model (alias or full id)
  permissionMode: PermissionModeSetting; // '' = Claude Code's own default; else --permission-mode
  extraArgs: string; // extra claude flags, split like a shell (quotes respected), no shell involved
  enableTasks: boolean; // CLAUDE_CODE_ENABLE_TASKS=1 (feeds the Progress tab)
  useApiKey: boolean; // pass ANTHROPIC_API_KEY through (bills API credits instead of the subscription)
  claudePath: string; // '' = find claude on PATH (or AGENTARMY_CLAUDE_PATH)
  startupResume: StartupResume; // what happens to saved conversations when the server starts
  browserPath: string; // '' = auto-detect Chrome / Edge / Chromium for browser tiles
  stuckAlerts: boolean; // open a 'stuck' action when a working agent stalls, loops or runs very long
  stallMinutes: number; // working with no output and no hooks this long = stalled (1-120)
  longTurnMinutes: number; // one turn running longer than this = long turn (5-480)
  autoPreview: boolean; // open a browser tile when an agent's dev server prints a local URL
  previewMode: PreviewMode; // 'open' = open the tile directly, 'ask' = offer it in a toast first
  recapAutoSend: boolean; // post the daily recap to the configured Slack / Discord at recapTime
  recapTime: string; // 'HH:MM' local time, e.g. '18:00'
  // Usage & budgets (weighted tokens, see src/shared/usage.ts; 0 = no budget)
  budgetDailyTokens: number; // all Claude Code sessions on this machine, today
  budgetWeeklyTokens: number; // all sessions, last 7 days
  budget5hTokens: number; // all sessions, last 5 hours (plan limit pressure)
  projectDailyBudgets: Record<string, number>; // project id -> daily budget for its consoles
  pauseJobsAtBudget: boolean; // block agent-to-agent send_job while a budget is used up
}

export interface WebhookInfo {
  set: boolean;
  hint: string; // last 4 characters, so the user can recognise it; the full URL never leaves the server
}

// Phone push via ntfy (https://ntfy.sh or self-hosted). The topic is secret-ish: masked like webhooks.
export interface NtfyInfo extends WebhookInfo {
  server: string; // e.g. https://ntfy.sh
}

export interface NtfyTopic {
  topic: string;
  server: string;
  url: string; // <server>/<topic>, open it in the ntfy app to subscribe
}

export interface PublicSettings {
  settings: AppSettings;
  slack: WebhookInfo;
  discord: WebhookInfo;
  ntfy: NtfyInfo;
  version: string; // AgentArmy package version
  dataDir: string; // AGENTARMY_HOME
  port: number;
}

// '' for a webhook URL clears it
export type SettingsPatch = Partial<AppSettings> & {
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  ntfyTopic?: string; // '' turns phone notifications off
  ntfyServer?: string; // '' = https://ntfy.sh
};

// ---------- WebSocket /ws?token=  (one multiplexed socket per browser tab) ----------

export type ClientMessage =
  | { type: 'attach'; id: string } // server replies with 'replay' then streams 'output'
  | { type: 'detach'; id: string }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  // Browser tiles: frames stream while attached; input is relative to the page viewport
  | { type: 'browser-attach'; id: string }
  | { type: 'browser-detach'; id: string }
  | { type: 'browser-input'; id: string; event: BrowserInputEvent };

export type BrowserInputEvent =
  | { kind: 'mouse'; action: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: 'left' | 'middle' | 'right'; deltaX?: number; deltaY?: number; clickCount?: number }
  | { kind: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string; modifiers: number }
  | { kind: 'text'; text: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'history'; action: 'back' | 'forward' | 'reload' }
  | { kind: 'viewport'; width: number; height: number };

export type ServerMessage =
  | { type: 'replay'; id: string; data: string } // buffered scrollback so a reload restores the screen
  | { type: 'output'; id: string; data: string }
  | { type: 'console'; console: ConsoleInfo } // added or updated (status, name, layout, sessionId)
  | { type: 'removed'; id: string }
  | { type: 'job'; job: Job } // added or updated
  | { type: 'job-removed'; id: string }
  | { type: 'action'; action: ActionItem } // added or updated
  | { type: 'actions-removed'; ids: string[] }
  | { type: 'project'; project: Project } // added or updated
  | { type: 'project-removed'; id: string }
  | { type: 'browser'; browser: BrowserTile } // added or updated (url, title, cursor, layout)
  | { type: 'browser-removed'; id: string }
  | { type: 'browser-frame'; id: string; data: string; width: number; height: number } // base64 JPEG
  | { type: 'usage'; usage: UsageBroadcast } // every ~15 s when token counts changed
  | { type: 'settings'; settings: PublicSettings } // after PATCH/reset, so every tab updates
  | { type: 'preview-offer'; offer: PreviewOffer } // settings previewMode 'ask': "Open preview?"
  | { type: 'preview-offer-removed'; id: string }
  | { type: 'accounts'; accounts: AccountsState } // accounts added / changed / limited
  | { type: 'account-switch'; event: AccountSwitchEvent }; // a console moved to another account

// ---------- Auto dev previews (src/server/previews) ----------
// When a console's output shows a local dev-server URL whose port accepts connections, its linked
// browser tile navigates there (or a new tile opens to its right). previewMode 'ask' offers it first.
// GET    /api/previews/offers              -> PreviewOffer[]
// POST   /api/previews/offers/:id/accept   -> { ok: true }   (opens the preview)
// DELETE /api/previews/offers/:id          -> { ok: true }   (not now)

export type PreviewMode = 'open' | 'ask';

export interface PreviewOffer {
  id: string;
  consoleId: string;
  consoleName: string;
  url: string;
  createdAt: number;
}

// ---------- Daily recap (src/server/recap.ts) ----------
// Built from an append-only event log (<AGENTARMY_HOME>/recaps/<YYYY-MM-DD>.jsonl), no model calls.
// GET    /api/recap?date=YYYY-MM-DD        -> RecapResponse (date omitted = today, local time)
// POST   /api/recap/send { date?, kind? }  -> { sent: WebhookKind[] } (configured webhooks only)

export interface RecapJob {
  title: string;
  status: JobStatus;
  peer: string; // the other agent's name, or 'you'
  result?: string;
}

export interface RecapAgent {
  consoleId: string;
  name: string;
  role?: string;
  prompts: number; // turns started
  jobsReceived: RecapJob[];
  jobsSent: RecapJob[];
  todosCompleted: string[];
  highlights: string[]; // last assistant messages, notable commands, previews opened
  needsYou: { count: number; waitedMs: number; longestMs: number; open: number };
  errors: string[];
  files: string[]; // edited or written, relative to the agent's folder when possible
  next: TodoItem[]; // still pending / in progress (today only)
}

export interface RecapProject {
  key: string;
  name: string;
  folder?: string;
  agents: RecapAgent[];
}

export interface RecapActionItem {
  title: string;
  detail?: string;
  agent?: string;
  openedAt: number;
}

export interface Recap {
  date: string; // YYYY-MM-DD
  generatedAt: number;
  isToday: boolean;
  projects: RecapProject[];
  openActions: RecapActionItem[];
  totals: { agents: number; prompts: number; jobsDone: number; todosCompleted: number; files: number; needsYou: number };
}

export interface RecapResponse {
  recap: Recap;
  markdown: string;
  canSend: WebhookKind[]; // webhooks that are configured
}

// ---------- Claude Code accounts (src/server/accounts.ts) ----------
// An account is a Claude Code config dir (CLAUDE_CONFIG_DIR). The default account is the user's own
// ~/.claude (never modified by us); extra ones live in <AGENTARMY_HOME>/accounts/<id>/ and the user
// logs in to them in a 'Login' console. accounts.json keeps them in priority order.
// GET    /api/accounts                       -> AccountsState
// POST   /api/accounts { name }              -> Account        (creates the config dir)
// PATCH  /api/accounts AccountsPatch         -> AccountsState  (priority order, auto-switch, default for new agents)
// PATCH  /api/accounts/:id { name }          -> Account
// DELETE /api/accounts/:id                   -> { ok: true }   (deletes the dir; not for the default account)
// POST   /api/accounts/:id/login             -> ConsoleInfo    (a console running claude on that account; types /login)
// POST   /api/accounts/:id/clear-limit       -> Account        (mark it available again before the reset time)

export type AccountStatus = 'ok' | 'needs_login' | 'limited';
export type AutoSwitchMode = 'on' | 'ask' | 'off';

export interface AccountUtilization {
  fiveHour?: number; // percent of the 5-hour (session) limit used, 0-100
  sevenDay?: number; // percent of the weekly limit used
  fiveHourResetsAt?: number; // epoch ms
  sevenDayResetsAt?: number;
  at?: number; // when Claude Code (or a banner) last reported it
}

export interface Account {
  id: string; // 'default' for ~/.claude
  name: string;
  configDir: string;
  isDefault: boolean;
  email?: string; // from Claude Code's own account metadata (.claude.json oauthAccount)
  plan?: string; // e.g. 'Max', 'Pro', 'Team'
  status: AccountStatus;
  limitResetsAt?: number; // set while limited, when known
  limitLabel?: string; // e.g. 'session limit', 'weekly limit'
  utilization?: AccountUtilization;
  lastSeenAt: number; // last time a console used it (or it was created)
}

export interface AccountsState {
  accounts: Account[]; // priority order: Auto picks the first one that is ok
  autoSwitch: AutoSwitchMode; // when a console hits a limit: switch it, ask first, or do nothing
  newAgentAccount: string; // 'auto' or an account id: what New agent and templates pick by default
  loginConsoles: Record<string, string>; // account id -> console id of its open Login console
}

export interface AccountsPatch {
  order?: string[]; // account ids, highest priority first
  autoSwitch?: AutoSwitchMode;
  newAgentAccount?: string;
}

export interface AccountSwitchEvent {
  consoleId: string;
  consoleName: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  resetsAt?: number; // when the old account's limit resets
  at: number;
}
