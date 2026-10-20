import fs from 'node:fs';
import path from 'node:path';
import type {
  GitBranchList,
  GitChangeKind,
  GitCommitInfo,
  GitDiffText,
  GitRemoteResult,
  GitRepoChange,
  GitRepoStatus,
} from '../shared/repo.js';
import { GitError, isInside, runGit, safeRelativeFile, untrackedDiff, type GitResult } from './worktrees.js';

// Git panel plumbing for any console whose folder is inside a git repository (not only worktrees).
// The caller resolves repoRoot from the console's own cwd; nothing here takes a path from the browser
// except repo-relative file names (safeRelativeFile) and branch names (validated by git itself).

export const REMOTE_TIMEOUT_MS = 2 * 60_000;
const MAX_DIFF_CHARS = 4 * 1024 * 1024;
const LOG_COUNT = 20;

// A push/pull/fetch the user clicked may let Git Credential Manager show its own sign-in window.
// GIT_TERMINAL_PROMPT=0 stays on, so git itself never waits for a password on a terminal.
const REMOTE_ENV = { GCM_INTERACTIVE: undefined };

function capDiff(text: string): GitDiffText {
  return text.length <= MAX_DIFF_CHARS
    ? { diff: text, truncated: false }
    : { diff: text.slice(0, MAX_DIFF_CHARS), truncated: true };
}

// ---------- status ----------

function kindOf(c: string): GitChangeKind {
  return (['A', 'M', 'D', 'R', 'C', 'T', 'U'].includes(c) ? c : 'M') as GitChangeKind;
}

export interface ParsedStatus {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitRepoChange[];
  unstaged: GitRepoChange[];
  untracked: GitRepoChange[];
  conflicted: GitRepoChange[];
}

// `git status --porcelain=v2 --branch -z --untracked-files=all`
export function parseStatusV2(text: string): ParsedStatus {
  const out: ParsedStatus = {
    head: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') out.head = value === '(initial)' ? null : value.slice(0, 9);
      else if (key === 'branch.head') out.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') out.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === '?') {
      out.untracked.push({ path: rec.slice(2), status: '?' });
      continue;
    }
    if (type === '1' || type === '2') {
      // 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = rec.split(' ');
      const xy = fields[1];
      const file = fields.slice(type === '1' ? 8 : 9).join(' ');
      if (type === '2') i++; // skip the original path
      if (xy[0] !== '.') out.staged.push({ path: file, status: kindOf(xy[0]) });
      if (xy[1] !== '.') out.unstaged.push({ path: file, status: kindOf(xy[1]) });
      continue;
    }
    if (type === 'u') {
      const file = rec.split(' ').slice(10).join(' ');
      out.conflicted.push({ path: file, status: 'U' });
    }
  }
  return out;
}

async function remotes(root: string): Promise<string[]> {
  const r = await runGit(root, ['remote'], { allowFail: true });
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function operation(root: string): Promise<'merge' | 'rebase' | null> {
  const r = await runGit(root, ['rev-parse', '--absolute-git-dir'], { allowFail: true });
  const gitDir = r.stdout.trim();
  if (r.code !== 0 || !gitDir) return null;
  if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
  return null;
}

export async function repoStatus(root: string, isWorktreeConsole = false): Promise<GitRepoStatus> {
  const r = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const parsed = parseStatusV2(r.stdout);
  const [remoteList, op] = await Promise.all([remotes(root), operation(root)]);
  return {
    repoRoot: root,
    root,
    ...parsed,
    remotes: remoteList,
    operation: op,
    isWorktreeConsole,
  };
}

export function isDirty(s: Pick<GitRepoStatus, 'staged' | 'unstaged' | 'conflicted'>): boolean {
  return s.staged.length + s.unstaged.length + s.conflicted.length > 0;
}

// ---------- branches ----------

export async function listBranches(root: string): Promise<GitBranchList> {
  const fmt = '%(refname:short)%00%(upstream:short)%00%(objectname:short)';
  const [local, remote, cur] = await Promise.all([
    runGit(root, ['for-each-ref', `--format=${fmt}`, 'refs/heads']),
    runGit(root, ['for-each-ref', '--format=%(refname:short)%00%(symref)', 'refs/remotes']),
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }),
  ]);
  return {
    current: cur.code === 0 ? cur.stdout.trim() || null : null,
    local: local.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, upstream, head] = line.split('\0');
        return { name, upstream: upstream || null, head };
      }),
    remote: remote.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split('\0'))
      .filter(([, symref]) => !symref) // origin/HEAD -> origin/main
      .map(([name]) => name)
      .filter((name) => name.includes('/')),
  };
}

