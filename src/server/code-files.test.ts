import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeFiles, isBinary, languageFor, resolveInside, safeRelativePath } from './code-files.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());

let tmp: string;
let root: string;
const files = new CodeFiles();

function write(rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Symlinks need admin or Developer Mode on Windows; skip those checks when not allowed
function trySymlink(target: string, link: string, type: 'file' | 'junction' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-code-')));
  root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  write('README.md', '# hi\n');
  write('src/app.ts', 'export const a = 1;\n');
  write('src/util/deep.ts', 'x\n');
  write('node_modules/lib/index.js', 'module.exports = 1;\n');
  write('dist/out.js', 'built\n');
  write('build/ignored.log', 'log\n');
  write('.gitignore', 'build/\n*.log\n');
  write('secret.log', 'nope\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('path guard', () => {
  it('refuses absolute paths, .. and control characters', () => {
    expect(() => safeRelativePath('../x')).toThrow(/\.\./);
    expect(() => safeRelativePath('src/../../x')).toThrow(/\.\./);
    expect(() => safeRelativePath('C:/Windows/win.ini')).toThrow(/relative/);
    expect(() => safeRelativePath('/etc/passwd')).toThrow(/relative/);
    expect(() => safeRelativePath('a\0b')).toThrow(/Invalid/);
    expect(() => safeRelativePath('')).toThrow(/required/);
    expect(safeRelativePath('', true)).toBe('');
    expect(safeRelativePath('src\\app.ts')).toBe('src/app.ts');
    expect(() => files.read(root, '..\\proj2\\x')).toThrow(/\.\./);
  });

  it('refuses a symlink (or junction) that escapes the folder, allows one inside', async () => {
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret\n');
    fs.mkdirSync(path.join(tmp, 'outside-dir'));
    fs.writeFileSync(path.join(tmp, 'outside-dir', 'f.txt'), 'secret\n');
    // Junctions work without admin rights on Windows
    expect(trySymlink(path.join(tmp, 'outside-dir'), path.join(root, 'jdir'), 'junction')).toBe(true);
    expect(() => resolveInside(root, 'jdir/f.txt')).toThrow(/outside/);
    expect(() => files.read(root, 'jdir/f.txt')).toThrow(/outside/);
    await expect(files.tree(root, false, 'jdir')).rejects.toThrow(/outside/);
    if (trySymlink(path.join(tmp, 'outside.txt'), path.join(root, 'link.txt'), 'file')) {
      expect(() => files.read(root, 'link.txt')).toThrow(/outside/);
    }
    if (trySymlink(path.join(root, 'README.md'), path.join(root, 'inner.md'), 'file')) {
      expect(files.read(root, 'inner.md').content).toBe('# hi\n');
    }
  });

  it('reports a missing file as not found', () => {
    expect(() => files.read(root, 'nope.ts')).toThrow(/Not found/);
  });
});

describe('tree without git (directory walk)', () => {
  it('lists one level, folders first, skipping node_modules and dist', async () => {
    const top = await files.tree(root, false, '');
    expect(top.source).toBe('walk');
    expect(top.entries.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)).toEqual([
      'd:build',
      'd:src',
      'f:.gitignore',
      'f:README.md',
      'f:secret.log',
    ]);
    const src = await files.tree(root, false, 'src');
    expect(src.entries.map((e) => e.path)).toEqual(['src/util', 'src/app.ts']);
  });

  it('searches file names', async () => {
    const r = await files.search(root, false, 'deep');
    expect(r.matches).toEqual(['src/util/deep.ts']);
    expect((await files.search(root, false, 'index')).matches).toEqual([]); // node_modules skipped
  });
});

describe('tree in a git repo (respects .gitignore)', () => {
  beforeEach(() => {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n*.log\nnode_modules/\ndist/\n');
    git(root, 'add', 'README.md', 'src/app.ts', '.gitignore');
    write('untracked.ts', 'u\n');
  });

  it('lists tracked and untracked files but not ignored ones', async () => {
    const top = await files.tree(root, true, '');
    expect(top.source).toBe('git');
    expect(top.entries.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)).toEqual([
      'd:src',
      'f:.gitignore',
      'f:README.md',
      'f:untracked.ts',
    ]);
    const src = await files.tree(root, true, 'src');
    expect(src.entries.map((e) => e.path)).toEqual(['src/util', 'src/app.ts']);
  });

  it('search uses the same list', async () => {
    expect((await new CodeFiles().search(root, true, 'log')).matches).toEqual([]);
    expect((await new CodeFiles().search(root, true, 'app')).matches).toEqual(['src/app.ts']);
  });
});

describe('reading files', () => {
  it('returns text with a language, detects binary and too-large files', () => {
    const text = files.read(root, 'src/app.ts');
    expect(text).toMatchObject({ kind: 'text', content: 'export const a = 1;\n', language: 'typescript' });
    expect(text.absPath).toBe(path.join(root, 'src', 'app.ts'));
    write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    expect(files.read(root, 'img.png')).toMatchObject({ kind: 'binary' });
    expect(files.read(root, 'img.png').content).toBeUndefined();
    write('big.txt', 'a'.repeat(1024 * 1024 + 1));
    expect(files.read(root, 'big.txt')).toMatchObject({ kind: 'too-large', size: 1024 * 1024 + 1 });
    expect(files.stat(root, 'src/app.ts').size).toBe(20);
  });

  it('isBinary and languageFor', () => {
    expect(isBinary(Buffer.from('plain text\r\n\ttabs'))).toBe(false);
    expect(isBinary(Buffer.from('caf\u00e9 \u2603', 'utf8'))).toBe(false);
    expect(isBinary(Buffer.from([1, 2, 3, 4, 5, 6]))).toBe(true);
    expect(languageFor('a/b/Dockerfile')).toBe('dockerfile');
    expect(languageFor('x.tsx')).toBe('typescript');
    expect(languageFor('.env.local')).toBe('ini');
    expect(languageFor('LICENSE')).toBeNull();
  });
});
