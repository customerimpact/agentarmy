// Contract between the local server (src/server) and the browser UI (src/web).
// Both sides import from here; change it only with both sides in mind.

export const DEFAULT_PORT = 4317;
export const STATE_VERSION = 1;

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
}

export interface BoardState {
  version: typeof STATE_VERSION;
  consoles: ConsoleInfo[];
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
// POST   /hook/:consoleId                <- Claude Code HTTP hook POSTs (token in query string)

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
  | { type: 'resize'; id: string; cols: number; rows: number };

export type ServerMessage =
  | { type: 'replay'; id: string; data: string } // buffered scrollback so a reload restores the screen
  | { type: 'output'; id: string; data: string }
  | { type: 'console'; console: ConsoleInfo } // added or updated (status, name, layout, sessionId)
  | { type: 'removed'; id: string };
