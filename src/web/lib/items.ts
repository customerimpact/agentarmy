import { create } from 'zustand';
import {
  DEFAULT_WORKSPACE_ID,
  type BoardItem,
  type BoardState,
  type CreateItemRequest,
  type MoveToWorkspaceRequest,
  type UpdateItemRequest,
  type Workspace,
  type WorkspacesState,
} from '../../shared/protocol';
import { ApiError } from './api';
import { getToken } from './auth';
import { isLayoutLocked } from './store';

// Board items (notes, checklists, kanban, files) and workspaces (board tabs). Kept out of the
// main board store so features can grow here without touching it.

interface ItemsStore {
  items: Record<string, BoardItem>;
  workspaces: Workspace[]; // sorted by order
  activeWorkspaceId: string;
  // The tab this window shows. Follows the server's active tab unless the user switched here.
  load: (state: Pick<BoardState, 'items' | 'workspaces' | 'activeWorkspaceId'>) => void;
  upsertItem: (item: BoardItem) => void;
  removeItem: (id: string) => void;
  setWorkspaces: (workspaces: Workspace[], activeWorkspaceId: string) => void;
  setActiveLocal: (id: string) => void;
}

const sortWs = (list: Workspace[]): Workspace[] =>
  [...list].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

const FALLBACK: Workspace = { id: DEFAULT_WORKSPACE_ID, name: 'Main', createdAt: 0, order: 0 };
let loadedOnce = false;

export const useItems = create<ItemsStore>((set, get) => ({
  items: {},
  workspaces: [FALLBACK],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  load: (state) => {
    const prev = get().items;
    const items: Record<string, BoardItem> = {};
    for (const item of state.items ?? []) {
      items[item.id] = isLayoutLocked(item.id) && prev[item.id] ? { ...item, layout: prev[item.id].layout } : item;
    }
    const workspaces = state.workspaces?.length ? sortWs(state.workspaces) : [FALLBACK];
    // First load opens the tab the server remembers; later reloads (reconnects) keep this window's tab
    const active = loadedOnce && workspaces.some((w) => w.id === get().activeWorkspaceId)
      ? get().activeWorkspaceId
      : (state.activeWorkspaceId ?? workspaces[0].id);
    loadedOnce = true;
    set({ items, workspaces, activeWorkspaceId: workspaces.some((w) => w.id === active) ? active : workspaces[0].id });
  },
  upsertItem: (incoming) =>
    set((s) => {
      const prev = s.items[incoming.id];
      const next = isLayoutLocked(incoming.id) && prev ? { ...incoming, layout: prev.layout } : incoming;
      return { items: { ...s.items, [incoming.id]: next } };
    }),
  removeItem: (id) =>
    set((s) => {
      if (!s.items[id]) return s;
      const items = { ...s.items };
      delete items[id];
      return { items };
    }),
  // activeWorkspaceId is only a fallback: each window keeps its own tab while it still exists
  setWorkspaces: (workspaces, activeWorkspaceId) => {
    const sorted = workspaces.length ? sortWs(workspaces) : [FALLBACK];
    const current = get().activeWorkspaceId;
    const active = sorted.some((w) => w.id === current)
      ? current
      : sorted.some((w) => w.id === activeWorkspaceId)
        ? activeWorkspaceId
        : sorted[0].id;
    set({ workspaces: sorted, activeWorkspaceId: active });
  },
  setActiveLocal: (activeWorkspaceId) => set({ activeWorkspaceId }),
}));

// Which workspace something is on (missing = the default one)
export function workspaceOf(x: { workspaceId?: string } | undefined | null): string {
  return x?.workspaceId ?? DEFAULT_WORKSPACE_ID;
}

export function isOnActiveWorkspace(x: { workspaceId?: string } | undefined | null): boolean {
  const { activeWorkspaceId, workspaces } = useItems.getState();
  const ws = workspaceOf(x);
  // Something on a workspace this tab does not know yet: show it on the first tab
  return ws === activeWorkspaceId || (!workspaces.some((w) => w.id === ws) && activeWorkspaceId === workspaces[0]?.id);
}

