import type { ConsoleStatus } from '../../shared/protocol';

// Pill + avatar shared by the Agents tab, the Mission Map and the Progress tab
interface PillMeta {
  label: string;
  pill: string;
  dot: string;
  avatar: string;
  pulse: boolean;
}

export const PILL: Record<ConsoleStatus, PillMeta> = {
  working: {
    label: 'running',
    pill: 'bg-working/12 text-working ring-1 ring-working/30',
    dot: 'bg-working',
    avatar: 'bg-working/18 text-working ring-1 ring-working/40',
    pulse: true,
  },
  needs_you: {
    label: 'Needs you',
    pill: 'bg-needs/15 text-needs ring-1 ring-needs/45',
    dot: 'bg-needs',
    avatar: 'bg-needs/20 text-needs ring-1 ring-needs/50',
    pulse: true,
  },
  error: {
    label: 'error',
    pill: 'bg-error/15 text-error ring-1 ring-error/40',
    dot: 'bg-error',
    avatar: 'bg-error/18 text-error ring-1 ring-error/40',
    pulse: false,
  },
  resting: {
    label: 'done',
    pill: 'bg-resting/12 text-resting ring-1 ring-resting/30',
    dot: 'bg-resting',
    avatar: 'bg-resting/15 text-resting ring-1 ring-resting/30',
    pulse: false,
  },
  idle: {
    label: 'idle',
    pill: 'bg-hover text-fg-muted ring-1 ring-line-strong',
    dot: 'bg-idle',
    avatar: 'bg-hover text-fg-muted ring-1 ring-line-strong',
    pulse: false,
  },
  starting: {
    label: 'starting',
    pill: 'bg-hover text-fg-muted ring-1 ring-line-strong',
    dot: 'bg-idle',
    avatar: 'bg-hover text-fg-muted ring-1 ring-line-strong',
    pulse: true,
  },
  suspended: {
    label: 'suspended',
    pill: 'text-fg-subtle ring-1 ring-line',
    dot: 'bg-exited',
    avatar: 'bg-surface-2 text-fg-subtle ring-1 ring-line',
    pulse: false,
  },
  exited: {
    label: 'exited',
    pill: 'text-fg-subtle ring-1 ring-line',
    dot: 'bg-exited',
    avatar: 'bg-surface-2 text-fg-subtle ring-1 ring-line',
    pulse: false,
  },
};

export function StatusPill({ status }: { status: ConsoleStatus }) {
  const meta = PILL[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[1px] text-[11px] font-medium whitespace-nowrap ${meta.pill}`}
    >
      <span
        className={`relative inline-block size-1.5 rounded-full ${meta.dot} ${meta.pulse ? 'aa-ping' : ''}`}
      />
      {meta.label}
    </span>
  );
}

export function Avatar({
  name,
  status,
  size = 28,
}: {
  name: string;
  status: ConsoleStatus;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-lg font-semibold ${PILL[status].avatar}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

// Thin horizontal progress bar
export function ProgressBar({
  ratio,
  color,
  className = '',
}: {
  ratio: number;
  color?: string | null;
  className?: string;
}) {
  return (
    <span className={`block h-1.5 overflow-hidden rounded-full bg-hover ${className}`}>
      <span
        className={`block h-full rounded-full transition-[width] duration-500 ${color ? '' : 'bg-accent'}`}
        style={{
          width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
          background: color ?? undefined,
        }}
      />
    </span>
  );
}

// Small ring used in headers ("3/12 working")
export function Ring({ ratio, size = 16 }: { ratio: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2}
        className="stroke-line-strong"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, ratio)))}
        className="stroke-working transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}
