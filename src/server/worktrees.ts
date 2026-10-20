import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConsoleGit,
  GitDiffResponse,
  GitFileChange,
  GitFileStatus,
  GitRepoInfo,
  GitStats,
  GitSummary,
} from '../shared/protocol.js';

// Git plumbing for "Isolated branch" consoles: worktree create/remove, summary, diff, commit, merge.
// Every call spawns git with an args array (no shell), no prompts, a timeout, and a cwd that the
// caller has checked against the console's recorded repoRoot/worktree (see assertGitPath).

const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_DIFF_CHARS = 4 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
export const BRANCH_PREFIX = 'gridhive/';
// Branches made before the rename to GridHive
export const LEGACY_BRANCH_PREFIX = 'agentarmy/';

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly stderr = '',
  ) {
    super(message);
  }
}

export class GitConflictError extends GitError {
  constructor(
    message: string,
    readonly conflicts: string[],
  ) {
    super(message);
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Repo config could otherwise run programs on every status (core.fsmonitor) or open an editor/pager
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'color.ui=false'];

export function runGit(
  cwd: string,
  args: string[],
  // env: overrides (undefined removes a variable, e.g. GCM_INTERACTIVE for a user-started push)
  options: { timeoutMs?: number; allowFail?: boolean; git?: string; env?: Record<string, string | undefined> } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const env: Record<string, string | undefined> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      ...options.env,
    };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const child = spawn(options.git ?? 'git', [...SAFE_CONFIG, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (err: Error | null, code = 0): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      if (code !== 0 && !options.allowFail) {
        const msg = lastLines(stderr) || lastLines(stdout) || `git ${args[0]} failed (exit code ${code})`;
        return reject(new GitError(msg, code, stderr));
      }
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new GitError(`git ${args[0]} timed out`));
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-8000);
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        new GitError(err.code === 'ENOENT' ? 'git is not installed or not on PATH' : `Could not run git: ${err.message}`),
      ),
    );
    child.on('close', (code) => finish(null, code ?? 1));
  });
}

function lastLines(text: string, count = 6): string {
  return text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

const norm = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Git may only run in the console's own repoRoot or worktree, never anywhere else
export function assertGitPath(git: ConsoleGit, cwd: string): string {
  if (samePath(cwd, git.repoRoot) || samePath(cwd, git.worktree)) return path.resolve(cwd);
  throw new GitError(`Refusing to run git outside the console's repository: ${cwd}`);
}

// A repo-relative file path from the browser: no absolute paths, no "..", no option-looking names
export function safeRelativeFile(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new GitError('file is required');
  const file = raw.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(file)) throw new GitError('Invalid file name');
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.startsWith('-')) {
    throw new GitError('file must be a path inside the repository');
  }
  if (file.split('/').some((part) => part === '..')) throw new GitError('file cannot contain ".."');
  return file;
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'agent';
}

export async function repoInfo(dir: string): Promise<GitRepoInfo> {
  const cwd = path.resolve(dir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { repoRoot: null, branch: null };
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true, timeoutMs: 10_000 }).catch(
    () => null,
  );
  if (!top || top.code !== 0 || !top.stdout.trim()) return { repoRoot: null, branch: null };
  const repoRoot = path.resolve(top.stdout.trim());
  return { repoRoot, branch: await currentBranch(repoRoot) };
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Sibling folder, outside the repo so it never shows up in the user's git status
export function worktreeParent(repoRoot: string): string {
  const parent = path.dirname(repoRoot);
  if (samePath(parent, repoRoot)) throw new GitError('Cannot make a worktree next to a drive root repository');
  return path.join(parent, `${path.basename(repoRoot)}.worktrees`);
}

export interface CreatedWorktree {
  git: ConsoleGit;
  cwd: string; // worktree, or the matching subfolder when the user picked a folder inside the repo
}

