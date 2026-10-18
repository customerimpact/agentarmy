import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';

// Controls for the Settings window (Cursor-style rows: label left, control right).
// All colors come from the semantic theme tokens so every theme works.

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  if (tokens.length === 0 || !text) return <>{text}</>;
  const pattern = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="aa-hit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

// Pill switch
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-150
                  disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}
                  ${checked ? 'border-accent bg-accent' : 'border-line-strong bg-hover hover:border-fg-subtle'}`}
    >
      <span
        className={`absolute top-1/2 left-[2px] block size-4 -translate-y-1/2 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.35)]
                    transition-transform duration-150
                    ${checked ? 'translate-x-4 bg-white' : 'bg-fg-muted'}`}
      />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface p-[3px]
                  ${disabled ? 'opacity-40' : ''}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`h-full rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap tabular-nums transition-colors
                        disabled:cursor-not-allowed ${focusRing}
                        ${active ? 'bg-elevated text-fg shadow-[0_1px_2px_var(--aa-shadow)] ring-1 ring-line-strong' : 'text-fg-muted hover:text-fg'}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// Native select (keyboard + screen reader friendly) dressed with a chevron
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 max-w-56 min-w-36 cursor-pointer appearance-none rounded-lg border border-line-strong bg-surface pr-8 pl-2.5
                   text-[12.5px] text-fg outline-none transition-colors
                   hover:border-fg-subtle focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-subtle"
      />
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  step,
  onChange,
  label,
  format = String,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  format?: (value: number) => string;
}) {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const set = (v: number) => onChange(round(Math.min(max, Math.max(min, v))));
  const button = `grid size-[26px] place-items-center rounded-md text-fg-muted transition-colors
                  hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 shrink-0 items-center rounded-lg border border-line-strong bg-surface p-[2px]"
    >
      <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => set(value - step)} className={button}>
        <Minus size={13} />
      </button>
      <span className="w-14 text-center text-[12.5px] font-medium text-fg tabular-nums" aria-live="polite">
        {format(value)}
      </span>
      <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => set(value + step)} className={button}>
        <Plus size={13} />
      </button>
    </div>
  );
}

const inputClass = `h-8 min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[12.5px] text-fg outline-none
                    transition-colors placeholder:text-fg-subtle hover:border-fg-subtle focus:border-accent
                    disabled:cursor-not-allowed disabled:opacity-40`;

// Text input that only commits on Save / Enter, so half-typed paths are never applied
export function TextSave({
  value,
  onSave,
  placeholder,
  label,
  mono = true,
  disabled,
  type = 'text',
}: {
  value: string;
  onSave: (value: string) => Promise<unknown> | void;
  placeholder?: string;
  label: string;
  mono?: boolean;
  disabled?: boolean;
  type?: 'text' | 'password';
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft.trim() !== value;
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await onSave(draft.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={label}
        type={type}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape' && dirty) {
            // First Esc reverts the draft; the next one closes the window
            e.stopPropagation();
            setDraft(value);
          }
        }}
        className={`${inputClass} flex-1 ${mono ? 'font-mono text-[12px]' : ''}`}
      />
      <button
        type="button"
        disabled={!dirty || busy || disabled}
        onClick={() => void save()}
        className={`h-8 shrink-0 rounded-lg px-3 text-[12.5px] font-semibold transition-colors ${focusRing}
                    ${dirty ? 'bg-accent text-accent-fg hover:brightness-110' : 'border border-line-strong bg-transparent text-fg-subtle'}
                    disabled:cursor-not-allowed ${dirty ? 'disabled:opacity-50' : ''}`}
      >
        Save
      </button>
    </div>
  );
}

export function SmallButton({
  children,
  onClick,
  disabled,
  tone = 'default',
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  testId?: string;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-error/45 text-error hover:bg-error/10'
      : tone === 'primary'
        ? 'border-accent bg-accent text-accent-fg hover:brightness-110'
        : 'border-line-strong bg-elevated text-fg hover:bg-hover';
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-medium transition-colors
                  disabled:cursor-not-allowed disabled:opacity-40 ${focusRing} ${toneClass}`}
    >
      {children}
    </button>
  );
}

// "Applies to new agents" / "Restart needed" chips next to a row title
export function Badge({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 text-[10.5px] leading-none font-medium whitespace-nowrap
                  ${tone === 'warn' ? 'border-needs/35 bg-needs/10 text-needs' : 'border-line-strong bg-hover/60 text-fg-muted'}`}
    >
      {children}
    </span>
  );
}

export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'danger' }) {
  const cls =
    tone === 'danger'
      ? 'border-error/40 bg-error/10 text-error'
      : tone === 'warn'
        ? 'border-needs/40 bg-needs/10 text-needs'
        : 'border-line bg-canvas/60 text-fg-muted';
  return <p className={`mt-2 rounded-lg border px-3 py-2 text-[12px] leading-[18px] ${cls}`}>{children}</p>;
}
