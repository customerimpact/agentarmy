import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ViewportPortal, useStore } from '@xyflow/react';
import type { Job } from '../../shared/protocol';
import { flowPath, labelPoint, type FlowPath, type Point } from '../lib/flow-path';
import type { Rect } from '../lib/snap';

// Organic lines between consoles that send each other jobs. Drawn in our own layer (inside the
// viewport, between project frames and terminals) instead of as React Flow edges: React Flow only
// renders edges between nodes that have <Handle>s, and our nodes connect at their nearest sides.

export type FlowStatus = 'active' | 'done' | 'failed' | 'standby';

export interface FlowLine {
  id: string;
  source: string; // node id
  target: string; // node id (console, browser tile or frame:<projectId>)
  status: FlowStatus;
  jobs: Job[]; // newest first
}

// Viewport z-order: frames (-2) < lines (-1) < terminals (0+)
export const FLOW_LAYER_Z = -1;

const PALETTE: Record<FlowStatus, { from: string; to: string; glow: string; opacity: number }> = {
  active: { from: '#ff5a36', to: '#ffae57', glow: '#ff7a45', opacity: 1 },
  done: { from: '#d98a4e', to: '#93c26e', glow: '#c59a5a', opacity: 0.75 },
  failed: { from: '#f04c5a', to: '#f04c5a', glow: '#f04c5a', opacity: 0.85 },
  standby: { from: '#ff7a45', to: '#ffae57', glow: '#ff7a45', opacity: 0.35 },
};