export async function createWorktree(dir: string, name: string): Promise<CreatedWorktree> {
  const chosen = path.resolve(dir);
  const info = await repoInfo(chosen);
  if (!info.repoRoot) throw new GitError(`Not inside a git repository: ${chosen}`);
  const repoRoot = info.repoRoot;
  const head = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true });
  if (head.code !== 0) throw new GitError('The repository has no commits yet; make a first commit before isolating agents');
  const baseRef = info.branch ?? head.stdout.trim();

  const parent = worktreeParent(repoRoot);
  const slug = slugify(name);
  let short = '';
  let branch = '';
  let worktree = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    short = crypto.randomBytes(2).toString('hex');
    branch = `${BRANCH_PREFIX}${slug}-${short}`;
    worktree = path.join(parent, `${slug}-${short}`);
    const exists = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
    if (exists.code !== 0 && !fs.existsSync(worktree)) break;
  }
  fs.mkdirSync(parent, { recursive: true });
  await runGit(repoRoot, ['worktree', 'add', '-b', branch, '--', worktree, baseRef], { timeoutMs: 5 * 60_000 });

  const rel = path.relative(repoRoot, chosen);
  const sub = rel && !rel.startsWith('..') ? path.join(worktree, rel) : worktree;
  const cwd = fs.existsSync(sub) ? sub : worktree;
  return { git: { repoRoot, branch, baseRef, worktree: path.resolve(worktree) }, cwd };
}

// ---------- parsing ----------

// `git diff --numstat -z` (no renames): "added\tremoved\tpath\0"
export function parseNumstatZ(text: string): Map<string, { added: number | null; removed: number | null }> {
  const out = new Map<string, { added: number | null; removed: number | null }>();
  for (const rec of text.split('\0')) {
    if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rec.replace(/^\n/, ''));
    if (!m) continue;
    out.set(m[3], {
      added: m[1] === '-' ? null : Number(m[1]),
      removed: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return out;
}

// `git diff --name-status -z --no-renames`: "M\0path\0A\0path\0"
export function parseNameStatusZ(text: string): Map<string, GitFileStatus> {
  const out = new Map<string, GitFileStatus>();
  const parts = text.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i].replace(/^\n/, '').trim();
    if (!code) continue;
    out.set(parts[i + 1], toStatus(code[0]));
  }
  return out;
}

function toStatus(c: string): GitFileStatus {
  return (['A', 'M', 'D', 'R', 'C', 'T', 'U'].includes(c) ? c : 'M') as GitFileStatus;
}

// `git status --porcelain=v1 -z --untracked-files=all` (renames add a second path record)
export function parseStatusZ(text: string): { path: string; status: GitFileStatus }[] {
  const out: { path: string; status: GitFileStatus }[] = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const file = rec.slice(3);
    if (x === 'R' || x === 'C') i++; // skip the original path
    let status: GitFileStatus;
    if (x === '?' && y === '?') status = '?';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'U';
    else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'A') status = 'A';
    else if (x === 'R') status = 'R';
    else status = 'M';
    out.push({ path: file, status });
  }
  return out;
}

function countLines(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    if (buf.length === 0) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}

// ---------- summary / diff ----------

async function mergeBase(git: ConsoleGit): Promise<string> {
  const r = await runGit(git.repoRoot, ['merge-base', git.baseRef, git.branch], { allowFail: true });
  if (r.code !== 0 || !r.stdout.trim()) throw new GitError(`Cannot compare ${git.branch} with ${git.baseRef}`);
  return r.stdout.trim();
}

function changesFrom(numstat: string, nameStatus: string): GitFileChange[] {
  const counts = parseNumstatZ(numstat);
  const statuses = parseNameStatusZ(nameStatus);
  const files = new Set([...statuses.keys(), ...counts.keys()]);
  return [...files].sort().map((p) => ({
    path: p,
    status: statuses.get(p) ?? 'M',
    added: counts.get(p)?.added ?? null,
    removed: counts.get(p)?.removed ?? null,
  }));
}