async function validBranchName(root: string, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new GitError('A branch name is required');
  const name = raw.trim();
  if (name.startsWith('-') || name.length > 200) throw new GitError('Invalid branch name');
  const r = await runGit(root, ['check-ref-format', '--branch', name], { allowFail: true });
  if (r.code !== 0) throw new GitError(`"${name}" is not a valid branch name`);
  return name;
}

export async function checkoutBranch(root: string, raw: unknown): Promise<void> {
  const name = await validBranchName(root, raw);
  const status = await repoStatus(root);
  if (status.operation) throw new GitError(`Finish or abort the ${status.operation} in progress first`);
  if (isDirty(status)) {
    const n = status.staged.length + status.unstaged.length + status.conflicted.length;
    throw new GitError(
      `The working tree has ${n} uncommitted change${n === 1 ? '' : 's'}. Commit or stash them before switching branches.`,
    );
  }
  if (name === status.branch) return;
  const branches = await listBranches(root);
  if (branches.local.some((b) => b.name === name)) {
    await runGit(root, ['switch', '--no-guess', name]);
    return;
  }
  if (branches.remote.includes(name)) {
    // origin/feature -> local "feature" tracking it (or switch to it when it exists already)
    const local = name.slice(name.indexOf('/') + 1);
    if (branches.local.some((b) => b.name === local)) await runGit(root, ['switch', '--no-guess', local]);
    else await runGit(root, ['switch', '-c', local, '--track', name]);
    return;
  }
  throw new GitError(`No branch named "${name}"`);
}

export async function createBranch(root: string, raw: unknown, checkout: boolean): Promise<void> {
  const name = await validBranchName(root, raw);
  const exists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true });
  if (exists.code === 0) throw new GitError(`A branch named "${name}" already exists`);
  // Creating + switching keeps uncommitted changes, so a dirty tree is fine here
  if (checkout) await runGit(root, ['switch', '-c', name]);
  else await runGit(root, ['branch', name]);
}

// ---------- stage / commit ----------

function fileList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0) throw new GitError('files must be a non-empty list');
  if (raw.length > 5000) throw new GitError('Too many files');
  return raw.map((f) => safeRelativeFile(f));
}

export async function stage(root: string, rawFiles: unknown): Promise<void> {
  const files = fileList(rawFiles);
  await runGit(root, files ? ['add', '-A', '--', ...files] : ['add', '-A']);
}

async function hasHead(root: string): Promise<boolean> {
  const r = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true });
  return r.code === 0;
}

export async function unstage(root: string, rawFiles: unknown): Promise<void> {
  const files = fileList(rawFiles);
  if (await hasHead(root)) {
    await runGit(root, files ? ['restore', '--staged', '--', ...files] : ['restore', '--staged', '--', '.']);
  } else {
    // Before the first commit there is no HEAD to restore from: drop the entries from the index
    await runGit(root, ['rm', '--cached', '-r', '-q', '--', ...(files ?? ['.'])]);
  }
}

