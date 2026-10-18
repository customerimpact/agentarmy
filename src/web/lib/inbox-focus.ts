import { create } from 'zustand';
import type { ActionItem } from '../../shared/protocol';
import { flyTo } from './board-actions';
import { useBoard } from './store';

// Which Actions item to scroll to and focus (set by a notification click). The panel clears it.

interface InboxFocus {
  id: string | null;
  seq: number; // bumps on every request, so clicking the same item twice still focuses it
  focus: (id: string) => void;
  clear: () => void;
}

export const useInboxFocus = create<InboxFocus>((set) => ({
  id: null,
  seq: 0,
  focus: (id) => set((s) => ({ id, seq: s.seq + 1 })),
  clear: () => set({ id: null }),
}));

// The open item that can be answered from the inbox for this console, if any
export function answerableAction(consoleId: string): ActionItem | undefined {
  return Object.values(useBoard.getState().actions).find(
    (a) => a.consoleId === consoleId && !a.resolvedAt && !!a.options?.length && (a.kind === 'needs_you' || a.kind === 'stuck'),
  );
}

// Notification click: open the Actions item when it has answer buttons, else fly to the console
export function openAttention(consoleId: string | null): void {
  const item = consoleId ? answerableAction(consoleId) : undefined;
  if (item) {
    useBoard.getState().setSidebarTab('actions');
    useInboxFocus.getState().focus(item.id);
  } else if (consoleId) void flyTo(consoleId);
  else useBoard.getState().setSidebarTab('actions');
}
