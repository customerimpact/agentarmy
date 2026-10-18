// Contract between the local server (src/server) and the browser UI (src/web).
// Both sides import from here; change it only with both sides in mind.

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
  cursor?: { x: number; y: number; t: number } | null; // last agent pointer position (page px)
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

export type ActionKind = 'needs_you' | 'error' | 'request';

export interface ActionItem {
  id: string;
  consoleId: string | null;
  kind: ActionKind;
  title: string;
  detail?: string;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: 'auto' | 'user';
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
  | { type: 'browser-frame'; id: string; data: string; width: number; height: number }; // base64 JPEG
