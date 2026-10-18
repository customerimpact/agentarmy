import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConsoleInfo, Project } from '../shared/protocol.js';
import {
  emptyTotals,
  estimateCostUsd,
  weightedTokens,
  type UsageDay,
  type UsageRange,
  type UsageRow,
  type UsageTotals,
} from '../shared/usage.js';

// Token usage indexer for Claude Code transcripts (~/.claude/projects/<encoded cwd>/<session>.jsonl).
//
// Shape verified against real Claude Code 2.1.302 transcripts (2026-10-18): one JSON object per line;
// assistant entries look like { type: 'assistant', sessionId, timestamp (ISO), requestId,
// message: { id, model, usage: { input_tokens, output_tokens, cache_creation_input_tokens,
// cache_read_input_tokens, cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens },
// ... } } }. Streaming writes one line per content block, all repeating the same message.id and the
// same usage, so records are keyed by message.id (requestId as a fallback). Subagent transcripts
// live in <session>/subagents/**/agent-*.jsonl and count towards the parent session. model
// '<synthetic>' marks entries Claude Code wrote itself (errors, interruptions) and is skipped.
//
// Files are read incrementally: we remember the byte offset after the last complete line, so an
// append only costs reading the new bytes, and a half-written last line is read again next time.

export interface UsageRecord {
  id: string;
  sessionId: string;
  accountId?: string; // Claude Code account (CLAUDE_CONFIG_DIR) that wrote it; undefined = 'default'
  ts: number; // epoch ms
  model: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheCreate1h: number;
  cacheRead: number;
}

interface FileState {
  accountId: string;
  offset: number;
  size: number;
  mtimeMs: number;
  sessionId: string;
}

type Obj = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_AGE_MS = 31 * DAY_MS; // the largest range is 30 days
const READ_CHUNK = 1024 * 1024; // small enough that parsing one chunk never blocks the server for long
const MAX_LINE = 64 * 1024 * 1024; // a single line bigger than this is skipped
const MAX_DEPTH = 5;

function obj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// <root>/<project>/<session>.jsonl, or <root>/<project>/<session>/subagents/.../agent-x.jsonl
export function sessionIdFromPath(file: string): string {
  const parts = file.split(/[\\/]+/);
  const sub = parts.lastIndexOf('subagents');
  if (sub > 0) return parts[sub - 1];
  return path.basename(file, '.jsonl');
}

