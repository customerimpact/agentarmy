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
    pill: 'bg-needs/15 text-needs ring-1 ring-needs/50',
    cssVar: 'var(--aa-needs)',
    rank: 0,
  },
  working: {
    label: 'Working',
    icon: Zap,
    dot: 'bg-working',
    text: 'text-working',
    pill: 'bg-working/15 text-working ring-1 ring-working/40',
    cssVar: 'var(--aa-working)',
    rank: 1,
  },
  error: {
    label: 'Error',
    icon: TriangleAlert,
    dot: 'bg-error',
    text: 'text-error',
    pill: 'bg-error/15 text-error ring-1 ring-error/40',
    cssVar: 'var(--aa-error)',
    rank: 2,
  },
  resting: {
    label: 'Resting',
    icon: CircleCheck,
    dot: 'bg-resting',
    text: 'text-resting',
    pill: 'bg-resting/12 text-resting ring-1 ring-resting/30',
    cssVar: 'var(--aa-resting)',
    rank: 3,
  },
  idle: {
    label: 'Idle',
    icon: Circle,
    dot: 'bg-idle',
    text: 'text-idle',
    pill: 'bg-idle/12 text-fg-muted ring-1 ring-idle/30',
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

// 'claude-opus-5-5' -> 'Opus 5.5', 'claude-sonnet-4-5-20250929' -> 'Sonnet 4.5', 'claude-3-5-haiku' -> 'Haiku 3.5'
export function modelShortName(model?: string | null): string | null {
  if (!model) return null;
  const id = model.toLowerCase().replace(/\[.*?\]/g, '').trim();
  const family = /(opus|sonnet|haiku|fable)/.exec(id)?.[1];
  if (!family) return model;
  const digits = id
    .replace(/^claude-?/, '')
    .split('-')
    .filter((part) => /^\d{1,2}$/.test(part)); // drops date stamps like 20250929
  const name = family[0].toUpperCase() + family.slice(1);
  return digits.length ? `${name} ${digits.slice(0, 2).join('.')}` : name;
}

// CSS color for a project color name (see --aa-project-* in styles.css)
export function projectColorVar(color: string | undefined | null): string {
  return `var(--aa-project-${color ?? 'orange'})`;
}
