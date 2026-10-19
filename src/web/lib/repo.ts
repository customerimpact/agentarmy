import { useEffect } from 'react';
import { create } from 'zustand';
import type { GitRepoInfo } from '../../shared/protocol';
import type {
  CodeFileResponse,
  CodeFileStat,
  CodeSearchResponse,
  CodeTreeResponse,
  GitBranchList,
  GitCommitInfo,
  GitDiffText,
  GitRemoteResult,
  GitRepoStatus,
} from '../../shared/repo';
import { getToken } from './auth';

// Git panel + code viewer: which console's panel is open, and the REST client (src/shared/repo.ts)

export const useGitPanel = create<{ id: string | null }>(() => ({ id: null }));
export const openGitPanel = (id: string): void => useGitPanel.setState({ id });
export const closeGitPanel = (): void => useGitPanel.setState({ id: null });

export interface CodeViewerTarget {
  id: string; // console
  path: string | null; // root-relative file, null = just the tree
  line: number | null;
  nonce: number; // re-opening the same file at another line still scrolls
}
export const useCodeViewer = create<{ target: CodeViewerTarget | null }>(() => ({ target: null }));
export const openCodeViewer = (id: string, path: string | null = null, line: number | null = null): void =>
  useCodeViewer.setState({ target: { id, path, line, nonce: Date.now() } });
export const closeCodeViewer = (): void => useCodeViewer.setState({ target: null });

export class RepoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new RepoApiError(data.error || `${method} ${path} failed (${res.status})`, res.status);
  return data as T;
}

const g = (id: string, name: string) => `/api/git/repo/${encodeURIComponent(id)}/${name}`;
const c = (id: string, name: string, param: string, value: string) =>
  `/api/code/${encodeURIComponent(id)}/${name}?${param}=${encodeURIComponent(value)}`;

export type PullMode = 'ff-only' | 'rebase' | 'merge';

export const repoApi = {
  status: (id: string) => call<GitRepoStatus>('GET', g(id, 'status')),
  branches: (id: string) => call<GitBranchList>('GET', g(id, 'branches')),
  checkout: (id: string, branch: string) => call<GitRepoStatus>('POST', g(id, 'checkout'), { branch }),
  createBranch: (id: string, name: string) => call<GitRepoStatus>('POST', g(id, 'branch'), { name, checkout: true }),
  diff: (id: string, file: string, scope: 'staged' | 'unstaged') =>
    call<GitDiffText>('GET', `${g(id, 'diff')}?file=${encodeURIComponent(file)}&scope=${scope}`),
  stage: (id: string, files?: string[]) => call<GitRepoStatus>('POST', g(id, 'stage'), files ? { files } : {}),
  unstage: (id: string, files?: string[]) => call<GitRepoStatus>('POST', g(id, 'unstage'), files ? { files } : {}),
  commit: (id: string, message: string) => call<GitRepoStatus>('POST', g(id, 'commit'), { message }),
  push: (id: string) => call<GitRemoteResult>('POST', g(id, 'push'), {}),
  pull: (id: string, mode: PullMode = 'ff-only') => call<GitRemoteResult>('POST', g(id, 'pull'), { mode }),
  fetch: (id: string) => call<GitRemoteResult>('POST', g(id, 'fetch'), {}),
  log: (id: string) => call<GitCommitInfo[]>('GET', g(id, 'log')),
  show: (id: string, hash: string) => call<GitDiffText>('GET', `${g(id, 'show')}?hash=${encodeURIComponent(hash)}`),
};

export const codeApi = {
  tree: (id: string, dir = '') => call<CodeTreeResponse>('GET', c(id, 'tree', 'dir', dir)),
  search: (id: string, q: string) => call<CodeSearchResponse>('GET', c(id, 'search', 'q', q)),
  file: (id: string, path: string) => call<CodeFileResponse>('GET', c(id, 'file', 'path', path)),
  stat: (id: string, path: string) => call<CodeFileStat>('GET', c(id, 'stat', 'path', path)),
};

// ---------- is this console's folder in a git repo? (cached per folder) ----------

const INFO_TTL_MS = 60_000;
const useRepoInfos = create<{ infos: Record<string, { info: GitRepoInfo | null; at: number }> }>(() => ({ infos: {} }));
const pending = new Set<string>();

function loadInfo(cwd: string): void {
  const hit = useRepoInfos.getState().infos[cwd];
  if (pending.has(cwd) || (hit && Date.now() - hit.at < INFO_TTL_MS)) return;
  pending.add(cwd);
  call<GitRepoInfo>('GET', `/api/git/info?path=${encodeURIComponent(cwd)}`)
    .catch(() => null)
    .then((info) => useRepoInfos.setState((s) => ({ infos: { ...s.infos, [cwd]: { info, at: Date.now() } } })))
    .finally(() => pending.delete(cwd));
}

export function useRepoInfo(cwd: string | undefined): GitRepoInfo | null {
  const entry = useRepoInfos((s) => (cwd ? s.infos[cwd] : undefined));
  useEffect(() => {
    if (cwd) loadInfo(cwd);
  }, [cwd]);
  return entry?.info ?? null;
}

// Board refresh after a checkout or commit elsewhere: forget the cached branch for this folder
export function invalidateRepoInfo(cwd: string): void {
  useRepoInfos.setState((s) => {
    const infos = { ...s.infos };
    delete infos[cwd];
    return { infos };
  });
  loadInfo(cwd);
}

// "3 min ago", "2 h ago", "5 d ago"
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.round(mo / 12)} y ago`;
}

// Split a multi-file patch (git show) into one diff per file
export function splitPatch(text: string): { file: string; diff: string }[] {
  const out: { file: string; diff: string }[] = [];
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const part of parts) {
    const header = part.slice(0, part.indexOf('\n') === -1 ? undefined : part.indexOf('\n'));
    const plus = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1];
    const rename = /^rename to (.+)$/m.exec(part)?.[1];
    const fromHeader = / b\/(.+)$/.exec(header)?.[1];
    out.push({ file: (plus ?? rename ?? fromHeader ?? header).replace(/\r$/, ''), diff: part });
  }
  return out;
}

// vscode://file/C:/path/to/file.ts:12 (VS Code wants forward slashes)
export function vscodeUrl(absPath: string, line?: number | null): string {
  const p = absPath.replace(/\\/g, '/');
  const encoded = encodeURI(p.startsWith('/') ? p : `/${p}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `vscode://file${encoded}${line ? `:${line}` : ''}`;
}
