import { useEffect } from 'react';
import { arrangeBoard, askKill, clearSelection, fitAll, flyTo, selectAll, switchWorkspace } from './board-actions';
import { createBoardItem } from './item-actions';
import { useItems } from './items';
import { useBoardUi } from './board-ui';
import { spatialOrder, useBoard } from './store';
import { pauseAll } from './loops';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function cycle(direction: 1 | -1, onlyNeedsYou = false): void {
  const { consoles, selectedId } = useBoard.getState();
  const ordered = spatialOrder(consoles);
  if (!ordered.length) return;
  const count = ordered.length;
  const current = ordered.findIndex((c) => c.id === selectedId);
  // With nothing selected, "next" starts at the first console and "previous" at the last
  const start = current === -1 ? (direction === 1 ? -1 : count) : current;
  for (let step = 1; step <= count; step++) {
    const candidate = ordered[(((start + direction * step) % count) + count) % count];
    if (!onlyNeedsYou || candidate.status === 'needs_you') {
      void flyTo(candidate.id);
      return;
    }
  }
}

// Workspace tabs: by position (0-based) or relative to the active one
function goToWorkspace(index: number): void {
  const ws = useItems.getState().workspaces[index];
  if (ws) void switchWorkspace(ws.id);
}

function cycleWorkspace(direction: 1 | -1): void {
  const { workspaces, activeWorkspaceId } = useItems.getState();
  if (workspaces.length < 2) return;
  const at = workspaces.findIndex((w) => w.id === activeWorkspaceId);
  goToWorkspace((at + direction + workspaces.length) % workspaces.length);
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useBoard.getState();
      const modalOpen = state.newAgentOpen || state.confirm !== null || state.settingsOpen;

      // Alt combos work everywhere, including inside terminals. code (not key) keeps them
      // layout independent; AltGr reports ctrl+alt on Windows and is excluded.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !modalOpen) {
        if (e.code === 'BracketRight' || e.code === 'BracketLeft' || e.code === 'KeyJ') {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'KeyJ') cycle(1, true);
          else cycle(e.code === 'BracketRight' ? 1 : -1);
          return;
        }
      }

      // Alt+1..9 switches workspace everywhere (terminals keep Ctrl+digits)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !modalOpen && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        goToWorkspace(Number(e.code.slice(5)) - 1);
        return;
      }

      if (modalOpen || isTypingTarget(e.target)) return;

      // Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+1..9: workspaces (in the app window; browsers may keep them)
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') {
        e.preventDefault();
        cycleWorkspace(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        goToWorkspace(Number(e.code.slice(5)) - 1);
        return;
      }

      const commandKey = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
      if (commandKey || (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('[data-testid="command-bar-input"]')?.focus();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }

      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        useBoardUi.getState().setGroupPromptOpen(false);
        if (state.selectedIds.length) clearSelection();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Delete with the board focused (terminals keep their own Delete key: see isTypingTarget)
      if (e.key === 'Delete' && !e.shiftKey) {
        e.preventDefault();
        askKill();
        return;
      }

      if (e.key === 'P' && e.shiftKey) {
        e.preventDefault();
        void pauseAll();
      } else if (e.key === 'A' && e.shiftKey) {
        e.preventDefault();
        arrangeBoard('grid');
      } else if ((e.key === 'g' || e.key === 'G') && !e.shiftKey) {
        if (state.selectedIds.some((id) => state.consoles[id])) {
          e.preventDefault();
          useBoardUi.getState().setGroupPromptOpen(true);
        }
      } else if (e.key === 'N' && e.shiftKey) {
        e.preventDefault();
        void createBoardItem('note');
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        state.setNewAgentOpen(true);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        fitAll();
      } else if (e.key === '?') {
        e.preventDefault();
        state.setHelpOpen(!state.helpOpen);
      }
    };
    // Capture phase so we see Alt combos before xterm's textarea handler does
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
