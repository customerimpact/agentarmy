import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkoutBranch,
  classifyRemoteError,
  commitPatch,
  commitStaged,
  createBranch,
  fetchAll,
  fileDiff,
  listBranches,
  parseStatusV2,
  pull,
  push,
  recentCommits,
  repoStatus,
  stage,
  unstage,
} from './git-repo.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());

let tmp: string;
let repo: string;
let remote: string;

function configure(dir: string): void {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-gitrepo-')));
  repo = path.join(tmp, 'demo');
  remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  configure(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

// A second clone that pushes commits behind our back
function otherClone(): string {
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', '-q', remote, other);
  configure(other);
  return other;
}

describe('parseStatusV2', () => {
  it('reads branch headers, staged/unstaged, renames, conflicts and untracked files', () => {
    const text = [
      '# branch.oid 0123456789abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 a b src/a b.ts',
      '1 .M N... 100644 100644 100644 a b README.md',
      '2 R. N... 100644 100644 100644 a b R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? notes.txt',
      '',
    ].join('\0');
    const s = parseStatusV2(text);
    expect(s).toMatchObject({ head: '012345678', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(s.staged).toEqual([
      { path: 'src/a b.ts', status: 'M' },
      { path: 'new.ts', status: 'R' },
    ]);
    expect(s.unstaged).toEqual([{ path: 'README.md', status: 'M' }]);
    expect(s.conflicted).toEqual([{ path: 'conflict.txt', status: 'U' }]);
    expect(s.untracked).toEqual([{ path: 'notes.txt', status: '?' }]);
  });

  it('handles an unborn branch and a detached HEAD', () => {
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ head: null, branch: 'main' });
    expect(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').branch).toBeNull();
  });
});

describe('branches and checkout', { timeout: 30_000 }, () => {
  it('creates, lists and switches branches', async () => {
    await createBranch(repo, 'feature/x', true);
    expect((await repoStatus(repo)).branch).toBe('feature/x');
    await checkoutBranch(repo, 'main');
    const list = await listBranches(repo);
    expect(list.current).toBe('main');
    expect(list.local.map((b) => b.name).sort()).toEqual(['feature/x', 'main']);
  });

  it('refuses invalid or duplicate branch names', async () => {
    await expect(createBranch(repo, 'bad name', true)).rejects.toThrow(/not a valid branch name/);
    await expect(createBranch(repo, '-x', true)).rejects.toThrow(/Invalid branch name/);
    await expect(createBranch(repo, 'main', true)).rejects.toThrow(/already exists/);
    await expect(checkoutBranch(repo, 'nope')).rejects.toThrow(/No branch named/);
  });

  it('refuses to switch with a dirty working tree', async () => {
    await createBranch(repo, 'other', false);
    fs.appendFileSync(path.join(repo, 'README.md'), 'edit\n');
    await expect(checkoutBranch(repo, 'other')).rejects.toThrow(/1 uncommitted change\. Commit or stash/);
    expect((await repoStatus(repo)).branch).toBe('main');
  });

  it('checks out a remote branch as a local tracking branch', async () => {
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    const other = otherClone();
    git(other, 'switch', '-q', '-c', 'remote-only');
    fs.writeFileSync(path.join(other, 'r.txt'), 'r\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'remote work');
    git(other, 'push', '-q', 'origin', 'remote-only');
    await fetchAll(repo);
    expect((await listBranches(repo)).remote).toContain('origin/remote-only');
    await checkoutBranch(repo, 'origin/remote-only');
    const s = await repoStatus(repo);
    expect(s.branch).toBe('remote-only');
    expect(s.upstream).toBe('origin/remote-only');
  });
});

describe('stage, unstage, commit, diff, log', { timeout: 30_000 }, () => {
  it('stages per file and all, unstages, and commits only what is staged', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    fs.appendFileSync(path.join(repo, 'README.md'), 'more\n');
    let s = await repoStatus(repo);
    expect(s.untracked.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(s.unstaged).toEqual([{ path: 'README.md', status: 'M' }]);

    await stage(repo, ['a.txt']);
    s = await repoStatus(repo);
    expect(s.staged).toEqual([{ path: 'a.txt', status: 'A' }]);
    expect((await fileDiff(repo, 'a.txt', 'staged')).diff).toContain('+a');
    expect((await fileDiff(repo, 'b.txt', 'unstaged')).diff).toContain('+b');
    expect((await fileDiff(repo, 'README.md', 'unstaged')).diff).toContain('+more');

    await stage(repo, undefined);
    expect((await repoStatus(repo)).staged).toHaveLength(3);
    await unstage(repo, ['README.md']);
    s = await repoStatus(repo);
    expect(s.staged.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(s.unstaged.map((f) => f.path)).toEqual(['README.md']);

    await commitStaged(repo, 'Add a and b');
    s = await repoStatus(repo);
    expect(s.staged).toEqual([]);
    expect(s.unstaged.map((f) => f.path)).toEqual(['README.md']);
    const log = await recentCommits(repo);
    expect(log.map((c) => c.subject)).toEqual(['Add a and b', 'init']);
    expect(log[0]).toMatchObject({ author: 'Test' });
    expect(log[0].date).toBeGreaterThan(Date.now() - 60_000);
    const patch = await commitPatch(repo, log[0].hash);
    expect(patch.diff).toContain('diff --git a/a.txt b/a.txt');
    expect(patch.diff).toContain('+b');
  });

  it('refuses an empty commit, bad file names and bad hashes', async () => {
    await expect(commitStaged(repo, 'x')).rejects.toThrow(/Nothing staged/);
    await expect(commitStaged(repo, '  ')).rejects.toThrow(/message is required/);
    await expect(stage(repo, ['../escape'])).rejects.toThrow(/\.\./);
    await expect(stage(repo, ['-A'])).rejects.toThrow();
    await expect(commitPatch(repo, '--all')).rejects.toThrow(/Invalid commit hash/);
  });

  it('unstages before the first commit', async () => {
    const fresh = path.join(tmp, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(fresh, 'x.txt'), 'x\n');
    await stage(fresh, undefined);
    expect((await repoStatus(fresh)).staged).toHaveLength(1);
    await unstage(fresh, ['x.txt']);
    const s = await repoStatus(fresh);
    expect(s.staged).toHaveLength(0);
    expect(s.untracked).toHaveLength(1);
    expect(s.head).toBeNull();
    expect(await recentCommits(fresh)).toEqual([]);
  });
});

describe('push / pull / fetch against a local bare remote', { timeout: 60_000 }, () => {
  it('reports a missing remote', async () => {
    const r = await push(repo);
    expect(r).toMatchObject({ ok: false, reason: 'no-remote' });
  });

  it('sets the upstream on first push, then reports ahead/behind', async () => {
    git(repo, 'remote', 'add', 'origin', remote);
    const first = await push(repo);
    expect(first.ok).toBe(true);
    let s = await repoStatus(repo);
    expect(s.upstream).toBe('origin/main');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'));

    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'local');
    s = await repoStatus(repo);
    expect(s).toMatchObject({ ahead: 1, behind: 0 });
    expect((await push(repo)).ok).toBe(true);
    expect((await repoStatus(repo)).ahead).toBe(0);
  });

  it('pulls fast-forward, detects a non-fast-forward, then merges or rebases on request', async () => {
    git(repo, 'remote', 'add', 'origin', remote);
    expect((await push(repo)).ok).toBe(true);
    const other = otherClone();

    // Fast-forward
    fs.writeFileSync(path.join(other, 'o1.txt'), 'o1\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'other 1');
    git(other, 'push', '-q');
    expect((await fetchAll(repo)).ok).toBe(true);
    expect((await repoStatus(repo)).behind).toBe(1);
    const ff = await pull(repo, 'ff-only');
    expect(ff.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, 'o1.txt'))).toBe(true);

    // Diverged: ff-only refuses with reason non-ff, nothing changes
    fs.writeFileSync(path.join(other, 'o2.txt'), 'o2\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'other 2');
    git(other, 'push', '-q');
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mine');
    const before = git(repo, 'rev-parse', 'HEAD');
    const refused = await pull(repo, 'ff-only');
    expect(refused).toMatchObject({ ok: false, reason: 'non-ff' });
    expect(refused.error).toMatch(/rebase or merge/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);

    // Push is rejected too while behind
    const rejected = await push(repo);
    expect(rejected).toMatchObject({ ok: false, reason: 'non-ff' });

    const rebased = await pull(repo, 'rebase');
    expect(rebased.ok).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('mine');
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('4'); // linear history
    expect((await push(repo)).ok).toBe(true);

    // Merge mode makes a merge commit
    git(other, 'pull', '-q', '--ff-only');
    fs.writeFileSync(path.join(other, 'o3.txt'), 'o3\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'other 3');
    git(other, 'push', '-q');
    fs.writeFileSync(path.join(repo, 'mine2.txt'), 'm2\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mine 2');
    const merged = await pull(repo, 'merge');
    expect(merged.ok).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%p').split(' ')).toHaveLength(2);
  });

  it('aborts a conflicting rebase pull and leaves the branch as it was', async () => {
    git(repo, 'remote', 'add', 'origin', remote);
    await push(repo);
    const other = otherClone();
    fs.writeFileSync(path.join(other, 'README.md'), 'theirs\n');
    git(other, 'commit', '-q', '-am', 'theirs');
    git(other, 'push', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), 'ours\n');
    git(repo, 'commit', '-q', '-am', 'ours');
    const before = git(repo, 'rev-parse', 'HEAD');
    const r = await pull(repo, 'rebase');
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await repoStatus(repo)).operation).toBeNull();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('pull without an upstream says so', async () => {
    git(repo, 'remote', 'add', 'origin', remote);
    expect(await pull(repo, 'ff-only')).toMatchObject({ ok: false, reason: 'no-upstream' });
  });
});

describe('classifyRemoteError', () => {
  it('recognises auth failures and rejections', () => {
    expect(classifyRemoteError('fatal: could not read Username for https://github.com: terminal prompts disabled')).toBe('auth');
    expect(classifyRemoteError('git@github.com: Permission denied (publickey).')).toBe('auth');
    expect(classifyRemoteError(' ! [rejected]        main -> main (fetch first)')).toBe('non-ff');
    expect(classifyRemoteError('fatal: Not possible to fast-forward, aborting.')).toBe('non-ff');
    expect(classifyRemoteError("fatal: 'nope' does not appear to be a git repository")).toBe('no-remote');
  });
});
