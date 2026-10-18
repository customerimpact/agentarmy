import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Columns3,
  FolderKanban,
  Layers,
  LayoutGrid,
  Magnet,
  Rows3,
  Scaling,
} from 'lucide-react';
import { GAP_OPTIONS, type ArrangeMode, type ColumnsSetting, type SizePreset } from '../lib/arrange';
import { arrangeBoard, makeSameSize } from '../lib/board-actions';
import { useBoardUi } from '../lib/board-ui';
import { useBoard } from '../lib/store';

const MODES: { mode: ArrangeMode; label: string; icon: ReactNode; hint?: string }[] = [
  { mode: 'grid', label: 'Grid', icon: <LayoutGrid size={14} />, hint: 'Shift+A' },
  { mode: 'row', label: 'Row', icon: <Columns3 size={14} /> },
  { mode: 'column', label: 'Column', icon: <Rows3 size={14} /> },
  { mode: 'stack', label: 'Stack', icon: <Layers size={14} /> },
  { mode: 'project', label: 'Tidy by project', icon: <FolderKanban size={14} /> },
];

const COLUMNS: ColumnsSetting[] = [2, 3, 4, 'auto'];
const SIZES: SizePreset[] = ['S', 'M', 'L'];

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  format = String,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  format?: (value: T) => string;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className="w-16 text-[11px] text-fg-subtle">{label}</span>
      <div className="flex flex-1 rounded-md border border-line bg-surface p-0.5">
        {options.map((option) => (
          <button
            key={String(option)}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChange(option)}
            className={`flex-1 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums
                        ${option === value ? 'bg-hover text-fg' : 'text-fg-muted hover:text-fg'}`}
          >
            {format(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ArrangePopover({ align, onClose }: { align: 'left' | 'right' | 'center'; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const prefs = useBoardUi((s) => s.prefs);
  const selectedCount = useBoard((s) => s.selectedIds.length);
  const { setPrefs } = useBoardUi.getState();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.('[data-arrange-toggle]')) onClose();
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
  }, [onClose]);

  const position =
    align === 'right' ? 'right-0' : align === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2';
  const scope = selectedCount >= 2 ? `the ${selectedCount} selected` : 'everything on the board';

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="arrange-menu"
      className={`absolute top-full mt-2 w-64 rounded-xl border border-line-strong bg-elevated p-1.5 text-fg shadow-2xl shadow-black/40 ${position}`}
    >
      <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
        Arrange {scope}
      </div>
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="menuitem"
          data-testid={`arrange-${m.mode}`}
          onClick={() => {
            arrangeBoard(m.mode);
            onClose();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left
                     hover:bg-hover"
        >
          <span className="text-fg-subtle">{m.icon}</span>
          {m.label}
          {m.hint && <span className="ml-auto font-mono text-[10px] text-fg-subtle">{m.hint}</span>}
        </button>
      ))}
      <div className="my-1.5 border-t border-line" />
      <Segmented
        label="Columns"
        value={prefs.columns}
        options={COLUMNS}
        onChange={(columns) => setPrefs({ columns })}
        format={(v) => (v === 'auto' ? 'Auto' : String(v))}
      />
      <Segmented
        label="Gap"
        value={prefs.gap}
        options={GAP_OPTIONS}
        onChange={(gap) => setPrefs({ gap })}
      />
      <div className="my-1.5 border-t border-line" />
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="w-16 text-[11px] text-fg-subtle">Same size</span>
        <div className="flex flex-1 gap-1">
          <button
            type="button"
            data-testid="same-size-common"
            title="Match the most common size"
            onClick={() => {
              setPrefs({ size: 'common' });
              makeSameSize();
            }}
            className="flex-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted
                       hover:text-fg"
          >
            Match
          </button>
          {SIZES.map((size) => (
            <button
              key={size}
              type="button"
              data-testid={`same-size-${size}`}
              onClick={() => {
                setPrefs({ size });
                makeSameSize(size);
              }}
              className={`w-7 rounded-md border px-1.5 py-0.5 text-[11px] font-medium
                          hover:text-fg
                          ${prefs.size === size ? 'border-line-strong bg-hover text-fg' : 'border-line bg-surface text-fg-muted'}`}
            >
              {size}
            </button>
          ))}
        </div>
      </div>
      <div className="my-1.5 border-t border-line" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={prefs.snap}
        onClick={() => setPrefs({ snap: !prefs.snap })}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left
                   hover:bg-hover"
      >
        <Magnet size={14} className="text-fg-subtle" />
        Snap while dragging
        <span
          className={`ml-auto h-4 w-7 rounded-full p-0.5 transition-colors ${prefs.snap ? 'bg-accent' : 'bg-line-strong'}`}
        >
          <span
            className={`block size-3 rounded-full bg-white transition-transform ${prefs.snap ? 'translate-x-3' : ''}`}
          />
        </span>
      </button>
      <p className="px-2 pt-1 pb-0.5 text-[11px] text-fg-subtle">Hold Alt while dragging to place freely.</p>
    </div>
  );
}

// "Arrange ▾" button + popover; used in the toolbar and in the selection bar
export function ArrangeMenu({
  align = 'right',
  compact = false,
}: {
  align?: 'left' | 'right' | 'center';
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        data-arrange-toggle
        data-testid="arrange-button"
        title="Arrange consoles"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={
          compact
            ? `inline-flex h-7 items-center gap-1 rounded-md px-2 text-fg-muted
               hover:bg-hover hover:text-fg`
            : `inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-fg-muted shadow-lg shadow-black/20
               hover:bg-hover hover:text-fg`
        }
      >
        {compact ? <LayoutGrid size={13} /> : <Scaling size={14} />}
        Arrange
        <ChevronDown size={13} className="opacity-70" />
      </button>
      {open && <ArrangePopover align={align} onClose={() => setOpen(false)} />}
    </div>
  );
}