export async function commitStaged(root: string, raw: unknown): Promise<void> {
  if (typeof raw !== 'string' || !raw.trim()) throw new GitError('A commit message is required');
  const staged = await runGit(root, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0 && (await hasHead(root))) throw new GitError('Nothing staged. Stage some files first.');
  const r = await runGit(root, ['commit', '-q', '-m', raw.trim().slice(0, 5000)], { allowFail: true });
  if (r.code !== 0) {
    const text = `${r.stderr}\n${r.stdout}`;
    if (/tell me who you are|user\.email|user\.name/i.test(text)) {
      throw new GitError(
        'Git does not know who you are. Run: git config --global user.name "Your Name" and git config --global user.email you@example.com',
      );
    }
    throw new GitError(lastLines(text) || 'git commit failed');
  }
}

// ---------- diff / log ----------

export async function fileDiff(root: string, rawFile: unknown, scope: 'staged' | 'unstaged'): Promise<GitDiffText> {
  const file = safeRelativeFile(rawFile);
  if (scope === 'staged') {
    const r = await runGit(root, ['diff', '--cached', '--no-ext-diff', '--no-renames', '--', file]);
    return capDiff(r.stdout);
  }
  const r = await runGit(root, ['diff', '--no-ext-diff', '--no-renames', '--', file]);
  if (r.stdout.trim()) return capDiff(r.stdout);
  const abs = path.join(root, file);
  if (!isInside(abs, root)) throw new GitError('file must be a path inside the repository');
  const untracked = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', file]);
  if (!untracked.stdout.split('\0').includes(file)) return { diff: '', truncated: false };
  return untrackedDiff(file, abs);
}

export async function recentCommits(root: string, count = LOG_COUNT): Promise<GitCommitInfo[]> {
  if (!(await hasHead(root))) return [];
  const r = await runGit(root, ['log', `-n${count}`, '--format=%H%x00%h%x00%s%x00%an%x00%at%x1e']);
  return r.stdout
    .split('\x1e')
    .map((rec) => rec.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash, short, subject, author, at] = rec.split('\0');
      return { hash, short, subject, author, date: Number(at) * 1000 };
    });
}

export async function commitPatch(root: string, raw: unknown): Promise<GitDiffText> {
  if (typeof raw !== 'string' || !/^[0-9a-f]{4,64}$/i.test(raw)) throw new GitError('Invalid commit hash');
  const r = await runGit(root, ['show', '--no-color', '--no-ext-diff', '--format=', '-M', raw, '--']);
  return capDiff(r.stdout);
}

// ---------- remotes ----------

function lastLines(text: string, count = 8): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.split('\r').pop()!.trim()) // progress lines rewrite themselves with \r
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

const AUTH_RE =
  /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|invalid username or password|access denied|returned error: 40[13]|support for password authentication was removed/i;
const NON_FF_RE = /non-fast-forward|\[rejected\]|fetch first|not possible to fast-forward|diverging branches|need to specify how to reconcile/i;
const CONFLICT_RE = /conflict|could not apply|merge failed|resolve all conflicts/i;
const NO_REMOTE_RE = /does not appear to be a git repository|could not read from remote repository|no such remote/i;

export function classifyRemoteError(text: string): NonNullable<GitRemoteResult['reason']> {
  if (AUTH_RE.test(text)) return 'auth';
  if (NON_FF_RE.test(text)) return 'non-ff';
  if (CONFLICT_RE.test(text)) return 'conflict';
  if (/timed out/i.test(text)) return 'timeout';
  if (NO_REMOTE_RE.test(text)) return 'no-remote';
  return 'other';
}

const REASON_HINT: Record<NonNullable<GitRemoteResult['reason']>, string> = {
  auth:
    'The remote refused the credentials. For HTTPS, sign in with Git Credential Manager (it may open its own window) or use an SSH key. GridHive never asks for or stores passwords.',
  'non-ff': 'The remote has commits you do not have.',
  'no-remote': 'This repository has no reachable remote.',
  'no-upstream': 'This branch does not track a remote branch yet.',
  conflict: 'The changes conflict. Nothing was changed: the operation was aborted.',
  timeout: 'git took longer than 2 minutes and was stopped.',
  other: '',
};

