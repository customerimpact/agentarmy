import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitConflictError,
  assertGitPath,
  commitAll,
  createWorktree,
  discardWorktree,
  gitDiff,
  gitSummary,
  mergeBranch,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusZ,
  repoInfo,
  safeRelativeFile,
  slugify,
} from './worktrees.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let tmp: string;
let repo: string;

// The temp dir may itself sit inside a repo (e.g. a home folder under git); stop discovery there
process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-wt-')));
  repo = path.join(tmp, 'demo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\nworld\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('parsers', () => {
  it('parses numstat -z, name-status -z and porcelain -z', () => {
    const counts = parseNumstatZ('3\t1\ta.txt\0-\t-\tbin.png\0');
    expect(counts.get('a.txt')).toEqual({ added: 3, removed: 1 });
    expect(counts.get('bin.png')).toEqual({ added: null, removed: null });
    const st = parseNameStatusZ('M\0a.txt\0A\0dir/new file.ts\0D\0gone\0');
    expect([...st]).toEqual([
      ['a.txt', 'M'],
      ['dir/new file.ts', 'A'],
      ['gone', 'D'],
    ]);
    expect(parseStatusZ(' M a.txt\0?? new.txt\0R  b.txt\0old.txt\0UU c.txt\0')).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'new.txt', status: '?' },
      { path: 'b.txt', status: 'R' },
      { path: 'c.txt', status: 'U' },
    ]);
  });

  it('slugifies names', () => {
    expect(slugify('Ada Lovelace!')).toBe('ada-lovelace');
    expect(slugify('***')).toBe('agent');
  });
});

describe('path guard', () => {
  it('only allows the console repoRoot and worktree', () => {
    const g = { repoRoot: repo, branch: 'gridhive/x', baseRef: 'main', worktree: path.join(tmp, 'wt') };
    expect(assertGitPath(g, repo)).toBe(path.resolve(repo));
    expect(() => assertGitPath(g, tmp)).toThrow(/outside/);
    expect(() => assertGitPath(g, path.join(repo, 'src'))).toThrow(/outside/);
  });

  it('rejects unsafe diff file names', () => {
    for (const bad of ['', '../x', 'a/../../b', '/etc/passwd', 'C:\\x', '-p', 'a\nb']) {
      expect(() => safeRelativeFile(bad), bad).toThrow();
    }
    expect(safeRelativeFile('src\\app.ts')).toBe('src/app.ts');
  });
});

