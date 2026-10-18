import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import { FolderOpen, LayoutDashboard, Maximize, Play, RotateCcw, Send, Skull, Undo2 } from 'lucide-react';
import type { ConsoleInfo } from '../../shared/protocol';
import { api } from '../lib/api';
import { closeConsole, restartConsole, sendLine } from '../lib/board-actions';
import { attentionCount } from '../lib/fleet';
import { usePoppedOut } from '../lib/popout';
import { STATUS_META, basename, formatSince, isDormant, projectColorVar } from '../lib/status';
import { useBoard, useClock } from '../lib/store';
import {
  focusWallConsoles,
  popoutKey,
  projectMembers,
  wallGrid,
  windowTitle,
  type PopoutView,
} from '../lib/views';
import { Board } from './Board';
import { ConfirmDialog } from './ConfirmDialog';
import { PopOutButton, consoleView } from './PopoutControls';
import { ReconnectBanner, Toasts } from './StatusBanners';
import { AgentAvatar } from './TerminalNode';
import { TerminalView } from './TerminalView';

// Pop-out windows (?view=console|project|focus). Each runs its own socket against the same
// server, so everything stays live; the main board dims what is shown here.

const HEADER_HEIGHT = 36;

function useWindowTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

function projectColorOf(c: ConsoleInfo | undefined): string | null {
  const projects = useBoard.getState().projects;
  return c?.projectId ? (projects[c.projectId]?.color ?? null) : null;
}

function StatusPill({ c }: { c: ConsoleInfo }) {
  const now = useClock((s) => s.now);
  const meta = STATUS_META[c.status];
  return (
    <span
      data-testid="console-status"
      className={`aa-label relative inline-flex h-5 shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-2 ${meta.pill}`}
      title={c.statusDetail}
    >
      {c.status === 'working' && <span aria-hidden className="aa-shimmer absolute inset-0" />}
      <span className="relative">{meta.label}</span>
      <span className="relative font-medium tabular-nums opacity-70">{formatSince(c.statusChangedAt, now)}</span>
    </span>
  );
}

function Gone({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="popout-gone" className="grid h-full place-items-center bg-canvas p-6 text-center">
      <div>
        <p className="text-[15px] font-semibold text-fg">{title}</p>
        {children}
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-4 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-hover"
        >
          Close window
        </button>
      </div>
    </div>
  );
}

// Closes this window; the main board shows the console again by itself
function BringBackButton() {
  return (
    <button
      type="button"
      data-testid="popout-close"
      title="Close this window and show it on the main board again"
      onClick={() => window.close()}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-muted
                 hover:bg-hover hover:text-fg"
    >
      <Undo2 size={13} />
      Back to board
    </button>
  );
}

// ---------- ?view=console ----------

