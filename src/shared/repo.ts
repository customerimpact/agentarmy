// Git panel + code viewer contract (server: src/server/git-repo*.ts, code-files.ts; UI: src/web/lib/repo.ts).
// Every route is keyed by a console id. The server works only in that console's repository (git
// panel) or inside its folder/repository (code viewer); paths from the browser are repo-relative.
//
// ---------- Git panel ----------
// GET    /api/git/repo/:consoleId/status              -> GitRepoStatus   (404-ish 409 when not a repo)
// GET    /api/git/repo/:consoleId/branches            -> GitBranchList
// POST   /api/git/repo/:consoleId/checkout { branch } -> GitRepoStatus   (409 when the tree is dirty)
// POST   /api/git/repo/:consoleId/branch { name, checkout? } -> GitRepoStatus
// GET    /api/git/repo/:consoleId/diff?file=&scope=staged|unstaged -> GitDiffText
// POST   /api/git/repo/:consoleId/stage   { files?: string[] }  -> GitRepoStatus (no files = all)
// POST   /api/git/repo/:consoleId/unstage { files?: string[] }  -> GitRepoStatus
// POST   /api/git/repo/:consoleId/commit  { message }           -> GitRepoStatus (staged changes only)
// POST   /api/git/repo/:consoleId/push                          -> GitRemoteResult (sets upstream on first push)
// POST   /api/git/repo/:consoleId/pull { mode?: 'ff-only'|'rebase'|'merge' } -> GitRemoteResult
// POST   /api/git/repo/:consoleId/fetch                         -> GitRemoteResult
// GET    /api/git/repo/:consoleId/log                           -> GitCommitInfo[] (last 20)
// GET    /api/git/repo/:consoleId/show?hash=                    -> GitDiffText (that commit's patch)
//
// ---------- Code viewer ----------
// GET    /api/code/:consoleId/tree?dir=<rel>   -> CodeTreeResponse   (one level, lazy)
// GET    /api/code/:consoleId/search?q=        -> CodeSearchResponse (file names, capped)
// GET    /api/code/:consoleId/file?path=<rel>  -> CodeFileResponse   (1 MB cap, binary detection)
// GET    /api/code/:consoleId/stat?path=<rel>  -> CodeFileStat       (cheap poll for pinned cards)

export type GitChangeKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface GitRepoChange {
  path: string; // repo-relative, forward slashes
  status: GitChangeKind;
}

export interface GitRepoStatus {
  repoRoot: string;
  root: string; // folder the code viewer and paths are relative to (= repoRoot)
  branch: string | null; // null = detached HEAD
  head: string | null; // short hash, null before the first commit
  upstream: string | null; // e.g. 'origin/main'
  ahead: number;
  behind: number;
  remotes: string[];
  staged: GitRepoChange[];
  unstaged: GitRepoChange[]; // tracked, modified in the working tree
  untracked: GitRepoChange[];
  conflicted: GitRepoChange[];
  operation: 'merge' | 'rebase' | null; // an unfinished merge/rebase in progress
  isWorktreeConsole: boolean; // the console runs in an GridHive worktree (Review panel exists)
}

export interface GitBranchList {
  current: string | null;
  local: { name: string; upstream: string | null; head: string }[];
  remote: string[]; // e.g. 'origin/feature'
}

export interface GitDiffText {
  diff: string;
  truncated: boolean;
}

export interface GitCommitInfo {
  hash: string; // full
  short: string;
  subject: string;
  author: string;
  date: number; // epoch ms
}

export interface GitRemoteResult {
  ok: boolean;
  output: string; // what git printed (progress lines trimmed)
  // set when ok = false
  error?: string;
  reason?: 'auth' | 'non-ff' | 'no-remote' | 'no-upstream' | 'conflict' | 'timeout' | 'other';
  status?: GitRepoStatus;
}

export interface CodeTreeEntry {
  name: string;
  path: string; // root-relative, forward slashes
  dir: boolean;
}

export interface CodeTreeResponse {
  root: string; // absolute folder the tree is relative to
  source: 'git' | 'walk'; // git ls-files (respects .gitignore) or a capped directory walk
  dir: string; // the listed folder, '' = root
  entries: CodeTreeEntry[]; // folders first, then files, sorted by name
  truncated: boolean;
}

export interface CodeSearchResponse {
  matches: string[]; // root-relative file paths
  truncated: boolean;
}

export interface CodeFileStat {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface CodeFileResponse extends CodeFileStat {
  absPath: string;
  kind: 'text' | 'binary' | 'too-large';
  content?: string; // only for text
  language: string | null; // highlight.js language name guessed from the extension
}

export const CODE_MAX_FILE_BYTES = 1024 * 1024;

// Board item kind 'file' (pinned code card)
export interface FileItemData {
  path: string; // root-relative
  consoleId: string;
  line?: number;
}
