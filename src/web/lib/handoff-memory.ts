import { create } from 'zustand';
import type {
  ConsoleInfo,
  HandoffPreview,
  HandoffRequest,
  HandoffSendRequest,
  HandoffSendResponse,
  MemoryDoc,
  MemoryPushRequest,
  MemoryPushResponse,
  MemoryScope,
} from '../../shared/protocol';
import { getToken } from './auth';

// UI state + REST calls for handoffs (HandoffDialog) and project memory (MemoryPanel)

interface HandoffMemoryUi {
  handoffFrom: string | null; // console id whose work is being handed off
  memoryOpen: boolean;
  memoryFolder: string | null; // folder to show first (null = Global)
  openHandoff: (fromId: string) => void;
  closeHandoff: () => void;
  openMemory: (folder?: string | null) => void;
  closeMemory: () => void;
}

export const useHandoffMemory = create<HandoffMemoryUi>((set) => ({
  handoffFrom: null,
  memoryOpen: false,
  memoryFolder: null,
  openHandoff: (fromId) => set({ handoffFrom: fromId }),
  closeHandoff: () => set({ handoffFrom: null }),
  openMemory: (folder = null) => set({ memoryOpen: true, memoryFolder: folder }),
  closeMemory: () => set({ memoryOpen: false }),
}));

export const openHandoff = (fromId: string): void => useHandoffMemory.getState().openHandoff(fromId);
export const openMemory = (folder?: string | null): void => useHandoffMemory.getState().openMemory(folder);

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
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      message = data.error || data.message || message;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const memoryQuery = (scope: MemoryScope, folder?: string | null) =>
  `/api/memory?scope=${scope}${scope === 'folder' && folder ? `&path=${encodeURIComponent(folder)}` : ''}`;

export const handoffApi = {
  preview: (req: HandoffRequest) => call<HandoffPreview>('POST', '/api/handoffs', req),
  send: (req: HandoffSendRequest) => call<HandoffSendResponse>('POST', '/api/handoffs/send', req),
};

export const memoryApi = {
  get: (scope: MemoryScope, folder?: string | null) => call<MemoryDoc>('GET', memoryQuery(scope, folder)),
  put: (scope: MemoryScope, folder: string | null | undefined, patch: { content?: string; autoPush?: boolean }) =>
    call<MemoryDoc>('PUT', memoryQuery(scope, folder), patch),
  folders: () => call<MemoryDoc[]>('GET', '/api/memory/folders'),
  push: (req: MemoryPushRequest) => call<MemoryPushResponse>('POST', '/api/memory/push', req),
};

// Same rule as the server (memory.ts consoleFolder): worktree agents belong to their repo
export function consoleFolder(c: Pick<ConsoleInfo, 'cwd' | 'git'>): string {
  return c.git?.repoRoot ?? c.cwd;
}

export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const windows = /^[A-Za-z]:/.test(a) || a.includes('\\');
  return windows ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// Consoles that can be typed into right now
export function canType(c: ConsoleInfo): boolean {
  return c.status === 'idle' || c.status === 'resting' || c.status === 'working' || c.status === 'error';
}
