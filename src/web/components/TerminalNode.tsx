import { memo, useEffect, useRef, type ReactNode } from 'react';
import { NodeResizer, useStore, type Node, type NodeProps } from '@xyflow/react';
import { Play, RotateCcw, X } from 'lucide-react';
import {
  COMPACT_ZOOM,
  MIN_SIZE,
  closeConsole,
  persistLayout,
  restartConsole,
  zoomAt,
} from '../lib/board-actions';
import { STATUS_META, basename, formatSince, isDormant } from '../lib/status';
import { lockLayout, unlockLayout, useBoard, useClock } from '../lib/store';
import { StatusCard } from './StatusCard';
import { StatusDot } from './StatusDot';
import { TerminalView } from './TerminalView';

export type TerminalFlowNode = Node<Record<string, never>, 'terminal'>;

function IconButton({
  label,
  onClick,
  children,
  danger,
  testId,
}: {
  label: string;
  testId?: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={`nodrag grid size-6 place-items-center rounded-md text-fg-subtle transition-colors
                  hover:bg-hover ${danger ? 'hover:text-error' : 'hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

function TerminalNodeImpl({ id, width, height }: NodeProps<TerminalFlowNode>) {
  const c = useBoard((s) => s.consoles[id]);
  const selected = useBoard((s) => s.selectedId === id);
  const now = useClock((s) => s.now);
  // Boolean selectors so nodes only re-render when a threshold is crossed, not every zoom frame
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM);
  const atNativeZoom = useStore((s) => Math.abs(s.transform[2] - 1) < 0.01);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Terminals swallow wheel events (nowheel); keep ctrl/cmd+wheel zooming the board instead of the page
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
      // Trackpad pinches arrive as tiny ctrl+wheel deltas; amplify them like React Flow does
      const pinchBoost = Math.abs(e.deltaY) < 20 ? 8 : 1;
      zoomAt(e.clientX, e.clientY, 2 ** (-e.deltaY * unit * pinchBoost));
    };
    body.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => body.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  if (!c) return null;
  const meta = STATUS_META[c.status];
  const needsYou = c.status === 'needs_you';

  const askClose = () =>
    useBoard.getState().askConfirm({
      title: `Close ${c.name}?`,
      message: isDormant(c.status)
        ? 'The console is removed from the board.'
        : 'This stops the Claude Code process and removes the console from the board. You can resume the conversation later with claude --resume.',
      confirmLabel: 'Close console',
      danger: true,
      onConfirm: () => closeConsole(id),
    });

  const askRestart = () => {
    if (isDormant(c.status) || c.status === 'error') {
      void restartConsole(id);
      return;
    }
    useBoard.getState().askConfirm({
      title: `Restart ${c.name}?`,
      message:
        'The running process is stopped and relaunched with claude --resume in the same folder.',
      confirmLabel: 'Restart',
      onConfirm: () => restartConsole(id),
    });
  };

  const ringClass = needsYou
    ? 'aa-needs-glow'
    : selected
      ? 'ring-2 ring-accent/70'
      : 'ring-1 ring-line';

  return (
    <>
      <div
        data-testid="console-node"
        data-console-id={id}
        data-status={c.status}
        className={`aa-node flex h-full w-full flex-col overflow-hidden rounded-xl bg-surface shadow-2xl shadow-black/40
                  ${ringClass}`}
      >
        <header
          onPointerDown={() => useBoard.getState().select(id)}
          className={`aa-drag-handle flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-line bg-surface-2 pr-1.5 pl-3 select-none
                    active:cursor-grabbing
                    ${needsYou ? 'bg-needs/10' : ''}`}
        >
          <StatusDot status={c.status} />
          <span className="truncate font-semibold text-fg">{c.name}</span>
          <span className="truncate font-mono text-[11px] text-fg-subtle" title={c.cwd}>
            {basename(c.cwd)}
          </span>
          <span className="ml-auto" />
          <span
            data-testid="console-status"
            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${meta.pill}`}
            title={c.statusDetail}
          >
            {meta.label}
            <span className="ml-1.5 tabular-nums opacity-70">
              {formatSince(c.statusChangedAt, now)}
            </span>
          </span>
          {isDormant(c.status) ? (
            <button
              type="button"
              data-testid="console-restart"
              onClick={() => void restartConsole(id)}
              className="nodrag inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-accent px-2 text-[11px] font-semibold text-accent-fg
                       hover:brightness-110"
            >
              <RotateCcw size={12} />
              {c.status === 'suspended' ? 'Resume' : 'Restart'}
            </button>
          ) : (
            <IconButton
              testId="console-restart"
              label="Restart (resume conversation)"
              onClick={askRestart}
            >
              <RotateCcw size={13} />
            </IconButton>
          )}
          <IconButton testId="console-close" label="Close console" onClick={askClose} danger>
            <X size={15} />
          </IconButton>
        </header>
        {needsYou && c.statusDetail && !compact && (
          <div
            data-testid="console-status-detail"
            className="shrink-0 truncate border-b border-needs/30 bg-needs/10 px-3 py-1 text-[12px] text-needs"
          >
            {c.statusDetail}
          </div>
        )}
        <div
          ref={bodyRef}
          className={`relative min-h-0 flex-1 bg-term ${compact ? '' : 'nodrag nowheel nopan cursor-text'}`}
          onMouseDown={() => useBoard.getState().select(id)}
        >
          <TerminalView id={id} hidden={compact} webgl={selected && atNativeZoom} />
          {!compact && c.status === 'suspended' && (
            <div className="absolute inset-0 grid place-items-center bg-term/90 p-6 text-center">
              <div>
                <p className="font-semibold text-[#e6e8ee]">Suspended</p>
                <p className="mt-1 max-w-xs text-[12px] text-[#9aa0ad]">
                  Restored from your last session. Resume relaunches it with claude --resume.
                </p>
                <button
                  type="button"
                  data-testid="console-resume"
                  onClick={() => void restartConsole(id)}
                  className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg
                             hover:brightness-110"
                >
                  <Play size={12} />
                  Resume
                </button>
              </div>
            </div>
          )}
          {compact && (
            <StatusCard
              console={c}
              width={width ?? c.layout.width}
              height={(height ?? c.layout.height) - 36}
            />
          )}
        </div>
      </div>
      {/* After the clipped card so the edge handles sit on top and aren't cut off */}
      <NodeResizer
        minWidth={MIN_SIZE.width}
        minHeight={MIN_SIZE.height}
        onResizeStart={() => lockLayout(id)}
        onResizeEnd={(_, params) => {
          unlockLayout(id);
          persistLayout(id, params);
        }}
      />
    </>
  );
}

export const TerminalNode = memo(TerminalNodeImpl);
