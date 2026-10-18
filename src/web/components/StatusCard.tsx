import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ConsoleInfo } from '../../shared/protocol';
import { restartConsole } from '../lib/board-actions';
import { STATUS_META, basename, formatSince, isDormant, modelShortName } from '../lib/status';
import { useClock } from '../lib/store';
import { lastLines } from '../lib/terminals';

const DESIGN_WIDTH = 760;
const DESIGN_HEIGHT = 424;

interface StatusCardProps {
  console: ConsoleInfo;
  width: number;
  height: number;
}

// What a console looks like when zoomed out: big, readable at a glance, no live xterm
export function StatusCard({ console: c, width, height }: StatusCardProps) {
  // Type is sized for a default node; shrink it for small nodes so nothing gets clipped
  const scale = Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  const now = useClock((s) => s.now);
  const [lines, setLines] = useState<string[]>(() => lastLines(c.id, 5));
  const meta = STATUS_META[c.status];
  const Icon = meta.icon;

  useEffect(() => {
    const timer = window.setInterval(() => setLines(lastLines(c.id, 5)), 1500);
    return () => window.clearInterval(timer);
  }, [c.id]);

  return (
    <div
      className="aa-drag-handle aa-card-glow absolute inset-0 flex cursor-grab flex-col gap-4 overflow-hidden bg-surface p-8
                 active:cursor-grabbing"
      style={{ zoom: scale }}
    >
      <div className={`flex items-center gap-4 ${meta.text}`}>
        <Icon
          size={56}
          strokeWidth={2.25}
          className={c.status === 'starting' ? 'animate-spin' : ''}
        />
        <span className="font-mono text-5xl font-semibold tracking-[0.06em] uppercase">{meta.label}</span>
        <span className="ml-auto text-4xl font-medium text-fg-subtle tabular-nums">
          {formatSince(c.statusChangedAt, now)}
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-5xl font-semibold text-fg">{c.name}</div>
        <div className="mt-1 truncate font-mono text-3xl text-fg-muted">
          {[c.role, modelShortName(c.model), basename(c.cwd)].filter(Boolean).join(' · ')}
        </div>
      </div>
      {c.statusDetail && <div className="line-clamp-2 text-3xl text-fg">{c.statusDetail}</div>}
      {isDormant(c.status) ? (
        <button
          type="button"
          onClick={() => void restartConsole(c.id)}
          className="aa-btn-primary nodrag inline-flex w-fit items-center gap-3 rounded-xl px-6 py-3 text-3xl font-semibold"
        >
          <RotateCcw size={32} />
          {c.status === 'suspended' ? 'Resume' : 'Restart'}
        </button>
      ) : (
        <pre className="mt-auto min-h-0 overflow-hidden rounded-xl border border-line bg-term p-4 font-mono text-xl leading-snug whitespace-pre text-term-fg">
          {lines.length ? lines.join('\n') : ' '}
        </pre>
      )}
    </div>
  );
}