// Returns null for anything that is not a billable assistant message
export function parseUsageLine(line: string, fallbackSessionId: string, now = Date.now()): UsageRecord | null {
  // Cheap filter before JSON.parse: most lines are user/tool/meta entries
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let entry: Obj;
  try {
    entry = JSON.parse(line) as Obj;
  } catch {
    return null;
  }
  if (entry.type !== 'assistant') return null;
  const message = obj(entry.message);
  const usage = obj(message?.usage);
  if (!message || !usage) return null;
  const model = typeof message.model === 'string' ? message.model : '';
  if (!model || model.startsWith('<')) return null;
  const id =
    (typeof message.id === 'string' && message.id) ||
    (typeof entry.requestId === 'string' && entry.requestId) ||
    (typeof entry.uuid === 'string' && entry.uuid) ||
    '';
  if (!id) return null;
  const parsedTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const sessionId = fallbackSessionId || (typeof entry.sessionId === 'string' ? entry.sessionId : '');
  const record: UsageRecord = {
    id,
    sessionId,
    ts: Number.isFinite(parsedTs) ? parsedTs : now,
    model,
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheCreate: count(usage.cache_creation_input_tokens),
    cacheCreate1h: count(obj(usage.cache_creation)?.ephemeral_1h_input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
  };
  if (!record.input && !record.output && !record.cacheCreate && !record.cacheRead) return null;
  return record;
}

// One Claude Code account = one CLAUDE_CONFIG_DIR = one projects/ folder of transcripts
export interface TranscriptRoot {
  accountId: string;
  dir: string; // the projects/ folder
}

export const DEFAULT_ACCOUNT = 'default';

// Extra folders for tests (and unusual setups), separated like PATH; counted as the default account
function extraRoots(env: NodeJS.ProcessEnv): TranscriptRoot[] {
  return (env.AGENTARMY_TRANSCRIPTS_DIR ?? '')
    .split(path.delimiter)
    .filter((d) => d.trim())
    .map((d) => ({ accountId: DEFAULT_ACCOUNT, dir: path.resolve(d.trim()) }));
}

export function defaultTranscriptRoots(env = process.env): TranscriptRoot[] {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [{ accountId: DEFAULT_ACCOUNT, dir: path.join(base, 'projects') }, ...extraRoots(env)];
}

// ---------- configured roots (the accounts feature calls setTranscriptRoots) ----------

let configuredRoots: TranscriptRoot[] | null = null;
const rootListeners = new Set<(roots: TranscriptRoot[]) => void>();

export function getTranscriptRoots(): TranscriptRoot[] {
  return configuredRoots ?? defaultTranscriptRoots();
}

// Replaces the account roots (AGENTARMY_TRANSCRIPTS_DIR folders are always kept);
// running usage services re-scan right away
export function setTranscriptRoots(roots: TranscriptRoot[]): void {
  const seen = new Set<string>();
  const all = [
    ...roots.map((r) => ({ accountId: r.accountId || DEFAULT_ACCOUNT, dir: path.resolve(r.dir) })),
    ...extraRoots(process.env),
  ];
  configuredRoots = all.filter((r) => {
    const key = r.dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const listener of rootListeners) listener(configuredRoots);
}

// Back to the default account only (tests)
export function resetTranscriptRoots(): void {
  configuredRoots = null;
}

export function onTranscriptRootsChange(listener: (roots: TranscriptRoot[]) => void): () => void {
  rootListeners.add(listener);
  return () => rootListeners.delete(listener);
}

// The account whose root contains the file (longest match), else the default account
export function accountForFile(file: string, roots: TranscriptRoot[]): string {
  const target = path.resolve(file).toLowerCase();
  let best: TranscriptRoot | null = null;
  for (const r of roots) {
    const dir = path.resolve(r.dir).toLowerCase() + path.sep;
    if (target.startsWith(dir) && (!best || r.dir.length > best.dir.length)) best = r;
  }
  return best?.accountId ?? DEFAULT_ACCOUNT;
}

export interface Candidate {
  file: string;
  accountId?: string;
  size: number;
  mtimeMs: number;
}

export class UsageIndex {
  readonly records = new Map<string, UsageRecord>();
  private files = new Map<string, FileState>();
  version = 0; // bumps whenever records change

  constructor(private readonly now: () => number = Date.now) {}

  knownFiles(): Map<string, FileState> {
    return this.files;
  }

  add(record: UsageRecord): boolean {
    const prev = this.records.get(record.id);
    // Duplicate lines of one streamed message carry the same usage; keep the largest output seen
    if (prev && prev.output >= record.output && prev.input >= record.input) return false;
    this.records.set(record.id, record);
    this.version++;
    return true;
  }

  // Parses complete lines of text; exposed for tests
  ingestText(text: string, sessionId: string, accountId = DEFAULT_ACCOUNT): number {
    let added = 0;
    for (const line of text.split('\n')) {
      const record = parseUsageLine(line, sessionId, this.now());
      if (record && accountId !== DEFAULT_ACCOUNT) record.accountId = accountId;
      if (record && record.ts >= this.now() - MAX_AGE_MS && this.add(record)) added++;
    }
    return added;
  }

  // Reads the bytes appended since the last call. Returns the number of new records.
  async readFile(file: string, stat?: { size: number; mtimeMs: number }, accountId = DEFAULT_ACCOUNT): Promise<number> {
    let st = stat;
    if (!st) {
      try {
        st = await fs.promises.stat(file);
      } catch {
        this.files.delete(file);
        return 0;
      }
    }
    let state = this.files.get(file);
    if (!state || st.size < state.offset) {
      // New file, or truncated / replaced: read from the start (records dedupe by id)
      state = { offset: 0, size: 0, mtimeMs: 0, sessionId: sessionIdFromPath(file), accountId };
      this.files.set(file, state);
    }
    if (st.size === state.offset) {
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
      return 0;
    }
    let handle: fs.promises.FileHandle | undefined;
    let added = 0;
    try {
      handle = await fs.promises.open(file, 'r');
      let position = state.offset;
      let carry: Buffer = Buffer.alloc(0);
      while (position < st.size) {
        const length = Math.min(READ_CHUNK, st.size - position);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastNewline = data.lastIndexOf(10);
        if (lastNewline < 0) {
          carry = data;
          if (carry.length > MAX_LINE) {
            // Give up on a monster line: skip it entirely
            state.offset = position;
            carry = Buffer.alloc(0);
          }
          continue;
        }
        added += this.ingestText(data.subarray(0, lastNewline).toString('utf8'), state.sessionId, state.accountId);
        state.offset = position - (data.length - lastNewline - 1);
        carry = data.subarray(lastNewline + 1);
      }
      // A trailing partial line stays unread (offset points at its start) until it is complete
    } catch {
      // unreadable right now (locked, deleted); try again later
    } finally {
      await handle?.close().catch(() => {});
    }
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    return added;
  }

  needsRead(c: Candidate): boolean {
    const state = this.files.get(c.file);
    return !state || state.offset !== c.size || state.mtimeMs !== c.mtimeMs;
  }

  // Drops records older than the largest range
  prune(): void {
    const cutoff = this.now() - MAX_AGE_MS;
    for (const [id, r] of this.records) {
      if (r.ts < cutoff) {
        this.records.delete(id);
        this.version++;
      }
    }
  }
}

// Every .jsonl under the roots that was modified since `sinceMs`, newest first
export async function listTranscripts(roots: TranscriptRoot[], sinceMs: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const walk = async (dir: string, depth: number, accountId: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && entry.name !== 'tool-results') await walk(full, depth + 1, accountId);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs >= sinceMs) out.push({ file: full, accountId, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished
        }
      }
    }
  };
  for (const root of roots) await walk(root.dir, 0, root.accountId);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ---------- aggregation ----------

