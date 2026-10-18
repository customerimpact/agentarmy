import { create } from 'zustand';
import type {
  ActionItem,
  BoardState,
  BrowserTile,
  ConsoleInfo,
  ConsoleLayout,
  Job,
  Project,
} from '../../shared/protocol';
import { getPrefs } from './prefs';

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

export type SidebarTab = 'agents' | 'actions' | 'progress' | 'settings';

interface BoardStore {
  loaded: boolean;
  consoles: Record<string, ConsoleInfo>;
  jobs: Record<string, Job>;
  actions: Record<string, ActionItem>;
  projects: Record<string, Project>;
  browsers: Record<string, BrowserTile>;
  // Multi-selection (Ctrl/Shift+click, box select). selectedId stays the focused/primary console.
  selectedIds: string[];
  sidebarTab: SidebarTab;
  missionMapOpen: boolean;
  templatesOpen: boolean;
  viewport: Viewport | null;
  selectedId: string | null;
  socketState: SocketState;
  everConnected: boolean;
  sidebarOpen: boolean;
  newAgentOpen: boolean;
  // How many consoles the folder picker creates (1, or 4 for "Spawn 4")
  newAgentCount: number;
  helpOpen: boolean;
  // Settings window (Ctrl+, / sidebar gear). settingsCategory: nav item to show when it opens.
  settingsOpen: boolean;
  settingsCategory: string | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];

  loadState: (state: BoardState) => void;
  upsertJob: (job: Job) => void;
  removeJob: (id: string) => void;
  upsertAction: (action: ActionItem) => void;
  removeActions: (ids: string[]) => void;
  upsertProject: (project: Project) => void;
  removeProject: (id: string) => void;
  upsertBrowser: (browser: BrowserTile) => void;
  removeBrowser: (id: string) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setMissionMapOpen: (open: boolean) => void;
  setTemplatesOpen: (open: boolean) => void;
  upsertConsole: (console: ConsoleInfo) => void;
  removeConsole: (id: string) => void;
  setLayoutLocal: (id: string, layout: Partial<ConsoleLayout>) => void;
  setViewport: (viewport: Viewport) => void;
  select: (id: string | null) => void;
  setSocketState: (state: SocketState) => void;
  setSidebarOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean, count?: number) => void;
  setHelpOpen: (open: boolean) => void;
  openSettings: (category?: string) => void;
  closeSettings: () => void;
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

function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[item.id] = item;
  return out;
}

function without<T>(record: Record<string, T>, ids: string[]): Record<string, T> {
  if (!ids.some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

export const useBoard = create<BoardStore>((set, get) => ({
  loaded: false,
  consoles: {},
  jobs: {},
  actions: {},
  projects: {},
  browsers: {},
  selectedIds: [],
  // Settings is a window now, not a sidebar tab; an old "opens on Settings" pref falls back to Agents
  sidebarTab: getPrefs().defaultSidebarTab === 'settings' ? 'agents' : getPrefs().defaultSidebarTab,
  missionMapOpen: false,
  templatesOpen: false,
  viewport: null,
  selectedId: null,
  socketState: 'connecting',
  everConnected: false,
  sidebarOpen: true,
  newAgentOpen: false,
  newAgentCount: 1,
  helpOpen: false,
  settingsOpen: false,
  settingsCategory: null,
  confirm: null,
  toasts: [],

  loadState: (state) => {
    const prev = get().consoles;
    const consoles: Record<string, ConsoleInfo> = {};
    for (const c of state.consoles) {
      consoles[c.id] = isLayoutLocked(c.id) && prev[c.id] ? { ...c, layout: prev[c.id].layout } : c;
    }
    const selectedId = get().selectedId;
    const prevBrowsers = get().browsers;
    const browsers: Record<string, BrowserTile> = {};
    for (const b of state.browsers ?? []) {
      browsers[b.id] =
        isLayoutLocked(b.id) && prevBrowsers[b.id] ? { ...b, layout: prevBrowsers[b.id].layout } : b;
    }
    set({
      loaded: true,
      consoles,
      jobs: byId(state.jobs ?? []),
      actions: byId(state.actions ?? []),
      projects: byId(state.projects ?? []),
      browsers,
      selectedIds: get().selectedIds.filter((id) => consoles[id] || browsers[id]),
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
      return {
        consoles,
        selectedId: s.selectedId === id ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((x) => x !== id),
      };
    }),

  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  removeJob: (id) => set((s) => ({ jobs: without(s.jobs, [id]) })),
  upsertAction: (action) => set((s) => ({ actions: { ...s.actions, [action.id]: action } })),
  removeActions: (ids) => set((s) => ({ actions: without(s.actions, ids) })),
  upsertProject: (project) => set((s) => ({ projects: { ...s.projects, [project.id]: project } })),
  removeProject: (id) => set((s) => ({ projects: without(s.projects, [id]) })),
  upsertBrowser: (incoming) =>
    set((s) => {
      const prev = s.browsers[incoming.id];
      const next =
        isLayoutLocked(incoming.id) && prev ? { ...incoming, layout: prev.layout } : incoming;
      return { browsers: { ...s.browsers, [incoming.id]: next } };
    }),
  removeBrowser: (id) =>
    set((s) => ({
      browsers: without(s.browsers, [id]),
      selectedIds: s.selectedIds.filter((x) => x !== id),
    })),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  toggleSelected: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  // 'settings' opens the Settings window (old callers keep working)
  setSidebarTab: (sidebarTab) =>
    sidebarTab === 'settings'
      ? set({ settingsOpen: true, settingsCategory: null })
      : set({ sidebarTab, sidebarOpen: true }),
  setMissionMapOpen: (missionMapOpen) => set({ missionMapOpen }),
  setTemplatesOpen: (templatesOpen) => set({ templatesOpen }),

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
  openSettings: (category) => set({ settingsOpen: true, settingsCategory: category ?? null, helpOpen: false }),
  closeSettings: () => set({ settingsOpen: false, settingsCategory: null }),
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