describe('worktree lifecycle', () => {
  it('detects repos', async () => {
    expect(await repoInfo(path.join(repo, 'src'))).toEqual({ repoRoot: path.resolve(repo), branch: 'main' });
    expect((await repoInfo(tmp)).repoRoot).toBeNull();
  });

  it('creates a worktree next to the repo on a new branch, keeping the subfolder', async () => {
    const made = await createWorktree(path.join(repo, 'src'), 'Ada');
    expect(made.git.branch).toMatch(/^gridhive\/ada-[0-9a-f]{4}$/);
    expect(made.git.baseRef).toBe('main');
    expect(path.dirname(made.git.worktree)).toBe(path.join(tmp, 'demo.worktrees'));
    expect(made.cwd).toBe(path.join(made.git.worktree, 'src'));
    expect(fs.existsSync(path.join(made.cwd, 'app.ts'))).toBe(true);
    expect(git(made.git.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(made.git.branch);
    // The main checkout is untouched
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses a folder outside a repo or a repo without commits', async () => {
    await expect(createWorktree(tmp, 'x')).rejects.toThrow(/Not inside a git repository/);
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q');
    await expect(createWorktree(empty, 'x')).rejects.toThrow(/no commits/);
  });

  it('summarizes uncommitted work, commits, diffs and merges cleanly', async () => {
    const { git: g } = await createWorktree(repo, 'Bex');
    fs.writeFileSync(path.join(g.worktree, 'README.md'), 'hello\nthere\nworld\n');
    fs.writeFileSync(path.join(g.worktree, 'new.txt'), 'one\ntwo\n');

    let s = await gitSummary(g);
    expect(s.ahead).toBe(0);
    expect(s.committed).toEqual([]);
    expect(s.uncommitted).toEqual([
      { path: 'README.md', status: 'M', added: 1, removed: 0 },
      { path: 'new.txt', status: '?', added: 2, removed: 0 },
    ]);
    expect(s.stats).toMatchObject({ added: 3, removed: 0, files: 2, dirty: true });

    const untracked = await gitDiff(g, 'new.txt', 'uncommitted');
    expect(untracked.diff).toContain('+one');
    const tracked = await gitDiff(g, 'README.md', 'uncommitted');
    expect(tracked.diff).toContain('+there');

    await expect(mergeBranch(g, 'Bex')).rejects.toThrow(/uncommitted/);
    await commitAll(g, 'Bex: edit readme');
    s = await gitSummary(g);
    expect(s.ahead).toBe(1);
    expect(s.uncommitted).toEqual([]);
    expect(s.committed.map((f) => [f.path, f.status])).toEqual([
      ['README.md', 'M'],
      ['new.txt', 'A'],
    ]);
    expect((await gitDiff(g, 'new.txt', 'committed')).diff).toContain('+two');
    await expect(commitAll(g, 'again')).rejects.toThrow(/Nothing to commit/);

    await mergeBranch(g, 'Bex');
    expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(git(repo, 'log', '-1', '--format=%s')).toContain(`Merge ${g.branch}`);
    expect((await gitSummary(g)).ahead).toBe(0);
    await expect(mergeBranch(g, 'Bex')).rejects.toThrow(/Nothing to merge/);
  });

  it('refuses to merge when the main checkout is dirty or on another branch', async () => {
    const { git: g } = await createWorktree(repo, 'Cy');
    fs.writeFileSync(path.join(g.worktree, 'x.txt'), 'x\n');
    await commitAll(g, 'x');
    fs.writeFileSync(path.join(repo, 'README.md'), 'dirty\n');
    await expect(mergeBranch(g, 'Cy')).rejects.toThrow(/uncommitted changes/);
    git(repo, 'checkout', '-q', '--', 'README.md');
    git(repo, 'checkout', '-q', '-b', 'other');
    await expect(mergeBranch(g, 'Cy')).rejects.toThrow(/on "other"/);
  });

  it('aborts a conflicting merge and lists the files', async () => {
    const { git: g } = await createWorktree(repo, 'Pip');
    fs.writeFileSync(path.join(g.worktree, 'README.md'), 'agent version\n');
    await commitAll(g, 'agent');
    fs.writeFileSync(path.join(repo, 'README.md'), 'main version\n');
    git(repo, 'commit', '-q', '-am', 'main');

    const err = await mergeBranch(g, 'Pip').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitConflictError);
    expect((err as GitConflictError).conflicts).toEqual(['README.md']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('main version\n');
    expect((await gitSummary(g)).behind).toBe(1);
  });

  it('discard removes the worktree and deletes the branch', async () => {
    const { git: g } = await createWorktree(repo, 'Otto');
    fs.writeFileSync(path.join(g.worktree, 'wip.txt'), 'unsaved\n');
    await discardWorktree(g);
    expect(fs.existsSync(g.worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', g.branch)).toBe('');
    expect(git(repo, 'worktree', 'list')).not.toContain('Otto');
  });

  it('discard refuses branches it did not make and the main checkout', async () => {
    await expect(
      discardWorktree({ repoRoot: repo, branch: 'main', baseRef: 'main', worktree: path.join(tmp, 'x') }),
    ).rejects.toThrow(/not made by GridHive/);
    await expect(
      discardWorktree({ repoRoot: repo, branch: 'gridhive/x', baseRef: 'main', worktree: repo }),
    ).rejects.toThrow(/main checkout/);
    // A folder git does not list as a worktree is never deleted
    const stray = path.join(tmp, 'stray');
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, 'keep.txt'), 'keep');
    await discardWorktree({ repoRoot: repo, branch: 'gridhive/none', baseRef: 'main', worktree: stray });
    expect(fs.existsSync(path.join(stray, 'keep.txt'))).toBe(true);
  });
});
