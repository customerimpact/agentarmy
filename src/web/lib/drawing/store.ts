import { create } from 'zustand';
import { DEFAULT_SHAPE_STYLE, type DrawingOps, type Shape, type ShapeStyle } from '../../../shared/drawings';
import { getToken } from '../auth';
import { getDrawVoicePrefs } from '../draw-voice-prefs';
import { useItems } from '../items';
import { useBoard } from '../store';
import { applyChanges, DrawingHistory, type HistoryEntry, type ShapeChange } from './history';

// Drawings on the board: local state, undo/redo and a debounced sync to the server
// (POST /api/drawings/ops). Other tabs and pop-outs get the changes through the 'drawings' socket message.

export type DrawTool = 'select' | 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'eraser';
export const DRAW_TOOLS: DrawTool[] = ['select', 'pen', 'line', 'arrow', 'rect', 'ellipse', 'text', 'eraser'];

const SYNC_DEBOUNCE_MS = 250;
const RETRY_MS = 3000;

// This tab's id: the server echoes it so we skip our own broadcasts
export const TAB_ID = `tab_${Math.random().toString(36).slice(2, 12)}`;

interface DrawingsStore {
  shapes: Record<string, Shape>;
  selected: string[];
  active: boolean; // draw mode
  tool: DrawTool;
  style: ShapeStyle; // style for new shapes
  editingTextId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  syncError: string | null;

  setActive: (active: boolean) => void;
  setTool: (tool: DrawTool) => void;
  setStyle: (patch: Partial<ShapeStyle>) => void; // also restyles the selection (one undo step)
  select: (ids: string[]) => void;
  setEditingText: (id: string | null) => void;
  // Local-only preview while a gesture runs (no history, no sync)
  preview: (shapes: Shape[]) => void;
  // One user action: applied, recorded for undo and synced
  commit: (changes: ShapeChange[]) => void;
  removeSelected: () => void;
  undo: () => void;
  redo: () => void;
  applyRemote: (upsert: Shape[], remove: string[], origin?: string) => void;
  replaceAll: (shapes: Shape[]) => void;
}

const history = new DrawingHistory();
const dirty = new Map<string, Shape | null>(); // pending sync: shape or null = remove
let flushTimer: number | null = null;
let inFlight = false;

