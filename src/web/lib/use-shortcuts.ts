import { useEffect } from 'react';
import { fitAll, flyTo } from './board-actions';
import { spatialOrder, useBoard } from './store';

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

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useBoard.getState();
      const modalOpen = state.newAgentOpen || state.confirm !== null;

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

      if (modalOpen || isTypingTarget(e.target)) return;

      const commandKey = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
      if (commandKey || (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('[data-testid="command-bar-input"]')?.focus();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'n' || e.key === 'N') {
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
