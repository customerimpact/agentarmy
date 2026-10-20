import { create } from 'zustand';
import type { ShareCursorEvent, ShareStatus } from '../../shared/protocol';
import { request } from './api';

// Live sharing (src/server/share): share links, who is watching, and their pointers on this board

export const shareApi = {
  status: () => request<ShareStatus>('GET', '/api/share'),
  create: (title: string, expiresInHours?: number) =>
    request<ShareStatus>('POST', '/api/share', { title, ...(expiresInHours ? { expiresInHours } : {}) }),
  revoke: (id: string) => request<ShareStatus>('DELETE', `/api/share/${encodeURIComponent(id)}`),
  cursor: (c: { x: number; y: number; vx: number; vy: number; vz: number } | null) =>
    request<{ ok: true }>('POST', '/api/share/cursor', { c }),
};

interface ShareState {
  status: ShareStatus | null;
  cursors: Record<string, ShareCursorEvent>; // guest dev -> last pointer
  dialogOpen: boolean;
  load: () => Promise<void>;
  receive: (status: ShareStatus) => void;
  cursor: (event: ShareCursorEvent) => void;
  setDialogOpen: (open: boolean) => void;
}

export const useShare = create<ShareState>((set) => ({
  status: null,
  cursors: {},
  dialogOpen: false,
  load: async () => {
    try {
      set({ status: await shareApi.status() });
    } catch {
      // older server
    }
  },
  receive: (status) =>
    set((s) => {
      // Pointers of guests who left disappear
      const online = new Set(status.shares.flatMap((sh) => sh.guests.map((g) => g.dev)));
      return { status, cursors: Object.fromEntries(Object.entries(s.cursors).filter(([dev]) => online.has(dev))) };
    }),
  cursor: (event) =>
    set((s) => {
      const cursors = { ...s.cursors };
      if (event.c) cursors[event.dev] = event;
      else delete cursors[event.dev];
      return { cursors };
    }),
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
}));

export function guestsOnline(status: ShareStatus | null): { dev: string; name: string; color: string }[] {
  const seen = new Map<string, { dev: string; name: string; color: string }>();
  for (const share of status?.shares ?? []) for (const g of share.guests) seen.set(g.dev, g);
  return [...seen.values()];
}

// Our own pointer goes out only while someone is watching, at most ~15 times a second
let lastSent = 0;
export function sendOwnCursor(c: { x: number; y: number; vx: number; vy: number; vz: number } | null): void {
  if (guestsOnline(useShare.getState().status).length === 0) return;
  const now = performance.now();
  if (c && now - lastSent < 66) return;
  lastSent = now;
  void shareApi.cursor(c).catch(() => undefined);
}