function ConsolePopout({ id }: { id: string }) {
  const c = useBoard((s) => s.consoles[id]);
  const projectName = useBoard((s) => {
    const pid = s.consoles[id]?.projectId;
    return pid ? (s.projects[pid]?.name ?? '') : '';
  });
  const [draft, setDraft] = useState('');
  useWindowTitle(windowTitle(c?.name ?? 'Console', c?.status === 'needs_you' ? 1 : 0));
  // Focus the terminal on open so typing goes straight in
  useEffect(() => {
    useBoard.getState().select(id);
  }, [id]);

  if (!c) return <Gone title="This console was closed" />;
  const color = projectColorOf(c);
  const needsYou = c.status === 'needs_you';

  const kill = () =>
    useBoard.getState().askConfirm({
      title: `Kill ${c.name}?`,
      message: 'This stops the Claude Code process and removes the console from the board.',
      confirmLabel: 'Kill',
      danger: true,
      onConfirm: () => closeConsole(id),
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    sendLine(id, text);
    setDraft('');
  };

  return (
    <div data-testid="popout-console" data-console-id={id} data-status={c.status} className="flex h-full flex-col bg-surface">
      <header
        className={`flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 ${needsYou ? 'bg-needs/10' : 'bg-surface-2'}`}
      >
        <AgentAvatar status={c.status} color={color} />
        <span className="truncate text-[14px] font-semibold text-fg">{c.name}</span>
        {c.role && (
          <span className="aa-label shrink-0 rounded-md px-1.5 py-[2px]" style={{ color: projectColorVar(color) }}>
            {c.role}
          </span>
        )}
        <span className="truncate font-mono text-[11.5px] text-fg-subtle" title={c.cwd}>
          {projectName && <span className="mr-1.5">{projectName} ·</span>}
          {basename(c.cwd)}
        </span>
        <span className="ml-auto" />
        <StatusPill c={c} />
        <button
          type="button"
          data-testid="console-restart"
          onClick={() => void restartConsole(id)}
          title="Restart (resume conversation)"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          <RotateCcw size={13} />
          {isDormant(c.status) ? (c.status === 'suspended' ? 'Resume' : 'Restart') : 'Restart'}
        </button>
        <button
          type="button"
          data-testid="console-kill"
          onClick={kill}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--aa-danger,var(--aa-error))] px-2.5 text-[12px] font-semibold text-white
                     hover:brightness-110"
        >
          <Skull size={13} />
          Kill
        </button>
        <BringBackButton />
      </header>
      {needsYou && c.statusDetail && (
        <div
          data-testid="console-status-detail"
          className="shrink-0 truncate border-b border-needs/30 bg-needs/10 px-3 py-1 text-[12.5px] text-needs"
        >
          {c.statusDetail}
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-term">
        <TerminalView id={id} hidden={false} webgl />
        {c.status === 'suspended' && (
          <div className="absolute inset-0 grid place-items-center bg-term/90 p-6 text-center">
            <button
              type="button"
              onClick={() => void restartConsole(id)}
              className="aa-btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold"
            >
              <Play size={13} />
              Resume conversation
            </button>
          </div>
        )}
      </div>
      <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-2 px-3 py-2">
        <input
          data-testid="popout-command-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${c.name}…`}
          className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2.5 text-[13px] text-fg outline-none
                     placeholder:text-fg-subtle focus:border-accent"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="aa-btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold disabled:opacity-40"
        >
          <Send size={13} />
          Send
        </button>
      </form>
    </div>
  );
}

// ---------- ?view=project ----------

function ProjectPopout({ id }: { id: string }) {
  const project = useBoard((s) => s.projects[id]);
  const consoles = useBoard((s) => s.consoles);
  const members = useMemo(() => projectMembers(project, consoles), [project, consoles]);
  const needs = members.filter((c) => c.status === 'needs_you').length;
  const working = members.filter((c) => c.status === 'working').length;
  const flow = useReactFlow();
  useWindowTitle(windowTitle(project?.name ?? 'Project', needs));

  // Auto-fit: when the window opens or resizes, and when consoles join or leave
  const memberKey = members.map((c) => c.id).join(',');
  useEffect(() => {
    const fit = () => void flow.fitView({ padding: 0.08, maxZoom: 1, duration: 250 });
    const timer = window.setTimeout(fit, 120);
    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fit, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
    };
  }, [flow, memberKey]);

  if (!project) return <Gone title="This project no longer exists" />;
  const color = projectColorVar(project.color);

  return (
    <div data-testid="popout-project" data-project-id={id} className="flex h-full flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <span className="truncate text-[13px] font-semibold tracking-[0.12em] uppercase" style={{ color }}>
          {project.name}
        </span>
        <span data-testid="popout-project-summary" className="text-[12px] text-fg-muted tabular-nums">
          {members.length} · {working ? `${working} working` : 'idle'}
          {needs > 0 && <span className="text-needs"> · {needs} need{needs === 1 ? 's' : ''} you</span>}
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => void flow.fitView({ padding: 0.08, maxZoom: 1, duration: 250 })}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Maximize size={13} />
          Fit
        </button>
        <BringBackButton />
      </header>
      <main className="relative min-h-0 flex-1">
        {project.open ? (
          <Board projectId={id} />
        ) : (
          <Gone title={`${project.name} is closed`}>
            <button
              type="button"
              onClick={() =>
                void api
                  .openProject(id)
                  .then((p) => useBoard.getState().upsertProject(p))
                  .catch((e: Error) => useBoard.getState().toast(`Could not open: ${e.message}`))
              }
              className="aa-btn-primary mt-3 inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold"
            >
              <FolderOpen size={13} />
              Open project
            </button>
          </Gone>
        )}
        <ReconnectBanner />
      </main>
    </div>
  );
}

// ---------- ?view=focus ----------

