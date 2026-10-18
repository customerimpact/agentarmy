import { create } from 'zustand';
import type {
  ConsoleInfo,
  GitDiffResponse,
  GitRepoInfo,
  GitSummary,
  Job,
} from '../../shared/protocol';
import { getToken } from './auth';

// Which console's Review panel is open (one at a time)
export const useReview = create<{ id: string | null }>(() => ({ id: null }));
export const openReview = (id: string): void => useReview.setState({ id });
export const closeReview = (): void => useReview.setState({ id: null });

export class GitApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly conflicts: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['x-agentarmy-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; conflicts?: string[] };
  if (!res.ok) {
    throw new GitApiError(data.error || `${method} ${path} failed (${res.status})`, res.status, data.conflicts ?? []);
  }
  return data as T;
}

const base = (id: string) => `/api/consoles/${encodeURIComponent(id)}/git`;

export const gitApi = {
  info: (path: string) => call<GitRepoInfo>('GET', `/api/git/info?path=${encodeURIComponent(path)}`),
  summary: (id: string) => call<GitSummary>('GET', `${base(id)}/summary`),
  diff: (id: string, file: string, scope: 'committed' | 'uncommitted') =>
    call<GitDiffResponse>(
      'GET',
      `${base(id)}/diff?file=${encodeURIComponent(file)}&scope=${scope}`,
    ),
  commit: (id: string, message: string) => call<GitSummary>('POST', `${base(id)}/commit`, { message }),
  merge: (id: string) => call<GitSummary>('POST', `${base(id)}/merge`),
  discard: (id: string) => call<{ ok: true }>('POST', `${base(id)}/discard`),
};

// "<Agent name>: <last job title or activity>"
export function defaultCommitMessage(c: Pick<ConsoleInfo, 'id' | 'name' | 'activity'>, jobs: Job[]): string {
  const last = jobs
    .filter((j) => j.toId === c.id)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .pop();
  const what = last?.title?.trim() || c.activity?.trim() || 'work in progress';
  return `${c.name}: ${what}`;
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Unified diff -> rows with old/new line numbers; file headers become 'meta' rows
export function parseUnifiedDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk || line.startsWith('diff --git')) {
      inHunk = false;
      out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith('\\')) out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    else out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  // Header lines (diff --git, index, ---/+++) are noise in a per-file viewer
  return out.filter((l) => l.kind !== 'meta' || /^(Binary|\\|new file|deleted file)/i.test(l.text));
}