async function uncommittedChanges(worktree: string): Promise<GitFileChange[]> {
  const status = await runGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = parseStatusZ(status.stdout);
  if (entries.length === 0) return [];
  const tracked = await runGit(worktree, ['diff', 'HEAD', '--numstat', '-z', '--no-renames'], { allowFail: true });
  const counts = parseNumstatZ(tracked.stdout);
  return entries
    .map((e) => {
      if (e.status === '?') {
        const lines = countLines(path.join(worktree, e.path));
        return { path: e.path, status: e.status, added: lines, removed: lines === null ? null : 0 };
      }
      const c = counts.get(e.path);
      return { path: e.path, status: e.status, added: c?.added ?? null, removed: c?.removed ?? null };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function gitSummary(git: ConsoleGit): Promise<GitSummary> {
  assertGitPath(git, git.repoRoot);
  const missing = !fs.existsSync(git.worktree);
  const base = await mergeBase(git);
  const counts = await runGit(git.repoRoot, ['rev-list', '--left-right', '--count', `${git.baseRef}...${git.branch}`]);
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
  const [numstat, nameStatus] = await Promise.all([
    runGit(git.repoRoot, ['diff', '--numstat', '-z', '--no-renames', base, git.branch]),
    runGit(git.repoRoot, ['diff', '--name-status', '-z', '--no-renames', base, git.branch]),
  ]);
  const committed = changesFrom(numstat.stdout, nameStatus.stdout);
  const uncommitted = missing ? [] : await uncommittedChanges(assertGitPath(git, git.worktree));
  const main = await runGit(git.repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const mainBranch = await currentBranch(git.repoRoot);

  // Totals: every file touched on the branch or in the worktree, counted once (worktree wins)
  const byPath = new Map<string, GitFileChange>();
  for (const f of committed) byPath.set(f.path, f);
  let added = 0;
  let removed = 0;
  if (!missing && uncommitted.length) {
    const all = await runGit(git.worktree, ['diff', '--numstat', '-z', '--no-renames', base], { allowFail: true });
    for (const [p, c] of parseNumstatZ(all.stdout)) byPath.set(p, { path: p, status: 'M', ...c });
    for (const f of uncommitted) if (f.status === '?') byPath.set(f.path, f);
  }
  for (const f of byPath.values()) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  const stats: GitStats = {
    added,
    removed,
    files: byPath.size,
    ahead: ahead || 0,
    dirty: uncommitted.length > 0,
    at: Date.now(),
  };
  return {
    git,
    missing,
    ahead: ahead || 0,
    behind: behind || 0,
    committed,
    uncommitted,
    mainDirty: main.stdout.length > 0,
    mainBranch,
    stats,
  };
}

function capDiff(text: string): { diff: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARS) return { diff: text, truncated: false };
  return { diff: text.slice(0, MAX_DIFF_CHARS), truncated: true };
}

export async function gitDiff(
  git: ConsoleGit,
  rawFile: unknown,
  scope: 'committed' | 'uncommitted',
): Promise<GitDiffResponse> {
  const file = safeRelativeFile(rawFile);
  if (scope === 'committed') {
    const base = await mergeBase(git);
    const r = await runGit(git.repoRoot, ['diff', '--no-renames', '--no-ext-diff', base, git.branch, '--', file]);
    return { file, scope, ...capDiff(r.stdout) };
  }
  const worktree = assertGitPath(git, git.worktree);
  const r = await runGit(worktree, ['diff', '--no-renames', '--no-ext-diff', 'HEAD', '--', file]);
  if (r.stdout.trim()) return { file, scope, ...capDiff(r.stdout) };
  // Untracked: git diff shows nothing, so build an "added file" diff ourselves
  const abs = path.join(worktree, file);
  if (!isInside(abs, worktree)) throw new GitError('file must be a path inside the repository');
  const untracked = await runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z', '--', file]);
  if (!untracked.stdout.split('\0').includes(file)) return { file, scope, diff: '', truncated: false };
  return { file, scope, ...untrackedDiff(file, abs) };
}

export function untrackedDiff(file: string, abs: string): { diff: string; truncated: boolean } {
  const header = `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n`;
  let buf: Buffer;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { diff: header, truncated: false };
    if (stat.size > MAX_DIFF_CHARS) return { diff: `${header}Binary or very large file (${stat.size} bytes)\n`, truncated: true };
    buf = fs.readFileSync(abs);
  } catch {
    return { diff: header, truncated: false };
  }
  if (buf.includes(0)) return { diff: `${header}Binary file\n`, truncated: false };
  const lines = buf.toString('utf8').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return { diff: `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`, truncated: false };
}

// ---------- actions ----------

export async function commitAll(git: ConsoleGit, message: string): Promise<void> {
  const msg = message.trim();
  if (!msg) throw new GitError('A commit message is required');
  const worktree = assertGitPath(git, git.worktree);
  if (!fs.existsSync(worktree)) throw new GitError('The worktree folder no longer exists');
  await runGit(worktree, ['add', '-A']);
  const staged = await runGit(worktree, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0) throw new GitError('Nothing to commit');
  await runGit(worktree, ['commit', '-q', '-m', msg]);
}

export async function mergeBranch(git: ConsoleGit, agentName: string): Promise<string> {
  const repoRoot = assertGitPath(git, git.repoRoot);
  if (fs.existsSync(git.worktree)) {
    const wt = await runGit(assertGitPath(git, git.worktree), ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (wt.stdout.length) throw new GitError('The agent has uncommitted changes. Commit them first.');
  }
  const mainBranch = await currentBranch(repoRoot);
  if (mainBranch !== git.baseRef) {
    throw new GitError(
      mainBranch
        ? `The main checkout is on "${mainBranch}", not "${git.baseRef}". Switch it to ${git.baseRef} first.`
        : `The main checkout is not on a branch. Check out ${git.baseRef} first.`,
    );
  }
  const main = await runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (main.stdout.length) {
    throw new GitError(`The main checkout (${repoRoot}) has uncommitted changes. Commit or stash them first.`);
  }
  const ahead = await runGit(repoRoot, ['rev-list', '--count', `${git.baseRef}..${git.branch}`]);
  if (Number(ahead.stdout.trim()) === 0) throw new GitError(`Nothing to merge: ${git.branch} has no new commits`);

  const merge = await runGit(
    repoRoot,
    ['merge', '--no-ff', '--no-edit', '-m', `Merge ${git.branch} (${agentName})`, git.branch],
    { allowFail: true, timeoutMs: 5 * 60_000 },
  );
  if (merge.code !== 0) {
    const unmerged = await runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFail: true });
    const conflicts = unmerged.stdout.split('\0').filter(Boolean);
    await runGit(repoRoot, ['merge', '--abort'], { allowFail: true });
    if (conflicts.length) {
      throw new GitConflictError(`Merge conflict in ${conflicts.length} file(s); the merge was aborted.`, conflicts);
    }
    throw new GitError(lastLines(merge.stderr) || lastLines(merge.stdout) || 'git merge failed');
  }
  const sha = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  return sha.stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Removes the worktree folder and deletes the branch. Only for our own gridhive/* (or older agentarmy/*) branches and
// for folders git itself lists as a worktree of repoRoot.
export async function discardWorktree(git: ConsoleGit): Promise<void> {
  const repoRoot = assertGitPath(git, git.repoRoot);
  if (!git.branch.startsWith(BRANCH_PREFIX) && !git.branch.startsWith(LEGACY_BRANCH_PREFIX)) throw new GitError(`Refusing to delete a branch not made by GridHive: ${git.branch}`);
  if (samePath(git.worktree, repoRoot)) throw new GitError('Refusing to remove the main checkout');
  const listed = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const known = listed.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .some((l) => samePath(l.slice('worktree '.length), git.worktree));
  if (known) {
    // A just-killed process can still hold the folder on Windows; retry for a few seconds
    let lastErr: unknown = null;
    for (let i = 0; i < 8; i++) {
      const r = await runGit(repoRoot, ['worktree', 'remove', '--force', '--force', '--', git.worktree], { allowFail: true });
      if (r.code === 0) {
        lastErr = null;
        break;
      }
      lastErr = new GitError(lastLines(r.stderr) || 'git worktree remove failed');
      await sleep(500);
    }
    if (lastErr && fs.existsSync(git.worktree)) throw lastErr;
  }
  if (fs.existsSync(git.worktree) && known) fs.rmSync(git.worktree, { recursive: true, force: true, maxRetries: 5 });
  await runGit(repoRoot, ['worktree', 'prune'], { allowFail: true });
  const del = await runGit(repoRoot, ['branch', '-D', git.branch], { allowFail: true });
  if (del.code !== 0 && !/not found/i.test(del.stderr)) {
    throw new GitError(lastLines(del.stderr) || `Could not delete branch ${git.branch}`);
  }
}
