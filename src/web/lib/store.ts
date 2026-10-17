import { create } from 'zustand';
import type { BoardState, ConsoleInfo, ConsoleLayout } from '../../shared/protocol';

export type Viewport = { x: number; y: number; zoom: number };
export type SocketState = 'connecting' | 'open' | 'closed';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  message: string;
}

interface BoardStore {
  loaded: boolean;
  consoles: Record<string, ConsoleInfo>;
  viewport: Viewport | null;
  selectedId: string | null;
  socketState: SocketState;
  everConnected: boolean;
  sidebarOpen: boolean;
  newAgentOpen: boolean;
  // How many consoles the folder picker creates (1, or 4 for "Spawn 4")
  newAgentCount: number;
  helpOpen: boolean;
  confirm: ConfirmRequest | null;
  toasts: Toast[];

  loadState: (state: BoardState) => void;
  upsertConsole: (console: ConsoleInfo) => void;
  removeConsole: (id: string) => void;
  setLayoutLocal: (id: string, layout: Partial<ConsoleLayout>) => void;
  setViewport: (viewport: Viewport) => void;
  select: (id: string | null) => void;
  setSocketState: (state: SocketState) => void;
  setSidebarOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean, count?: number) => void;
  setHelpOpen: (open: boolean) => void;
  askConfirm: (request: ConfirmRequest | null) => void;
  toast: (message: string) => void;
  dismissToast: (id: number) => void;
}

// Ids whose layout the user is dragging/resizing right now; server echoes must not yank them back
const layoutLocks = new Set<string>();
export const lockLayout = (id: string) => layoutLocks.add(id);
export const unlockLayout = (id: string) => layoutLocks.delete(id);
export const isLayoutLocked = (id: string) => layoutLocks.has(id);

let toastSeq = 0;

export const useBoard = create<BoardStore>((set, get) => ({
  loaded: false,
  consoles: {},
  viewport: null,
  selectedId: null,
  socketState: 'connecting',
  everConnected: false,
  sidebarOpen: true,
  newAgentOpen: false,
  newAgentCount: 1,
  helpOpen: false,
  confirm: null,
  toasts: [],

  loadState: (state) => {
    const prev = get().consoles;
    const consoles: Record<string, ConsoleInfo> = {};
    for (const c of state.consoles) {
      consoles[c.id] = isLayoutLocked(c.id) && prev[c.id] ? { ...c, layout: prev[c.id].layout } : c;
    }
    const selectedId = get().selectedId;
    set({
      loaded: true,
      consoles,
      viewport: get().loaded ? get().viewport : (state.viewport ?? null),
      selectedId: selectedId && consoles[selectedId] ? selectedId : null,
    });
  },

  upsertConsole: (incoming) =>
    set((s) => {
      const prev = s.consoles[incoming.id];
      const next =
        isLayoutLocked(incoming.id) && prev ? { ...incoming, layout: prev.layout } : incoming;
      return { consoles: { ...s.consoles, [incoming.id]: next } };
    }),

  removeConsole: (id) =>
    set((s) => {
      if (!s.consoles[id]) return s;
      const consoles = { ...s.consoles };
      delete consoles[id];
      return { consoles, selectedId: s.selectedId === id ? null : s.selectedId };
    }),

  setLayoutLocal: (id, layout) =>
    set((s) => {
      const prev = s.consoles[id];
      if (!prev) return s;
      return {
        consoles: { ...s.consoles, [id]: { ...prev, layout: { ...prev.layout, ...layout } } },
      };
    }),

  setViewport: (viewport) => set({ viewport }),
  select: (id) => {
    if (get().selectedId !== id) set({ selectedId: id });
  },
  setSocketState: (socketState) =>
    set((s) => ({ socketState, everConnected: s.everConnected || socketState === 'open' })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setNewAgentOpen: (newAgentOpen, newAgentCount = 1) =>
    set({ newAgentOpen, newAgentCount, helpOpen: false }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  askConfirm: (confirm) => set({ confirm }),
  toast: (message) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    window.setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Shared 1s clock so every "time in status" label ticks together with a single interval
export const useClock = create<{ now: number }>(() => ({ now: Date.now() }));
window.setInterval(() => useClock.setState({ now: Date.now() }), 1000);

export function consoleList(consoles: Record<string, ConsoleInfo>): ConsoleInfo[] {
  return Object.values(consoles).sort((a, b) => a.createdAt - b.createdAt);
}

// Reading order on the board (rows, then left to right) for keyboard cycling
export function spatialOrder(consoles: Record<string, ConsoleInfo>): ConsoleInfo[] {
  return Object.values(consoles).sort((a, b) => {
    const rowA = Math.round(a.layout.y / 200);
    const rowB = Math.round(b.layout.y / 200);
    return rowA - rowB || a.layout.x - b.layout.x || a.createdAt - b.createdAt;
  });
}