const JOB_STATUS_LABEL: Record<Job['status'], string> = {
  sent: 'Sent',
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const LABEL_SIZE = { width: 180, height: 26 };

export interface LaidOutLine extends FlowLine {
  geometry: FlowPath;
  label: Point | null;
}

// Paths for every line, and label spots that avoid nodes, frame titles and each other
export function layoutLines(
  lines: FlowLine[],
  rects: Map<string, Rect>,
  obstacles: Rect[],
  k: number,
): LaidOutLine[] {
  const taken = [...obstacles];
  const size = { width: LABEL_SIZE.width * k, height: LABEL_SIZE.height * k };
  const out: LaidOutLine[] = [];
  for (const line of lines) {
    const a = rects.get(line.source);
    const b = rects.get(line.target);
    if (!a || !b) continue;
    const geometry = flowPath(a, b);
    let label: Point | null = null;
    if (line.jobs.length) {
      label = labelPoint(geometry, taken, size);
      taken.push({ x: label.x - size.width / 2, y: label.y - size.height / 2, ...size });
    }
    out.push({ ...line, geometry, label });
  }
  return out;
}

// One particle flowing back from the worker to the sender when a job finishes
function ReturnParticle({ path, filter, k }: { path: string; filter: string; k: number }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  const fade = useRef<SVGAnimateElement>(null);
  useEffect(() => {
    motion.current?.beginElement();
    fade.current?.beginElement();
  }, []);
  return (
    <circle r={3.8 * k} fill="#e2f7c4" opacity={0} filter={filter}>
      <animateMotion
        ref={motion}
        dur="1.8s"
        begin="indefinite"
        path={path}
        fill="remove"
        keyPoints="0;1"
        keyTimes="0;1"
        calcMode="spline"
        keySplines="0.45 0 0.55 1"
      />
      <animate
        ref={fade}
        attributeName="opacity"
        values="0;1;1;0"
        keyTimes="0;0.08;0.85;1"
        dur="1.8s"
        begin="indefinite"
        fill="remove"
      />
    </circle>
  );
}

function Particles({
  path,
  duration,
  filter,
  k,
}: {
  path: string;
  duration: number;
  filter: string;
  k: number;
}) {
  return (
    <>
      {[0, 1, 2].map((i) => {
        const begin = `${-(i * duration) / 3}s`;
        const motion = (
          <animateMotion
            dur={`${duration}s`}
            begin={begin}
            repeatCount="indefinite"
            path={path}
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="spline"
            keySplines="0.4 0 0.6 1"
          />
        );
        return (
          <g key={i}>
            <circle r={4.2 * k} fill="#ffb067" opacity={0.75} filter={filter}>
              {motion}
            </circle>
            <circle r={1.9 * k} fill="#fff4e2">
              {motion}
            </circle>
          </g>
        );
      })}
    </>
  );
}

// k counter-scales strokes and particles when zoomed out so lines stay visible
const FlowPathView = memo(function FlowPathView({ line, k }: { line: LaidOutLine; k: number }) {
  const { status, jobs, geometry } = line;
  const latest = jobs[0];
  // Replay the "report back" particle only for jobs that just finished, not on every reload
  const [justDone] = useState(
    () => status === 'done' && !!latest && Date.now() - latest.updatedAt < 15_000,
  );
  const [doneKey, setDoneKey] = useState(0);
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current !== 'done' && status === 'done') setDoneKey((k) => k + 1);
    prevStatus.current = status;
  }, [status]);

  if (!geometry) return null;
  const safeId = line.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const gradientId = `aa-flow-grad-${safeId}`;
  const filterId = `aa-flow-glow-${safeId}`;
  const colors = PALETTE[status];
  const { source: s, target: t, c1, c2 } = geometry;
  const xs = [s.x, t.x, c1.x, c2.x];
  const ys = [s.y, t.y, c1.y, c2.y];
  const pad = 40;
  const region = {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + pad * 2,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };
  const length = Math.hypot(t.x - s.x, t.y - s.y) * 1.25;
  const duration = Math.min(4.5, Math.max(1.8, length / 240));
  const animate = !reducedMotion();
  const dash = status === 'failed' ? '7 6' : status === 'standby' ? '3 9' : undefined;
  const filter = `url(#${filterId})`;

  return (
    <g
      data-testid="flow-edge"
      data-status={status}
      data-source={line.source}
      data-target={line.target}
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={s.x} y1={s.y} x2={t.x} y2={t.y}>
          <stop offset="0" stopColor={colors.from} />
          <stop offset="1" stopColor={colors.to} />
        </linearGradient>
        <filter
          id={filterId}
          filterUnits="userSpaceOnUse"
          x={region.x}
          y={region.y}
          width={region.width}
          height={region.height}
        >
          <feGaussianBlur stdDeviation={(status === 'active' ? 5 : 3.5) * k} />
        </filter>
      </defs>
      {status !== 'standby' && (
        <path
          d={geometry.d}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={(status === 'active' ? 10 : 7) * k}
          strokeLinecap="round"
          opacity={status === 'active' ? 0.5 : 0.25}
          filter={filter}
        />
      )}
      <path
        d={geometry.d}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={(status === 'standby' ? 1.5 : 2.2) * k}
        strokeLinecap="round"
        strokeDasharray={dash}
        opacity={colors.opacity}
      />
      {/* Small anchor dots where the line meets each node */}
      {status !== 'standby' && (
        <>
          <circle cx={s.x} cy={s.y} r={3.2 * k} fill={colors.from} opacity={colors.opacity} />
          <circle cx={t.x} cy={t.y} r={3.2 * k} fill={colors.to} opacity={colors.opacity} />
        </>
      )}
      {status === 'active' && animate && (
        <Particles path={geometry.d} duration={duration} filter={filter} k={k} />
      )}
      {status === 'done' && animate && (justDone || doneKey > 0) && (
        <ReturnParticle key={doneKey} path={geometry.reverse} filter={filter} k={k} />
      )}
    </g>
  );
});