// ---------- REST ----------

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const itemPath = (id: string) => `/api/items/${encodeURIComponent(id)}`;
const wsPath = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

export const itemsApi = {
  create: (req: CreateItemRequest) => request<BoardItem>('POST', '/api/items', req),
  update: (id: string, req: UpdateItemRequest) => request<BoardItem>('PATCH', itemPath(id), req),
  remove: (id: string) => request<{ ok: true }>('DELETE', itemPath(id)),
  assignCard: (id: string, cardId: string, consoleId: string) =>
    request<BoardItem>('POST', `${itemPath(id)}/cards/${encodeURIComponent(cardId)}/assign`, { consoleId }),
};

export const workspacesApi = {
  list: () => request<WorkspacesState>('GET', '/api/workspaces'),
  create: (req: { name?: string } = {}) => request<Workspace>('POST', '/api/workspaces', req),
  update: (id: string, req: { name?: string; viewport?: { x: number; y: number; zoom: number } }) =>
    request<Workspace>('PATCH', wsPath(id), req),
  remove: (id: string, moveTo?: string) =>
    request<{ ok: true }>('DELETE', wsPath(id), moveTo ? { moveTo } : undefined),
  reorder: (ids: string[]) => request<{ ok: true }>('PUT', '/api/workspaces/order', { ids }),
  setActive: (id: string) => request<{ ok: true }>('PUT', '/api/workspaces/active', { id }),
  move: (id: string, req: MoveToWorkspaceRequest) => request<{ ok: true }>('POST', `${wsPath(id)}/move`, req),
};

// ---------- item edits (optimistic, debounced data saves) ----------

const dataTimers = new Map<string, number>();

// Replace an item's data locally right away and save it shortly after (typing stays smooth)
export function updateItemData(id: string, data: Record<string, unknown>, delayMs = 400): void {
  const item = useItems.getState().items[id];
  if (!item) return;
  useItems.getState().upsertItem({ ...item, data, updatedAt: Date.now() });
  window.clearTimeout(dataTimers.get(id));
  dataTimers.set(
    id,
    window.setTimeout(() => {
      dataTimers.delete(id);
      const latest = useItems.getState().items[id];
      if (!latest) return;
      itemsApi.update(id, { data: latest.data }).catch(() => undefined);
    }, delayMs),
  );
}

// Flush a pending data save now (e.g. before an action that the server applies to the item)
export async function flushItemData(id: string): Promise<void> {
  if (!dataTimers.has(id)) return;
  window.clearTimeout(dataTimers.get(id));
  dataTimers.delete(id);
  const latest = useItems.getState().items[id];
  if (latest) await itemsApi.update(id, { data: latest.data }).catch(() => undefined);
}

// Server echoes for an item with a pending local edit would revert what the user just typed
export function hasPendingData(id: string): boolean {
  return dataTimers.has(id);
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Socket echo of an item: keep local text the user is still typing
export function receiveItem(item: BoardItem): void {
  const local = useItems.getState().items[item.id];
  useItems.getState().upsertItem(hasPendingData(item.id) && local ? { ...item, data: local.data } : item);
}

// What one workspace shows. Things on an unknown workspace show on the first tab.
export function scopeToWorkspace<C extends { workspaceId?: string }, B extends { workspaceId?: string }, P extends { workspaceId?: string }>(
  active: string,
  workspaces: Workspace[],
  consoles: Record<string, C>,
  browsers: Record<string, B>,
  projects: Record<string, P>,
  items: Record<string, BoardItem>,
): { consoles: Record<string, C>; browsers: Record<string, B>; projects: Record<string, P>; items: Record<string, BoardItem> } {
  const known = new Set(workspaces.map((w) => w.id));
  const first = workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
  const on = (x: { workspaceId?: string }): boolean => {
    const ws = x.workspaceId ?? DEFAULT_WORKSPACE_ID;
    return ws === active || (!known.has(ws) && active === first);
  };
  const pick = <T extends { workspaceId?: string }>(record: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [id, x] of Object.entries(record)) if (on(x)) out[id] = x;
    return out;
  };
  return { consoles: pick(consoles), browsers: pick(browsers), projects: pick(projects), items: pick(items) };
}