// A live terminal at the console's board size, scaled to the tile: the PTY keeps the same
// columns and rows as on the board, so both windows can show it without resizing it
function ScaledTerminal({ c }: { c: ConsoleInfo }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current!;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = c.layout.width;
  const height = Math.max(120, c.layout.height - HEADER_HEIGHT);
  // Shrink freely, grow a little at most: a lone tile should not turn into poster-size text
  const scale = box.width && box.height ? Math.min(box.width / width, box.height / height, 1.2) : 0;
  return (
    <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-term">
      {scale > 0 && (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width, height, transform: `translate(${(box.width - width * scale) / 2}px, 0) scale(${scale})` }}
        >
          <TerminalView id={c.id} hidden={false} webgl={false} />
        </div>
      )}
    </div>
  );
}

function WallTile({ c }: { c: ConsoleInfo }) {
  const projectName = useBoard((s) => (c.projectId ? (s.projects[c.projectId]?.name ?? '') : ''));
  const color = useBoard((s) => (c.projectId ? (s.projects[c.projectId]?.color ?? null) : null));
  // A console in its own window has that window's size; show a card here instead of resizing it
  const poppedOut = usePoppedOut(c.id, { includeProject: false });
  const needsYou = c.status === 'needs_you';
  return (
    <div
      data-testid="wall-tile"
      data-console-id={c.id}
      data-status={c.status}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-surface shadow-xl shadow-black/40
                  ${needsYou ? 'ring-2 ring-needs aa-needs-glow' : 'ring-1 ring-line'}`}
    >
      <header
        className={`flex shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-2.5 ${needsYou ? 'bg-needs/10' : 'bg-surface-2'}`}
        style={{ height: HEADER_HEIGHT }}
      >
        <AgentAvatar status={c.status} color={color} />
        <span className="truncate text-[13px] font-semibold text-fg">{c.name}</span>
        <span className="truncate font-mono text-[11px] text-fg-subtle" title={c.cwd}>
          {projectName ? `${projectName} · ` : ''}
          {basename(c.cwd)}
        </span>
        <span className="ml-auto" />
        <StatusPill c={c} />
        <PopOutButton view={consoleView(c.id)} testId="wall-popout" />
      </header>
      {needsYou && c.statusDetail && (
        <div className="shrink-0 truncate border-b border-needs/30 bg-needs/10 px-3 py-1 text-[12px] text-needs">
          {c.statusDetail}
        </div>
      )}
      {poppedOut ? (
        <div className="grid flex-1 place-items-center bg-term text-[12px] text-term-fg/60">Open in its own window</div>
      ) : (
        <ScaledTerminal c={c} />
      )}
    </div>
  );
}

function FocusWall() {
  const consoles = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  const actions = useBoard((s) => s.actions);
  const wall = useMemo(() => focusWallConsoles(consoles, projects), [consoles, projects]);
  const needs = wall.filter((c) => c.status === 'needs_you').length;
  useWindowTitle(windowTitle('Focus wall', attentionCount(consoles, actions)));
  const gridRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useLayoutEffect(() => {
    const el = gridRef.current!;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { cols, rows } = wallGrid(wall.length, size.width, size.height);

  return (
    <div data-testid="popout-focus" className="flex h-full flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <LayoutDashboard size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">Focus wall</span>
        <span data-testid="wall-summary" className="text-[12px] text-fg-muted tabular-nums">
          {needs > 0 && <span className="text-needs">{needs} need{needs === 1 ? 's' : ''} you · </span>}
          {wall.length - needs} working
        </span>
        <span className="ml-auto text-[11.5px] text-fg-subtle">Updates live · type straight into any terminal</span>
      </header>
      <main className="relative min-h-0 flex-1 p-3">
        <div
          ref={gridRef}
          className="grid h-full gap-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {wall.map((c) => (
            <WallTile key={c.id} c={c} />
          ))}
        </div>
        {wall.length === 0 && (
          <div data-testid="wall-empty" className="absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="text-[15px] font-semibold text-fg">All quiet</p>
              <p className="mt-1 text-[12.5px] text-fg-muted">
                Agents show up here while they work or when they need you.
              </p>
            </div>
          </div>
        )}
        <ReconnectBanner />
      </main>
    </div>
  );
}

export function PopoutShell({ view }: { view: PopoutView }) {
  return (
    <div className="relative h-full" data-popout={popoutKey(view)}>
      {view.kind === 'console' && <ConsolePopout id={view.id} />}
      {view.kind === 'project' && <ProjectPopout id={view.id} />}
      {view.kind === 'focus' && <FocusWall />}
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}
