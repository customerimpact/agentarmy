import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, Columns3, ListChecks, Plus, StickyNote, Terminal, type LucideIcon } from 'lucide-react';
import type { BoardItemKind } from '../../../shared/protocol';
import { createBoardItem } from '../../lib/item-actions';
import { useBoard } from '../../lib/store';

const KINDS: { kind: BoardItemKind; label: string; icon: LucideIcon; hint: string; keys?: string }[] = [
  { kind: 'note', label: 'Note', icon: StickyNote, hint: 'Sticky note with simple markdown', keys: 'Shift+N' },
  { kind: 'checklist', label: 'Checklist', icon: ListChecks, hint: 'Tick items off, send the rest to an agent' },
  { kind: 'kanban', label: 'Kanban', icon: Columns3, hint: 'Cards you can assign to agents' },
];

function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, ignore?: string): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (ref.current?.contains(target) || (ignore && target.closest?.(ignore))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, onClose, ignore]);
}

function MenuList({ onPick, withAgent }: { onPick: (kind: BoardItemKind | 'agent') => void; withAgent?: boolean }) {
  return (
    <ul className="flex flex-col">
      {withAgent && (
        <li>
          <button
            type="button"
            data-testid="add-here-agent"
            onClick={() => onPick('agent')}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
          >
            <Terminal size={15} className="shrink-0 text-accent" />
            <span className="flex-1 font-medium text-fg">Agent</span>
            <span className="font-mono text-[10px] text-fg-subtle">N</span>
          </button>
        </li>
      )}
      {KINDS.map(({ kind, label, icon: Icon, hint, keys }) => (
        <li key={kind}>
          <button
            type="button"
            data-testid={`add-${kind}`}
            onClick={() => onPick(kind)}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
          >
            <Icon size={15} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-fg">{label}</span>
              <span className="block text-[11px] text-fg-subtle">{hint}</span>
            </span>
            {keys && <span className="mt-0.5 font-mono text-[10px] text-fg-subtle">{keys}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Toolbar "Add" menu: note, checklist, kanban at the center of the view
export function AddItemButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), '[data-add-toggle]');
  return (
    <div className="relative">
      <button
        type="button"
        data-add-toggle
        data-testid="add-item-button"
        aria-expanded={open}
        title="Add a note, checklist or kanban board"
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 font-semibold text-fg-muted shadow-lg shadow-black/20
                   hover:bg-hover hover:text-fg"
      >
        <Plus size={14} />
        Add
        <ChevronDown size={13} className="text-fg-subtle" />
      </button>
      {open && (
        <div
          ref={ref}
          role="menu"
          className="absolute top-full right-0 z-20 mt-2 w-72 rounded-xl border border-line-strong bg-elevated p-1.5 text-[12.5px] shadow-2xl shadow-black/40"
        >
          <MenuList
            onPick={(kind) => {
              setOpen(false);
              if (kind !== 'agent') void createBoardItem(kind);
            }}
          />
        </div>
      )}
    </div>
  );
}

// Double-click on the empty board: add something right there
export function AddHerePopover({
  screen,
  at,
  onClose,
}: {
  screen: { x: number; y: number };
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const left = Math.min(screen.x, window.innerWidth - 300);
  const top = Math.min(screen.y, window.innerHeight - 260);
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="add-here-popover"
      className="fixed z-40 w-72 rounded-xl border border-line-strong bg-elevated p-1.5 text-[12.5px] shadow-2xl shadow-black/40"
      style={{ left, top }}
    >
      <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">Add here</div>
      <MenuList
        withAgent
        onPick={(kind) => {
          onClose();
          if (kind === 'agent') useBoard.getState().setNewAgentOpen(true);
          else void createBoardItem(kind, { at });
        }}
      />
    </div>
  );
}
