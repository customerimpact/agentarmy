import fs from 'node:fs';
import path from 'node:path';
import {
  CODE_MAX_FILE_BYTES,
  type CodeFileResponse,
  type CodeFileStat,
  type CodeSearchResponse,
  type CodeTreeEntry,
  type CodeTreeResponse,
} from '../shared/repo.js';
import { isInside, runGit } from './worktrees.js';

// Read-only file access for the code viewer. Everything is relative to one root folder (the console's
// repository, or its folder when it is not in a repo). Paths from the browser go through resolveInside:
// no absolute paths, no "..", and the real path (symlinks resolved) must still be inside the root.

export class CodeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const MAX_GIT_FILES = 200_000;
const MAX_DIR_ENTRIES = 3000;
const MAX_WALK_ENTRIES = 30_000;
const MAX_MATCHES = 200;
const LIST_TTL_MS = 5000;
const BINARY_SNIFF_BYTES = 8000;

// '' = the root itself. Same rules as worktrees.safeRelativeFile, but an empty path is allowed.
export function safeRelativePath(raw: unknown, allowRoot = false): string {
  if (raw === undefined || raw === null || raw === '') {
    if (allowRoot) return '';
    throw new CodeError('path is required');
  }
  if (typeof raw !== 'string') throw new CodeError('path must be a string');
  const p = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new CodeError('Invalid path');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new CodeError('path must be relative to the project folder');
  if (p.split('/').some((part) => part === '..')) throw new CodeError('path cannot contain ".."');
  if (p === '' || p === '.') {
    if (allowRoot) return '';
    throw new CodeError('path is required');
  }
  return p.replace(/^\.\//, '');
}

function realpath(p: string): string {
  return fs.realpathSync.native(p);
}

// Absolute path of rel under root, refusing anything (including symlink targets) outside root
export function resolveInside(root: string, rel: string): string {
  const realRoot = realpath(root);
  const abs = path.resolve(realRoot, rel);
  if (!isInside(abs, realRoot)) throw new CodeError('Path is outside the project folder', 403);
  let real: string;
  try {
    real = realpath(abs);
  } catch {
    throw new CodeError(`Not found: ${rel}`, 404);
  }
  if (!isInside(real, realRoot)) throw new CodeError('Path points outside the project folder (symlink)', 403);
  return real;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

// ---------- listing ----------

interface CachedList {
  at: number;
  files: string[];
  truncated: boolean;
}

export class CodeFiles {
  private gitLists = new Map<string, CachedList>();

  // git ls-files: tracked + untracked-but-not-ignored, i.e. what .gitignore leaves visible
  private async gitFiles(root: string): Promise<CachedList> {
    const key = root.toLowerCase();
    const hit = this.gitLists.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit;
    const r = await runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeoutMs: 30_000 });
    const all = r.stdout.split('\0').filter(Boolean);
    const unique = [...new Set(all)];
    const list = { at: Date.now(), files: unique.slice(0, MAX_GIT_FILES), truncated: unique.length > MAX_GIT_FILES };
    this.gitLists.set(key, list);
    return list;
  }

  async tree(root: string, inRepo: boolean, rawDir: unknown): Promise<CodeTreeResponse> {
    const dir = safeRelativePath(rawDir, true);
    const absDir = dir ? resolveInside(root, dir) : realpath(root);
    if (!fs.statSync(absDir).isDirectory()) throw new CodeError(`Not a folder: ${dir}`);
    if (inRepo) {
      const list = await this.gitFiles(root);
      const prefix = dir ? `${dir}/` : '';
      const dirs = new Set<string>();
      const files: string[] = [];
      for (const f of list.files) {
        if (prefix && !f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) files.push(rest);
        else dirs.add(rest.slice(0, slash));
      }
      // --cached lists files deleted from disk too; hide them
      const present = files.filter((name) => fs.existsSync(path.join(absDir, name)));
      return {
        root,
        source: 'git',
        dir,
        entries: sortEntries([
          ...[...dirs].map((name) => ({ name, path: prefix + name, dir: true })),
          ...present.map((name) => ({ name, path: prefix + name, dir: false })),
        ]).slice(0, MAX_DIR_ENTRIES),
        truncated: list.truncated || dirs.size + present.length > MAX_DIR_ENTRIES,
      };
    }
    const dirents = fs.readdirSync(absDir, { withFileTypes: true });
    const entries: CodeTreeEntry[] = [];
    for (const d of dirents) {
      if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
      if (!d.isDirectory() && !d.isFile() && !d.isSymbolicLink()) continue;
      entries.push({ name: d.name, path: dir ? `${dir}/${d.name}` : d.name, dir: d.isDirectory() });
    }
    return {
      root,
      source: 'walk',
      dir,
      entries: sortEntries(entries).slice(0, MAX_DIR_ENTRIES),
      truncated: entries.length > MAX_DIR_ENTRIES,
    };
  }

  async search(root: string, inRepo: boolean, rawQuery: unknown): Promise<CodeSearchResponse> {
    const q = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
    if (!q) return { matches: [], truncated: false };
    const terms = q.split(/\s+/);
    const matches: string[] = [];
    const test = (rel: string) => {
      const lower = rel.toLowerCase();
      return terms.every((t) => lower.includes(t));
    };
    if (inRepo) {
      const list = await this.gitFiles(root);
      for (const f of list.files) {
        if (!test(f)) continue;
        matches.push(f);
        if (matches.length > MAX_MATCHES) break;
      }
    } else {
      walk(realpath(root), (rel) => {
        if (test(rel)) matches.push(rel);
        return matches.length <= MAX_MATCHES;
      });
    }
    // Name matches first, then shorter paths
    const score = (f: string) => (terms.every((t) => f.slice(f.lastIndexOf('/') + 1).toLowerCase().includes(t)) ? 0 : 1);
    matches.sort((a, b) => score(a) - score(b) || a.length - b.length || (a < b ? -1 : 1));
    return { matches: matches.slice(0, MAX_MATCHES), truncated: matches.length > MAX_MATCHES };
  }

  stat(root: string, rawPath: unknown): CodeFileStat {
    const rel = safeRelativePath(rawPath);
    const abs = resolveInside(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new CodeError(`Not a file: ${rel}`);
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs };
  }

  read(root: string, rawPath: unknown): CodeFileResponse {
    const rel = safeRelativePath(rawPath);
    const abs = resolveInside(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new CodeError(`Not a file: ${rel}`);
    const base = { path: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, language: languageFor(rel) };
    if (st.size > CODE_MAX_FILE_BYTES) return { ...base, kind: 'too-large' };
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return { ...base, kind: 'binary' };
    return { ...base, kind: 'text', content: buf.toString('utf8').replace(/^﻿/, '') };
  }
}

function sortEntries(entries: CodeTreeEntry[]): CodeTreeEntry[] {
  return entries.sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

// Breadth-first, capped, skipping node_modules/.git/dist and never following symlinked folders
function walk(root: string, visit: (rel: string) => boolean): void {
  const queue: string[] = [''];
  let seen = 0;
  while (queue.length) {
    const rel = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (++seen > MAX_WALK_ENTRIES) return;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) queue.push(child);
      } else if (d.isFile() || d.isSymbolicLink()) {
        if (!visit(toPosix(child))) return;
      }
    }
  }
}

// NUL bytes (or mostly control characters) in the first 8 KB = binary, like git's own heuristic
export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  return control / n > 0.3;
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  swift: 'swift',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

export function languageFor(file: string): string | null {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !base.startsWith('.env')) return null;
  if (base.startsWith('.env')) return 'ini';
  return LANGUAGES[base.slice(dot + 1)] ?? null;
}