function fail(reason: NonNullable<GitRemoteResult['reason']>, output: string, detail?: string): GitRemoteResult {
  const hint = REASON_HINT[reason];
  return { ok: false, reason, output, error: [detail, hint].filter(Boolean).join('\n') || 'git failed' };
}

async function remoteRun(root: string, args: string[]): Promise<GitResult | GitRemoteResult> {
  try {
    return await runGit(root, args, { allowFail: true, timeoutMs: REMOTE_TIMEOUT_MS, env: REMOTE_ENV });
  } catch (err) {
    const message = (err as Error).message;
    return fail(/timed out/i.test(message) ? 'timeout' : 'other', '', message);
  }
}

const isResult = (r: GitResult | GitRemoteResult): r is GitRemoteResult => 'ok' in r;

function outputOf(r: GitResult): string {
  return lastLines(`${r.stdout}\n${r.stderr}`, 30);
}

export async function push(root: string): Promise<GitRemoteResult> {
  const status = await repoStatus(root);
  if (!status.branch) return fail('other', '', 'Not on a branch (detached HEAD). Check out a branch to push.');
  if (status.remotes.length === 0) return fail('no-remote', '', 'No remote is configured (git remote add origin <url>).');
  const remote = status.remotes.includes('origin') ? 'origin' : status.remotes[0];
  // First push of a branch: create it on the remote and track it
  const args = status.upstream ? ['push', '--porcelain'] : ['push', '--porcelain', '-u', remote, status.branch];
  const r = await remoteRun(root, args);
  if (isResult(r)) return r;
  const output = outputOf(r);
  if (r.code !== 0) return fail(classifyRemoteError(output), output, lastLines(r.stderr, 4));
  return { ok: true, output };
}

export async function fetchAll(root: string): Promise<GitRemoteResult> {
  const status = await repoStatus(root);
  if (status.remotes.length === 0) return fail('no-remote', '', 'No remote is configured.');
  const r = await remoteRun(root, ['fetch', '--all', '--prune']);
  if (isResult(r)) return r;
  const output = outputOf(r);
  if (r.code !== 0) return fail(classifyRemoteError(output), output, lastLines(r.stderr, 4));
  return { ok: true, output: output || 'Up to date.' };
}

export type PullMode = 'ff-only' | 'rebase' | 'merge';

export async function pull(root: string, rawMode: unknown): Promise<GitRemoteResult> {
  const mode: PullMode = rawMode === 'rebase' || rawMode === 'merge' ? rawMode : 'ff-only';
  const status = await repoStatus(root);
  if (!status.branch) return fail('other', '', 'Not on a branch (detached HEAD).');
  if (status.operation) return fail('other', '', `Finish or abort the ${status.operation} in progress first.`);
  if (!status.upstream) {
    return fail(
      status.remotes.length ? 'no-upstream' : 'no-remote',
      '',
      status.remotes.length ? `${status.branch} has no upstream. Push it first to set one.` : 'No remote is configured.',
    );
  }
  const args =
    mode === 'ff-only'
      ? ['pull', '--ff-only', '--no-edit']
      : mode === 'rebase'
        ? ['pull', '--rebase', '--no-edit']
        : ['pull', '--no-rebase', '--no-edit'];
  const r = await remoteRun(root, args);
  if (isResult(r)) return r;
  const output = outputOf(r);
  if (r.code === 0) return { ok: true, output: output || 'Already up to date.' };
  // Leave the repo as it was when a rebase/merge stopped on conflicts
  const op = await operation(root);
  if (op === 'rebase') await runGit(root, ['rebase', '--abort'], { allowFail: true });
  if (op === 'merge') await runGit(root, ['merge', '--abort'], { allowFail: true });
  const reason = op ? 'conflict' : classifyRemoteError(output);
  const result = fail(reason, output, lastLines(r.stderr, 4) || lastLines(r.stdout, 4));
  if (reason === 'non-ff' && mode === 'ff-only') {
    result.error = `Your branch and ${status.upstream} have diverged, so a fast-forward is not possible. Pull with rebase or merge?`;
  }
  return result;
}
