import { memo, useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { NodeResizer, useStore, type Node, type NodeProps } from '@xyflow/react';
import { Asterisk, Play, RotateCcw, X } from 'lucide-react';
import type { ConsoleStatus } from '../../shared/protocol';
import {
  COMPACT_ZOOM,
  MIN_SIZE,
  closeConsole,
  persistLayout,
  restartConsole,
  zoomAt,
} from '../lib/board-actions';
import {
  STATUS_META,
  basename,
  formatSince,
  isDormant,
  modelShortName,
  projectColorVar,
} from '../lib/status';
import { lockLayout, unlockLayout, useBoard, useClock } from '../lib/store';
import { usePoppedOut } from '../lib/popout';
import { PopOutButton, PoppedOutOverlay, consoleView } from './PopoutControls';
import { StatusCard } from './StatusCard';
import { StatusDot } from './StatusDot';
import { TerminalView } from './TerminalView';
import { UsageChip } from './UsageChip';
import { ConsoleAccountChip } from './AccountChip';
import { BranchChip } from './ReviewPanel';

export type TerminalFlowNode = Node<Record<string, never>, 'terminal'>;

const HEADER_HEIGHT = 36;

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
                  hover:bg-hover ${danger ? 'hover:text-error' : 'hover:text-accent'}`}
    >
      {children}
    </button>
  );
}

// Rounded-square agent mark, tinted with the project color (orange when ungrouped)
export function AgentAvatar({
  status,
  color,
  size = 22,
}: {
  status: ConsoleStatus;
  color?: string | null;
  size?: number;
}) {
  const tint = projectColorVar(color);
  const live = status === 'working';
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-[7px]"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, color-mix(in srgb, ${tint} 34%, transparent), color-mix(in srgb, ${tint} 12%, transparent))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 45%, transparent)`,
        color: tint,
      }}
    >
      <Asterisk
        size={Math.round(size * 0.72)}
        strokeWidth={2.75}
        className={live ? 'animate-spin [animation-duration:3s] motion-reduce:animate-none' : ''}
      />
      <span className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-surface-2">
        <StatusDot status={status} size={6} />
      </span>
    </span>
  );
}

