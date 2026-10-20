import type { ConsoleStatus } from '../../shared/protocol';
import { AGENT_META, type AgentKind } from '../../shared/agents';
import { AgentIcon } from './AgentIcon';

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
    pill: 'text-working',
    dot: 'bg-working',
    avatar: 'bg-surface-2 text-fg ring-1 ring-working/50',
    pulse: true,
  },
  needs_you: {
    label: 'Needs you',
    pill: 'bg-needs/15 text-needs',
    dot: 'bg-needs',
    avatar: 'bg-needs/15 text-needs ring-1 ring-needs/60',
    pulse: true,
  },
  error: {
    label: 'error',
    pill: 'text-error',
    dot: 'bg-error',
    avatar: 'bg-surface-2 text-error ring-1 ring-error/50',
    pulse: false,
  },
  resting: {
    label: 'done',
    pill: 'text-resting',
    dot: 'bg-resting',
    avatar: 'bg-surface-2 text-fg-muted ring-1 ring-line-strong',
    pulse: false,
  },
  idle: {
    label: 'idle',
    pill: 'text-fg-muted',
    dot: 'bg-idle',
    avatar: 'bg-surface-2 text-fg-muted ring-1 ring-line-strong',
    pulse: false,
  },
  starting: {
    label: 'starting',
    pill: 'text-fg-muted',
    dot: 'bg-idle',
    avatar: 'bg-surface-2 text-fg-muted ring-1 ring-line-strong',
    pulse: true,
  },
  suspended: {
    label: 'suspended',
    pill: 'text-fg-subtle',
    dot: 'bg-exited',
    avatar: 'bg-surface-2 text-fg-subtle ring-1 ring-line',
    pulse: false,
  },
  exited: {
    label: 'exited',
    pill: 'text-fg-subtle',
    dot: 'bg-exited',
    avatar: 'bg-surface-2 text-fg-subtle ring-1 ring-line',
    pulse: false,
  },
};

// Dot + label; only "needs you" gets a filled background so it stands out in a long list
export function StatusPill({ status }: { status: ConsoleStatus }) {
  const meta = PILL[status];
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center gap-1.5 rounded-[4px] px-1.5 text-[11px] font-medium whitespace-nowrap ${meta.pill}`}
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
  agent,
}: {
  name: string;
  status: ConsoleStatus;
  size?: number;
  agent?: AgentKind; // shows which AI runs it as a corner badge (missing = Claude Code)
}) {
  return (
    <span
      aria-hidden
      className={`relative grid shrink-0 place-items-center rounded-[6px] font-semibold ${PILL[status].avatar}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
      <span
        data-testid="avatar-agent"
        data-agent={agent ?? 'claude'}
        className="absolute -right-1 -bottom-1 grid place-items-center rounded-[4px] bg-surface ring-1 ring-line-strong"
        style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }}
      >
        <AgentIcon agent={agent ?? 'claude'} size={Math.round(size * 0.32)} />
      </span>
    </span>
  );
}

// Inline "which AI" mark next to a console name (Mission Map, Progress)
export function AgentMark({ agent, className = '' }: { agent?: AgentKind; className?: string }) {
  return (
    <span data-testid="agent-mark" data-agent={agent ?? 'claude'} title={AGENT_META[agent ?? 'claude']?.label} className={`inline-grid shrink-0 place-items-center text-accent ${className}`}>
      <AgentIcon agent={agent ?? 'claude'} size={11} />
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
    <span className={`block h-1 overflow-hidden rounded-full bg-hover ${className}`}>
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
