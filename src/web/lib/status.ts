import {
  TriangleAlert,
  CircleCheck,
  CirclePause,
  Circle,
  Hand,
  LoaderCircle,
  Power,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ConsoleStatus } from '../../shared/protocol';

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  // Tailwind classes, kept as literals so the compiler can see them
  dot: string;
  text: string;
  pill: string;
  // Raw CSS color for places Tailwind can't reach (minimap, canvas favicon)
  cssVar: string;
  // Lower sorts first in the mission list
  rank: number;
}

export const STATUS_META: Record<ConsoleStatus, StatusMeta> = {
  needs_you: {
    label: 'Needs you',
    icon: Hand,
    dot: 'bg-needs',
    text: 'text-needs',
    pill: 'bg-needs/15 text-needs ring-1 ring-needs/40',
    cssVar: 'var(--aa-needs)',
    rank: 0,
  },
  working: {
    label: 'Working',
    icon: Zap,
    dot: 'bg-working',
    text: 'text-working',
    pill: 'bg-working/15 text-working',
    cssVar: 'var(--aa-working)',
    rank: 1,
  },
  error: {
    label: 'Error',
    icon: TriangleAlert,
    dot: 'bg-error',
    text: 'text-error',
    pill: 'bg-error/15 text-error',
    cssVar: 'var(--aa-error)',
    rank: 2,
  },
  resting: {
    label: 'Resting',
    icon: CircleCheck,
    dot: 'bg-resting',
    text: 'text-resting',
    pill: 'bg-resting/15 text-resting',
    cssVar: 'var(--aa-resting)',
    rank: 3,
  },
  idle: {
    label: 'Idle',
    icon: Circle,
    dot: 'bg-idle',
    text: 'text-idle',
    pill: 'bg-idle/15 text-idle',
    cssVar: 'var(--aa-idle)',
    rank: 4,
  },
  starting: {
    label: 'Starting',
    icon: LoaderCircle,
    dot: 'bg-idle',
    text: 'text-idle',
    pill: 'bg-idle/15 text-idle',
    cssVar: 'var(--aa-idle)',
    rank: 5,
  },
  suspended: {
    label: 'Suspended',
    icon: CirclePause,
    dot: 'bg-exited',
    text: 'text-fg-subtle',
    pill: 'bg-exited/20 text-fg-subtle',
    cssVar: 'var(--aa-exited)',
    rank: 6,
  },
  exited: {
    label: 'Exited',
    icon: Power,
    dot: 'bg-exited',
    text: 'text-fg-subtle',
    pill: 'bg-exited/20 text-fg-subtle',
    cssVar: 'var(--aa-exited)',
    rank: 7,
  },
};

export function formatSince(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// Consoles with no live process: the primary action is to (re)launch them with --resume
export function isDormant(status: ConsoleStatus): boolean {
  return status === 'exited' || status === 'suspended';
}