function TerminalNodeImpl({ id, width, height }: NodeProps<TerminalFlowNode>) {
  const c = useBoard((s) => s.consoles[id]);
  const focused = useBoard((s) => s.selectedId === id);
  const inSelection = useBoard((s) => s.selectedIds.includes(id));
  const projectColor = useBoard((s) => {
    const projectId = s.consoles[id]?.projectId;
    return projectId ? (s.projects[projectId]?.color ?? null) : null;
  });
  const now = useClock((s) => s.now);
  // Boolean selectors so nodes only re-render when a threshold is crossed, not every zoom frame
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM);
  const atNativeZoom = useStore((s) => Math.abs(s.transform[2] - 1) < 0.01);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Lives in a pop-out window: no terminal here, so the two windows never fight over its size
  const poppedOut = usePoppedOut(id);

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
  const working = c.status === 'working';
  const model = modelShortName(c.model);

  const askClose = () =>
    useBoard.getState().askConfirm({
      title: `Close ${c.name}?`,
      message:
        (isDormant(c.status)
        ? 'The console is removed from the board.'
        : 'This stops the Claude Code process and removes the console from the board. You can resume the conversation later with claude --resume.') +
        (c.git
          ? ` Its branch ${c.git.branch} and worktree folder are kept, so no work is lost. Use Review > Discard branch to delete them.`
          : ''),
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

  // Ctrl/Cmd+click adds to (or removes from) the multi-selection; a plain click selects only this one
  const onHeaderPointerDown = (e: PointerEvent) => {
    const store = useBoard.getState();
    if (e.ctrlKey || e.metaKey) {
      store.toggleSelected(id);
      return;
    }
    if (!(store.selectedIds.length === 1 && store.selectedIds[0] === id)) store.setSelectedIds([id]);
    store.select(id);
  };

  const onBodyMouseDown = () => {
    const store = useBoard.getState();
    if (!store.selectedIds.includes(id)) store.setSelectedIds([id]);
    store.select(id);
  };

  const ringClass = needsYou
    ? 'ring-2 ring-needs'
    : inSelection
      ? 'ring-2 ring-accent shadow-[0_0_0_5px_color-mix(in_srgb,var(--aa-accent)_16%,transparent)]'
      : focused
        ? 'ring-1 ring-accent/60'
        : working
          ? 'ring-0'
          : 'ring-1 ring-line hover:ring-line-strong';

  return (
    <>
      <div
        data-testid="console-node"
        data-console-id={id}
        data-status={c.status}
        data-selected={inSelection || undefined}
        className={`aa-node relative h-full w-full ${needsYou ? 'aa-needs-glow' : ''}`}
      >
        {working && <div aria-hidden className="aa-glow aa-glow-working" />}
        {needsYou && <div aria-hidden className="aa-glow aa-glow-needs" />}
        {working && <div aria-hidden className="aa-ring aa-ring-working" />}
        <div
          className={`relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-surface shadow-2xl shadow-black/50 transition-shadow
                      ${ringClass}`}
        >
          {projectColor && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[2px]"
              style={{ background: projectColorVar(projectColor) }}
            />
          )}
          <header
            onPointerDown={onHeaderPointerDown}
            className={`aa-drag-handle flex shrink-0 cursor-grab items-center gap-2 border-b border-line pr-1.5 pl-2.5 select-none
                        active:cursor-grabbing
                        ${needsYou ? 'bg-needs/10' : working ? 'bg-[linear-gradient(90deg,color-mix(in_srgb,var(--aa-working)_12%,var(--aa-surface-2)),var(--aa-surface-2)_55%)]' : 'bg-surface-2'}`}
            style={{ height: HEADER_HEIGHT }}
          >
            <AgentAvatar status={c.status} color={projectColor} />
            <span className="truncate text-[13px] font-semibold text-fg">{c.name}</span>
            {c.role && (
              <span
                className="aa-label shrink-0 rounded-md px-1.5 py-[2px]"
                style={{
                  color: projectColorVar(projectColor),
                  background: `color-mix(in srgb, ${projectColorVar(projectColor)} 12%, transparent)`,
                }}
              >
                {c.role}
              </span>
            )}
            {model && (
              <span className="shrink-0 font-mono text-[10.5px] text-fg-muted" title={c.model}>
                {model}
              </span>
            )}
            <span className="truncate font-mono text-[11px] text-fg-subtle" title={c.cwd}>
              {(model || c.role) && <span className="mr-1.5 text-line-strong">·</span>}
              {basename(c.cwd)}
            </span>
            <span className="ml-auto" />
            <ConsoleAccountChip console={c} />
            <UsageChip id={id} />
            {c.git && <BranchChip console={c} />}
            <span
              data-testid="console-status"
              className={`aa-label relative inline-flex h-5 shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-2 ${meta.pill}`}
              title={c.statusDetail}
            >
              {working && <span aria-hidden className="aa-shimmer absolute inset-0" />}
              <span className="relative">{meta.label}</span>
              <span className="relative font-medium tabular-nums opacity-70">
                {formatSince(c.statusChangedAt, now)}
              </span>
            </span>
            {isDormant(c.status) ? (
              <button
                type="button"
                data-testid="console-restart"
                onClick={() => void restartConsole(id)}
                className="aa-btn-primary nodrag inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-semibold"
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
            <PopOutButton view={consoleView(id)} testId="console-popout" />
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
            onMouseDown={onBodyMouseDown}
          >
            {poppedOut ? (
              <PoppedOutOverlay popoutKeyName={poppedOut} name={c.name} />
            ) : (
              <TerminalView id={id} hidden={compact} webgl={focused && atNativeZoom} />
            )}
            {!compact && c.status === 'suspended' && (
              <div className="absolute inset-0 grid place-items-center bg-term/90 p-6 text-center">
                <div>
                  <p className="aa-label text-term-fg">Suspended</p>
                  <p className="mt-2 max-w-xs text-[12px] text-term-fg/70">
                    Restored from your last session. Resume relaunches it with claude --resume.
                  </p>
                  <button
                    type="button"
                    data-testid="console-resume"
                    onClick={() => void restartConsole(id)}
                    className="aa-btn-primary mt-3 inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold"
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
                height={(height ?? c.layout.height) - HEADER_HEIGHT}
              />
            )}
          </div>
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