export function localDay(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function rangeStart(range: UsageRange, now: number): number {
  switch (range) {
    case 'today':
      return startOfLocalDay(now);
    case '5h':
      return now - 5 * 60 * 60 * 1000;
    case '7d':
      return now - 7 * DAY_MS;
    case '30d':
      return now - 30 * DAY_MS;
  }
}

export function addRecord(t: UsageTotals, r: UsageRecord): void {
  t.input += r.input;
  t.output += r.output;
  t.cacheCreate += r.cacheCreate;
  t.cacheRead += r.cacheRead;
  t.total += r.input + r.output + r.cacheCreate + r.cacheRead;
  t.weighted += weightedTokens(r);
  t.costUsd += estimateCostUsd(r.model, r);
  t.messages += 1;
}

export function sumRecords(records: Iterable<UsageRecord>, from: number, to = Infinity): UsageTotals {
  const t = emptyTotals();
  for (const r of records) if (r.ts >= from && r.ts <= to) addRecord(t, r);
  return t;
}

// session id -> console id, from every session a console has had
export function sessionOwners(consoles: ConsoleInfo[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const c of consoles) {
    for (const s of c.pastSessionIds ?? []) owners.set(s, c.id);
  }
  for (const c of consoles) owners.set(c.sessionId, c.id); // the current session wins
  return owners;
}

export interface AttributedRecord extends UsageRecord {
  consoleId: string;
  projectId: string; // '' = no project
}

export function attribute(records: Iterable<UsageRecord>, consoles: ConsoleInfo[]): AttributedRecord[] {
  const owners = sessionOwners(consoles);
  const byId = new Map(consoles.map((c) => [c.id, c]));
  const out: AttributedRecord[] = [];
  for (const r of records) {
    const consoleId = owners.get(r.sessionId);
    if (!consoleId) continue;
    out.push({ ...r, consoleId, projectId: byId.get(consoleId)?.projectId ?? '' });
  }
  return out;
}

function rows(
  records: AttributedRecord[],
  keyOf: (r: AttributedRecord) => string,
  labelOf: (key: string) => string,
): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const r of records) {
    const key = keyOf(r);
    let row = map.get(key);
    if (!row) {
      row = { key, label: labelOf(key), ...emptyTotals() };
      map.set(key, row);
    }
    addRecord(row, r);
  }
  return [...map.values()].sort((a, b) => b.weighted - a.weighted);
}

export function dayBuckets(records: Iterable<UsageRecord>, days: number, now: number): UsageDay[] {
  const out: UsageDay[] = [];
  const index = new Map<string, UsageDay>();
  const today = startOfLocalDay(now);
  for (let i = days - 1; i >= 0; i--) {
    // Step back from noon so DST shifts never skip or repeat a date
    const day = localDay(today + 12 * 60 * 60 * 1000 - i * DAY_MS);
    const bucket = { day, ...emptyTotals() };
    out.push(bucket);
    index.set(day, bucket);
  }
  const first = startOfLocalDay(today + 12 * 60 * 60 * 1000 - (days - 1) * DAY_MS);
  for (const r of records) {
    if (r.ts < first) continue;
    const bucket = index.get(localDay(r.ts));
    if (bucket) addRecord(bucket, r);
  }
  return out;
}

export interface Breakdown {
  totals: UsageTotals;
  byConsole: UsageRow[];
  byProject: UsageRow[];
  byModel: UsageRow[];
}

export function breakdown(
  records: AttributedRecord[],
  from: number,
  consoles: ConsoleInfo[],
  projects: Project[],
): Breakdown {
  const inRange = records.filter((r) => r.ts >= from);
  const consoleNames = new Map(consoles.map((c) => [c.id, c.name]));
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  return {
    totals: sumRecords(inRange, from),
    byConsole: rows(inRange, (r) => r.consoleId, (k) => consoleNames.get(k) ?? 'Closed console'),
    byProject: rows(inRange, (r) => r.projectId, (k) => (k ? (projectNames.get(k) ?? 'Removed project') : 'No project')),
    byModel: rows(inRange, (r) => r.model, (k) => k),
  };
}
