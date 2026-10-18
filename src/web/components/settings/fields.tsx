import { useEffect, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';

// Small controls for the Settings tab. All colors come from the semantic theme tokens.

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
      className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-40
                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
                  ${checked ? 'bg-accent' : 'bg-line-strong'}`}
    >
      <span
        className={`block size-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`}
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
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-md border border-line bg-canvas p-0.5">
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
            className={`rounded px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap tabular-nums disabled:opacity-40
                        ${active ? 'bg-hover text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

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
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-7 max-w-44 shrink-0 rounded-md border border-line-strong bg-canvas px-1.5 text-[12px] text-fg outline-none
                 focus:border-accent disabled:opacity-40"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
  const button = `grid size-6 place-items-center rounded text-fg-muted disabled:opacity-30
                  hover:bg-hover hover:text-fg`;
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center rounded-md border border-line bg-canvas p-0.5">
      <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => set(value - step)} className={button}>
        <Minus size={12} />
      </button>
      <span className="w-12 text-center text-[12px] font-medium text-fg tabular-nums" aria-live="polite">
        {format(value)}
      </span>
      <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => set(value + step)} className={button}>
        <Plus size={12} />
      </button>
    </div>
  );
}

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
    <div className="flex items-center gap-1.5">
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
          if (e.key === 'Escape') setDraft(value);
        }}
        className={`h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 text-[12px] text-fg outline-none
                    placeholder:text-fg-subtle focus:border-accent disabled:opacity-40
                    ${mono ? 'font-mono' : ''}`}
      />
      <button
        type="button"
        disabled={!dirty || busy || disabled}
        onClick={() => void save()}
        className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-[12px] font-semibold text-accent-fg disabled:opacity-30
                   hover:brightness-110"
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
  tone?: 'default' | 'danger';
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium disabled:opacity-40
                  ${tone === 'danger' ? 'border-error/40 text-error hover:bg-error/10' : 'border-line-strong text-fg-muted hover:bg-hover hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'danger' }) {
  const cls =
    tone === 'danger'
      ? 'border-error/40 bg-error/10 text-error'
      : tone === 'warn'
        ? 'border-needs/40 bg-needs/10 text-needs'
        : 'border-line bg-surface-2 text-fg-muted';
  return <p className={`mt-1.5 rounded-md border px-2 py-1.5 text-[11.5px] leading-4 ${cls}`}>{children}</p>;
}
