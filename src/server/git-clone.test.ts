import { spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneRepo, normalizeCloneUrl, pickDestination, repoNameFromUrl } from './git-clone.js';

describe('normalizeCloneUrl', () => {
  it('accepts https, ssh and owner/repo shorthand', () => {
    expect(normalizeCloneUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(normalizeCloneUrl(' https://gitlab.com/a/b ')).toBe('https://gitlab.com/a/b');
    expect(normalizeCloneUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
    expect(normalizeCloneUrl('ssh://git@host.com/owner/repo')).toBe('ssh://git@host.com/owner/repo');
    expect(normalizeCloneUrl('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(normalizeCloneUrl('owner/repo.git')).toBe('https://github.com/owner/repo.git');
  });

  it('rejects option injection, whitespace, control chars and unsafe transports', () => {
    for (const bad of [
      '',
      '-uevil',
      '--upload-pack=calc',
      'https://x.com/a b',
      'https://x.com/a\nb',
      'ext::sh -c calc',
      'ext::calc',
      'fd::17',
      'file:///etc',
      'file://C:/x',
      'http://example.com/a.git',
      'C:\\repos\\x',
      '/srv/repo',
      '../x',
      './repo',
      'git@host:-oProxyCommand=calc',
      'ftp://x/y',
    ]) {
      expect(() => normalizeCloneUrl(bad), bad).toThrow();
    }
    expect(() => normalizeCloneUrl(42)).toThrow();
  });
});

describe('destination naming', () => {
  it('takes the repo name from the url', () => {
    expect(repoNameFromUrl('https://github.com/a/b.git')).toBe('b');
    expect(repoNameFromUrl('https://github.com/a/b/')).toBe('b');
    expect(repoNameFromUrl('git@github.com:owner/my-repo.git')).toBe('my-repo');
    expect(repoNameFromUrl('git@github.com:repo.git')).toBe('repo');
    expect(repoNameFromUrl('https://host/a/b.git?x=1')).toBe('b');
  });

  it('adds -2, -3 when the folder exists', () => {
    const taken = new Set([path.join('P', 'b'), path.join('P', 'b-2')]);
    expect(pickDestination('P', 'b', (p) => taken.has(p))).toBe(path.join('P', 'b-3'));
    expect(pickDestination('P', 'c', (p) => taken.has(p))).toBe(path.join('P', 'c'));
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const online = await dns.lookup('github.com').then(
  () => true,
  () => false,
);

describe('cloneRepo', () => {
  it('rejects a missing parent folder', async () => {
    await expect(cloneRepo('owner/repo', path.join(os.tmpdir(), 'nope-agentarmy-xyz'))).rejects.toThrow(
      /Not a directory/,
    );
  });

  it('reports a clear error when git is missing', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clone-'));
    await expect(cloneRepo('owner/repo', parent, { git: 'git-does-not-exist-xyz' })).rejects.toThrow(
      /git is not installed/,
    );
    expect(fs.readdirSync(parent)).toEqual([]);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it.skipIf(!hasGit || !online)('clones a tiny public repo, then a second copy as -2', { timeout: 120_000 }, async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clone-'));
    try {
      const first = await cloneRepo('octocat/Hello-World', parent);
      expect(first.path).toBe(path.join(parent, 'Hello-World'));
      expect(fs.existsSync(path.join(first.path, '.git'))).toBe(true);
      const second = await cloneRepo('https://github.com/octocat/Hello-World.git', parent);
      expect(second.path).toBe(path.join(parent, 'Hello-World-2'));
      await expect(cloneRepo('octocat/this-repo-does-not-exist-aa', parent)).rejects.toThrow();
      expect(fs.existsSync(path.join(parent, 'this-repo-does-not-exist-aa'))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