function FlowLabel({
  line,
  hovered,
  onHover,
  k,
}: {
  line: LaidOutLine;
  hovered: boolean;
  onHover: (hover: { id: string; at: Point } | null) => void;
  k: number;
}) {
  const at = line.label;
  const latest = line.jobs[0];
  if (!at || !latest) return null;
  const colors = PALETTE[line.status];
  const extra = line.jobs.length - 1;
  return (
    <div
      className="nodrag nopan absolute"
      style={{
        transform: `translate(${at.x}px, ${at.y}px) scale(${k}) translate(-50%, -50%)`,
        transformOrigin: '0 0',
        pointerEvents: 'all',
        left: 0,
        top: 0,
      }}
      onMouseEnter={() => onHover({ id: line.id, at })}
      onMouseLeave={() => onHover(null)}
    >
      <div
        data-testid="flow-edge-label"
        className={`flex max-w-60 items-center gap-1.5 rounded-full border bg-elevated px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-fg shadow-lg shadow-black/40
                    ${hovered ? 'opacity-0' : ''}`}
        style={{ borderColor: `color-mix(in srgb, ${colors.glow} 50%, transparent)` }}
      >
        <span
          className={`relative size-1.5 shrink-0 rounded-full ${line.status === 'active' ? 'aa-ping' : ''}`}
          style={{ background: colors.glow }}
        />
        <span className="truncate">{truncate(latest.title, 34)}</span>
        {extra > 0 && <span className="shrink-0 text-fg-subtle">+{extra}</span>}
      </div>
    </div>
  );
}

// Hover card, drawn in a layer above the terminals so it is never hidden behind one
function FlowTooltip({ line, at, k }: { line: FlowLine; at: Point; k: number }) {
  if (!line.jobs.length) return null;
  const colors = PALETTE[line.status];
  return (
    <div
      className="absolute"
      style={{
        transform: `translate(${at.x}px, ${at.y}px) scale(${k}) translate(-50%, -14px)`,
        transformOrigin: '0 0',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      <div
        data-testid="flow-edge-tooltip"
        className="w-72 rounded-xl border bg-elevated p-2.5 text-[12px] shadow-2xl shadow-black/50"
        style={{ borderColor: `color-mix(in srgb, ${colors.glow} 50%, transparent)` }}
      >
        {line.jobs.slice(0, 4).map((job) => (
          <div key={job.id} className="border-b border-line py-1.5 first:pt-0 last:border-0 last:pb-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold text-fg">{job.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
                {JOB_STATUS_LABEL[job.status]}
              </span>
            </div>
            {job.result && (
              <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
                {truncate(job.result, 280)}
              </p>
            )}
          </div>
        ))}
        {line.jobs.length > 4 && (
          <p className="pt-1 text-[11px] text-fg-subtle">and {line.jobs.length - 4} older</p>
        )}
      </div>
    </div>
  );
}

export function FlowLines({
  lines,
  rects,
  obstacles,
}: {
  lines: FlowLine[];
  rects: Map<string, Rect>; // node id -> board rect (consoles, tiles, frames)
  obstacles: Rect[]; // where labels should not go
}) {
  const [hover, setHover] = useState<{ id: string; at: Point } | null>(null);
  // Quantized so zooming only re-renders the lines at a few steps
  const k = useStore((s) => Math.round(Math.min(2.5, Math.max(1, 0.9 / s.transform[2])) * 4) / 4);
  const laid = useMemo(() => layoutLines(lines, rects, obstacles, k), [lines, rects, obstacles, k]);
  const hoveredLine = hover ? lines.find((l) => l.id === hover.id) : undefined;
  if (!laid.length) return null;
  return (
    <ViewportPortal>
      <div data-testid="flow-lines" style={{ position: 'absolute', left: 0, top: 0, zIndex: FLOW_LAYER_Z }}>
        <svg
          width={1}
          height={1}
          style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
        >
          {laid.map((line) => (
            <FlowPathView key={line.id} line={line} k={k} />
          ))}
        </svg>
        {laid.map((line) => (
          <FlowLabel key={line.id} line={line} hovered={line.id === hover?.id} onHover={setHover} k={k} />
        ))}
      </div>
      {hoveredLine && hover && (
        <div style={{ position: 'absolute', left: 0, top: 0, zIndex: 5000 }}>
          <FlowTooltip line={hoveredLine} at={hover.at} k={k} />
        </div>
      )}
    </ViewportPortal>
  );
}
