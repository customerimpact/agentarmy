import { useEffect, useRef } from 'react';
import { CircleQuestionMark, Maximize2, Plus, Share2 } from 'lucide-react';
import { fitAll } from '../lib/board-actions';
import { useBoard } from '../lib/store';
import { ArrangeMenu } from './ArrangeMenu';
import { KillButton } from './KillButton';
import { AddItemButton } from './items/AddItemMenu';
import { WorkspaceTabs } from './WorkspaceTabs';

const SHORTCUTS: { keys: string[]; label: string; note?: string }[] = [
  { keys: ['N'], label: 'New agent' },
  { keys: ['Shift', 'N'], label: 'New note', note: 'double-click the empty board to add anything there' },
  { keys: ['Ctrl', 'Tab'], label: 'Next workspace', note: 'Ctrl+Shift+Tab: previous' },
  { keys: ['Ctrl', '1-9'], label: 'Go to workspace 1-9', note: 'Alt+1-9 while a terminal has focus' },
  { keys: ['F'], label: 'Fit all consoles' },
  { keys: ['/'], label: 'Focus the command bar', note: 'or Ctrl+K' },
  {
    keys: ['@'],
    label: 'Pick the target in the command bar',
    note: '@all sends to every ready agent',
  },
  { keys: ['Alt', ']'], label: 'Focus next console', note: 'also inside terminals' },
  { keys: ['Alt', '['], label: 'Focus previous console', note: 'also inside terminals' },
  { keys: ['Alt', 'J'], label: 'Jump to next "needs you"', note: 'also inside terminals' },
  { keys: ['Ctrl', 'Wheel'], label: 'Zoom the board over a terminal' },
  { keys: ['Ctrl', 'Click'], label: 'Add or remove a console from the selection' },
  { keys: ['Shift', 'Drag'], label: 'Box-select on the empty board' },
  { keys: ['Ctrl', 'A'], label: 'Select everything on the board' },
  { keys: ['Esc'], label: 'Clear the selection' },
  { keys: ['G'], label: 'Group the selection as a project' },
  { keys: ['Del'], label: 'Kill the selection', note: 'asks first; conversations stay resumable' },
  { keys: ['Shift', 'A'], label: 'Arrange in a grid', note: 'the selection, or everything' },
  { keys: ['Shift', 'P'], label: 'Pause all working agents', note: 'Resume all in the command bar' },
  { keys: ['Alt', 'Drag'], label: 'Move without snapping' },
  { keys: ['D'], label: 'Draw and annotate', note: 'tools: V P L A R O T E · Ctrl+Z undo · Esc leaves' },
  { keys: ['Alt', 'V'], label: 'Dictate into the command bar', note: 'or hold Space in the empty command bar' },
  { keys: ['?'], label: 'Show this help' },
];

function Kbd({ children }: { children: string }) {
  return <kbd className="aa-kbd">{children}</kbd>;
}

function HelpPopover() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.('[data-help-toggle]')) {
        useBoard.getState().setHelpOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useBoard.getState().setHelpOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="absolute top-full right-0 mt-2 w-80 rounded-xl border border-line-strong bg-elevated p-3 shadow-2xl shadow-black/40"
    >
      <div className="px-1 pb-2 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
        Keyboard shortcuts
      </div>
      <ul className="aa-scroll flex max-h-[65vh] flex-col gap-1.5 overflow-y-auto">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex items-center gap-2 px-1">
            <span className="flex-1 text-fg">
              {s.label}
              {s.note && <span className="block text-[11px] text-fg-subtle">{s.note}</span>}
            </span>
            <span className="flex gap-1">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line px-1 pt-2 text-[11px] leading-relaxed text-fg-subtle">
        Single-letter shortcuts work when no terminal has focus. Click the empty board to leave a
        terminal.
      </p>
    </div>
  );
}

export function Toolbar() {
  const helpOpen = useBoard((s) => s.helpOpen);
  // With 2+ selected, the selection bar shows the Kill button instead
  const multiSelect = useBoard((s) => s.selectedIds.length >= 2);
  const { setNewAgentOpen, setHelpOpen } = useBoard.getState();
  const buttonClass = `grid size-7 place-items-center rounded-md border border-line bg-surface text-fg-muted
                       hover:border-line-strong hover:bg-hover hover:text-fg`;

  return (
    // Workspace tabs on the left, actions on the right; the gap between them stays click-through
    <div className="pointer-events-none absolute top-3 right-3 left-14 z-10 flex items-center gap-3">
      <div className="pointer-events-auto min-w-0 flex-1">
        <WorkspaceTabs />
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
      {/* Presence + sharing: who else is looking at this board (coming with shared boards) */}
      <div data-testid="presence-slot" className="flex items-center gap-1.5 pr-1.5">
        <button
          type="button"
          data-testid="share-button"
          disabled
          title="Share this board · coming soon"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-fg-subtle
                     disabled:cursor-not-allowed"
        >
          <Share2 size={13} />
          Share
        </button>
        <span aria-hidden className="h-4 w-px bg-line" />
      </div>
      <button
        type="button"
        data-testid="new-agent-button"
        onClick={() => setNewAgentOpen(true)}
        className="aa-btn-primary inline-flex h-7 items-center gap-1.5 rounded-md pr-1.5 pl-2.5 text-[12px] font-semibold"
      >
        <Plus size={14} />
        New agent
        <kbd className="ml-0.5 grid h-4 min-w-4 place-items-center rounded-[3px] bg-black/15 px-1 font-mono text-[9.5px] font-medium">N</kbd>
      </button>
      <AddItemButton />
      <ArrangeMenu />
      {!multiSelect && <KillButton />}
      <button
        type="button"
        title="Fit all (F)"
        aria-label="Fit all"
        onClick={fitAll}
        className={buttonClass}
      >
        <Maximize2 size={14} />
      </button>
      <div className="relative">
        <button
          type="button"
          data-help-toggle
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen(!helpOpen)}
          className={buttonClass}
        >
          <CircleQuestionMark size={15} />
        </button>
        {helpOpen && <HelpPopover />}
      </div>
      </div>
    </div>
  );
}