let idSeq = 0;
export function newShapeId(): string {
  idSeq += 1;
  return `sh_${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function activeWorkspaceId(): string {
  return useItems.getState().activeWorkspaceId;
}

export function nextZ(): number {
  let max = 0;
  for (const s of Object.values(useDrawings.getState().shapes)) if (s.z > max) max = s.z;
  return max + 1;
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getToken();
  if (token) h['x-agentarmy-token'] = token;
  if (json) h['content-type'] = 'application/json';
  return h;
}

function scheduleFlush(delay = SYNC_DEBOUNCE_MS): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

async function flush(): Promise<void> {
  if (inFlight || !dirty.size) return;
  const batch = new Map(dirty);
  dirty.clear();
  const ops: DrawingOps = { upsert: [], remove: [], origin: TAB_ID };
  for (const [id, shape] of batch) {
    if (shape) ops.upsert!.push(shape);
    else ops.remove!.push(id);
  }
  inFlight = true;
  try {
    const res = await fetch('/api/drawings/ops', { method: 'POST', credentials: 'same-origin', headers: headers(true), body: JSON.stringify(ops) });
    if (res.status === 400) {
      // The server refused the batch (invalid or over the limit): don't retry it forever
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      useDrawings.setState({ syncError: data.error ?? 'Drawing not saved' });
      useBoard.getState().toast(`Drawing not saved: ${data.error ?? 'rejected by the server'}`);
    } else if (!res.ok) {
      throw new Error(String(res.status));
    } else {
      useDrawings.setState({ syncError: null });
    }
  } catch {
    // Offline or server restarting: put the batch back (newer local edits win) and retry
    for (const [id, shape] of batch) if (!dirty.has(id)) dirty.set(id, shape);
    useDrawings.setState({ syncError: 'Drawings not saved yet (offline?)' });
    inFlight = false;
    scheduleFlush(RETRY_MS);
    return;
  }
  inFlight = false;
  if (dirty.size) scheduleFlush();
}

function markDirty(changes: ShapeChange[]): void {
  for (const c of changes) dirty.set(c.id, c.after);
  scheduleFlush();
}

// Saves pending changes right away (page hide / tests)
export function flushDrawingsNow(): Promise<void> {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flush();
}

export function hasPendingDrawings(): boolean {
  return dirty.size > 0 || inFlight;
}

const syncHistoryFlags = () => ({ canUndo: history.canUndo, canRedo: history.canRedo });

export const useDrawings = create<DrawingsStore>((set, get) => ({
  shapes: {},
  selected: [],
  active: false,
  tool: 'pen',
  style: { ...DEFAULT_SHAPE_STYLE, color: getDrawVoicePrefs().drawColor },
  editingTextId: null,
  canUndo: false,
  canRedo: false,
  syncError: null,

  setActive: (active) => set(active ? { active } : { active, editingTextId: null }),
  setTool: (tool) => set({ tool, active: true, ...(tool !== 'select' ? { selected: [] } : {}) }),
  setStyle: (patch) => {
    const style = { ...get().style, ...patch };
    set({ style });
    const { selected, shapes } = get();
    const now = Date.now();
    const changes: ShapeChange[] = selected
      .filter((id) => shapes[id])
      .map((id) => ({ id, before: shapes[id], after: { ...shapes[id], style: { ...shapes[id].style, ...patch }, updatedAt: now } }));
    if (changes.length) get().commit(changes);
  },
  select: (ids) => {
    const prev = get().selected;
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return;
    set({ selected: ids });
  },
  setEditingText: (editingTextId) => set({ editingTextId }),

  preview: (list) =>
    set((s) => {
      const shapes = { ...s.shapes };
      for (const shape of list) shapes[shape.id] = shape;
      return { shapes };
    }),

  commit: (changes) => {
    const real = changes.filter((c) => c.before !== c.after);
    if (!real.length) return;
    history.push(real);
    set((s) => ({
      shapes: applyChanges(s.shapes, real),
      selected: s.selected.filter((id) => real.every((c) => c.id !== id || c.after)),
      ...syncHistoryFlags(),
    }));
    markDirty(real);
  },

  removeSelected: () => {
    const { selected, shapes } = get();
    const changes = selected.filter((id) => shapes[id]).map((id) => ({ id, before: shapes[id], after: null }));
    if (changes.length) get().commit(changes);
    set({ selected: [] });
  },

  undo: () => {
    const entry = history.undo();
    if (entry) applyHistory(entry);
  },
  redo: () => {
    const entry = history.redo();
    if (entry) applyHistory(entry);
  },

  applyRemote: (upsert, remove, origin) => {
    if (origin === TAB_ID) return;
    set((s) => {
      const shapes = { ...s.shapes };
      for (const shape of upsert) if (!dirty.has(shape.id)) shapes[shape.id] = shape;
      for (const id of remove) if (!dirty.has(id)) delete shapes[id];
      return { shapes, selected: s.selected.filter((id) => shapes[id]) };
    });
  },

  // Full reload from the server (initial load, socket reconnect); unsaved local edits are kept
  replaceAll: (list) =>
    set((s) => {
      const shapes: Record<string, Shape> = {};
      for (const shape of list) shapes[shape.id] = shape;
      for (const [id, pending] of dirty) {
        if (pending) shapes[id] = pending;
        else delete shapes[id];
      }
      return { shapes, selected: s.selected.filter((id) => shapes[id]) };
    }),
}));

function applyHistory(entry: HistoryEntry): void {
  useDrawings.setState((s) => ({
    shapes: applyChanges(s.shapes, entry),
    selected: s.selected.filter((id) => entry.every((c) => c.id !== id || c.after)),
    editingTextId: null,
    ...syncHistoryFlags(),
  }));
  markDirty(entry);
}

export async function loadDrawings(): Promise<void> {
  try {
    const res = await fetch('/api/drawings', { credentials: 'same-origin', headers: headers(false) });
    if (!res.ok) return;
    const data = (await res.json()) as { shapes?: Shape[] };
    useDrawings.getState().replaceAll(Array.isArray(data.shapes) ? data.shapes : []);
  } catch {
    // offline: the next socket reconnect reloads
  }
}

// Test hook: forget history and pending sync (unit tests)
export function resetDrawingsForTests(): void {
  history.clear();
  dirty.clear();
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = null;
  inFlight = false;
  useDrawings.setState({ shapes: {}, selected: [], canUndo: false, canRedo: false, active: false, editingTextId: null });
}

// Image URL with auth for <image href>: the per-run token rides in the query (the cookie also works)
export function imageUrl(imageId: string): string {
  const token = getToken();
  return `/api/images/${encodeURIComponent(imageId)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
