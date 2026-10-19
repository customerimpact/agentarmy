import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { PROJECT_COLORS, type ConsoleInfo, type ProjectColor } from '../../../shared/protocol';
import { projectColor } from '../../lib/board-ui';
import { isOnActiveWorkspace, itemsApi, useItems } from '../../lib/items';
import { STATUS_META } from '../../lib/status';
import { useBoard } from '../../lib/store';
import { StatusDot } from '../StatusDot';

// Background for a colored item: a wash of the project color over the surface
export function itemTint(color: ProjectColor | undefined, percent = 16): string {
  return color
    ? `color-mix(in srgb, ${projectColor(color)} ${percent}%, var(--aa-surface))`
    : 'var(--aa-surface)';
}

export function setItemColor(id: string, color: ProjectColor | undefined): void {
  const item = useItems.getState().items[id];
  if (!item) return;
  useItems.getState().upsertItem({ ...item, color });
  if (color) void itemsApi.update(id, { color }).catch(() => undefined);
}

export function ColorSwatches({ value, onPick }: { value?: ProjectColor; onPick: (c: ProjectColor) => void }) {
  return (
    <div className="flex items-center gap-1" data-testid="item-colors">
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={`Color ${c}`}
          onClick={() => onPick(c)}
          className={`nodrag size-3.5 rounded-full ring-offset-1 ring-offset-surface
                      hover:scale-110 ${value === c ? 'ring-2 ring-fg-muted' : ''}`}
          style={{ background: projectColor(c) }}
        />
      ))}
    </div>
  );
}

export function IconBtn({
  label,
  onClick,
  children,
  testId,
  danger,
}: {
  label: string;
  onClick: (button: HTMLElement) => void;
  children: ReactNode;
  testId?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e.currentTarget);
      }}
      className={`nodrag grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors
                  hover:bg-hover ${danger ? 'hover:text-error' : 'hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

export function DeleteItemButton({ remove }: { remove: () => void }) {
  return (
    <IconBtn label="Delete" testId="item-delete" onClick={remove} danger>
      <Trash2 size={13} />
    </IconBtn>
  );
}

const RUNNING = new Set(['idle', 'working', 'needs_you', 'resting', 'error']);

// Consoles a prompt can go to: this workspace first, then the others
export function sendableConsoles(consoles: Record<string, ConsoleInfo>): ConsoleInfo[] {
  return Object.values(consoles).sort(
    (a, b) =>
      Number(isOnActiveWorkspace(b)) - Number(isOnActiveWorkspace(a)) ||
      Number(RUNNING.has(b.status)) - Number(RUNNING.has(a.status)) ||
      a.name.localeCompare(b.name),
  );
}

// Small popover that lists the agents; rendered in a portal so board zoom doesn't shrink it
export function ConsolePicker({
  anchor,
  title,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  onPick: (consoleId: string) => void;
  onClose: () => void;
}) {
  const consoles = useBoard((s) => s.consoles);
  const ref = useRef<HTMLDivElement>(null);
  const [rect] = useState(() => anchor.getBoundingClientRect());
  const list = sendableConsoles(consoles);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const top = Math.min(rect.bottom + 6, window.innerHeight - 280);
  const left = Math.min(rect.left, window.innerWidth - 260);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      data-testid="console-picker"
      className="fixed z-50 w-60 rounded-xl border border-line-strong bg-elevated p-1.5 text-[12px] text-fg shadow-2xl shadow-black/40"
      style={{ top, left }}
    >
      <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{title}</div>
      {list.length === 0 && <p className="px-2 pb-2 text-fg-muted">No agents yet. Start one with New agent.</p>}
      <ul className="aa-scroll flex max-h-60 flex-col overflow-y-auto">
        {list.map((c) => {
          const ok = RUNNING.has(c.status);
          return (
            <li key={c.id}>
              <button
                type="button"
                disabled={!ok}
                data-testid={`pick-console-${c.name}`}
                onClick={() => onPick(c.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left
                           hover:bg-hover disabled:opacity-45 disabled:hover:bg-transparent"
              >
                <StatusDot status={c.status} />
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                <span className={`text-[11px] ${STATUS_META[c.status].text}`}>{STATUS_META[c.status].label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

// Text input that saves on Enter / blur and looks like plain text until focused
export function InlineEdit({
  value,
  onSave,
  placeholder,
  className = '',
  testId,
  autoFocus,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  className?: string;
  testId?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      data-testid={testId}
      value={draft}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={`nodrag min-w-0 rounded bg-transparent outline-none placeholder:text-fg-subtle
                  focus:bg-canvas/60 focus:ring-1 focus:ring-line-strong ${className}`}
    />
  );
}
