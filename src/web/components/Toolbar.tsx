import { useEffect, useRef } from 'react';
import { CircleQuestionMark, Maximize2, Plus } from 'lucide-react';
import { fitAll } from '../lib/board-actions';
import { useBoard } from '../lib/store';
import { ArrangeMenu } from './ArrangeMenu';
import { KillButton } from './KillButton';

const SHORTCUTS: { keys: string[]; label: string; note?: string }[] = [
  { keys: ['N'], label: 'New agent' },
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
  { keys: ['Alt', 'Drag'], label: 'Move without snapping' },
  { keys: ['?'], label: 'Show this help' },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="min-w-5 rounded border border-line-strong bg-surface-2 px-1.5 py-px text-center font-mono text-[10px] text-fg-muted">
      {children}
    </kbd>
  );
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
  const buttonClass = `grid size-8 place-items-center rounded-lg border border-line bg-surface text-fg-muted shadow-lg shadow-black/20
                       hover:bg-hover hover:text-fg`;

  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
      <button
        type="button"
        data-testid="new-agent-button"
        onClick={() => setNewAgentOpen(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 font-semibold text-accent-fg shadow-lg shadow-black/20
                   hover:brightness-110"
      >
        <Plus size={15} />
        New agent
      </button>
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
  );
}
