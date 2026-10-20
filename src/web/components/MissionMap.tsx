import { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Network, Search, User, X } from 'lucide-react';
import type { ConsoleInfo, Job, Project } from '../../shared/protocol';
import { flyTo } from '../lib/board-actions';
import {
  byStatus,
  combinedProgress,
  fleetBucket,
  fleetCounts,
  isOrchestrator,
  projectHex,
  projectOf,
  relativeTime,
  shortModel,
  statusLine,
  type FleetBucket,
} from '../lib/fleet';
import { STATUS_META } from '../lib/status';
import { useBoard, useClock } from '../lib/store';
import { activeLoopCount, useLoops } from '../lib/loops';
import { AgentMark, ProgressBar, StatusPill } from './AgentBadges';
import { JobRow, TodoList } from './ProgressPanel';

type Filter = 'all' | FleetBucket;
type Inspect = { kind: 'console'; id: string } | { kind: 'team'; id: string } | null;

const YOU = '__you__';
const COL = { left: 24, team: 300, console: 590 };
const W = { left: 196, team: 210, console: 250 };
const H = { left: 64, team: 72, console: 54 };
const GAP = 10;
const TEAM_GAP = 22;

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Edge {
  from: Box;
  to: Box;
  color: string;
  dashed: boolean;
  active: boolean;
}

function curve(a: Box, b: Box): string {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

const BUCKET_LABEL: Record<FleetBucket, string> = {
  working: 'Working',
  needs: 'Needs you',
  idle: 'Idle',
  done: 'Done',
};
const BUCKET_DOT: Record<FleetBucket, string> = {
  working: 'bg-working',
  needs: 'bg-needs',
  idle: 'bg-idle',
  done: 'bg-resting',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function MissionMap() {
  const consolesById = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  const jobsById = useBoard((s) => s.jobs);
  const now = useClock((s) => s.now);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [inspect, setInspect] = useState<Inspect>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const close = () => useBoard.getState().setMissionMapOpen(false);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const jobs = useMemo(
    () => Object.values(jobsById).sort((a, b) => b.createdAt - a.createdAt),
    [jobsById],
  );

  const model = useMemo(() => {
    // Consoles of closed projects are hidden from the board, so they're left off the map too
    const all = Object.values(consolesById).filter((c) => {
      const p = projectOf(c, projects);
      return !p || p.open;
    });
    const orchestrators = all.filter((c) => isOrchestrator(c, jobs)).sort(byStatus);
    const orchIds = new Set(orchestrators.map((c) => c.id));
    const workers = all.filter((c) => !orchIds.has(c.id));
    const teams = Object.values(projects).sort((a, b) => a.createdAt - b.createdAt);
    return { all, orchestrators, workers, teams };
  }, [consolesById, projects, jobs]);

  const q = query.trim().toLowerCase();
  const consoleMatches = (c: ConsoleInfo, team?: Project) =>
    (filter === 'all' || fleetBucket(c.status) === filter) &&
    (!q ||
      c.name.toLowerCase().includes(q) ||
      (c.role ?? '').toLowerCase().includes(q) ||
      c.cwd.toLowerCase().includes(q) ||
      (team?.name.toLowerCase().includes(q) ?? false));

  // ---------- layout ----------
  const layout = useMemo(() => {
    const boxes = new Map<string, Box>();
    const edges: Edge[] = [];
    const teamRows: { team: Project; box: Box; members: ConsoleInfo[]; total: number }[] = [];
    const consoleRows: { c: ConsoleInfo; box: Box; team?: Project }[] = [];
    const parentOf = (target: ConsoleInfo[], team?: Project): string => {
      const ids = new Set(target.map((c) => c.id));
      const sender = jobs.find((j) => j.fromId && ids.has(j.toId) && boxes.has(j.fromId));
      if (sender?.fromId) return sender.fromId;
      const inTeam =
        team && model.orchestrators.find((o) => projectOf(o, projects)?.id === team.id);
      if (inTeam) return inTeam.id;
      return model.orchestrators[0]?.id ?? YOU;
    };

    // Left column: orchestrators (+ "You" whenever something is driven only from the command bar)
    let y = 0;
    for (const o of model.orchestrators) {
      boxes.set(o.id, { id: o.id, x: COL.left, y, w: W.left, h: H.left });
      y += H.left + GAP;
    }

    let cy = 0;
    const place = (list: ConsoleInfo[], team?: Project) => {
      const placed: Box[] = [];
      for (const c of list) {
        const box = { id: c.id, x: COL.console, y: cy, w: W.console, h: H.console };
        cy += H.console + GAP;
        boxes.set(c.id, box);
        consoleRows.push({ c, box, team });
        placed.push(box);
      }
      return placed;
    };

    const links: { parent: string; box: Box; c?: ConsoleInfo; dashed: boolean }[] = [];
    const placeTeam = (team: Project) => {
      const members = model.workers.filter((c) => projectOf(c, projects)?.id === team.id);
      const visible = members.filter((c) => consoleMatches(c, team));
      const teamMatches = !q || team.name.toLowerCase().includes(q);
      if (!visible.length && !(filter === 'all' && teamMatches)) return;
      if (!team.open && filter !== 'all') return;
      const start = cy;
      const placed = place(visible.sort(byStatus));
      if (!placed.length) cy += H.team + GAP;
      const end = cy - GAP;
      const box = {
        id: `team:${team.id}`,
        x: COL.team,
        y: Math.max(start, (start + end) / 2 - H.team / 2),
        w: W.team,
        h: H.team,
      };
      boxes.set(box.id, box);
      teamRows.push({
        team,
        box,
        members,
        total: team.open ? members.length : team.consoleIds.length,
      });
      for (const [i, c] of visible.entries()) {
        edges.push({
          from: box,
          to: placed[i],
          color: STATUS_META[c.status].cssVar,
          dashed: false,
          active: c.status === 'working' || c.status === 'needs_you',
        });
      }
      links.push({ parent: parentOf(members, team), box, dashed: false });
      cy += TEAM_GAP;
    };
    // Open teams first, closed ones (no consoles on the board) at the bottom
    for (const team of model.teams) if (team.open) placeTeam(team);

    // Ungrouped consoles hang off their orchestrator (if one sent them work) or the command bar
    const loose = model.workers
      .filter((c) => !projectOf(c, projects))
      .filter((c) => consoleMatches(c))
      .sort(byStatus);
    const loosePlaced = place(loose);
    for (const [i, c] of loose.entries()) {
      const parent = parentOf([c]);
      const viaJob = jobs.some((j) => j.toId === c.id && j.fromId === parent);
      links.push({ parent: viaJob ? parent : YOU, box: loosePlaced[i], c, dashed: !viaJob });
    }
    for (const team of model.teams) if (!team.open) placeTeam(team);

    if (links.some((n) => n.parent === YOU) || model.orchestrators.length === 0) {
      boxes.set(YOU, { id: YOU, x: COL.left, y, w: W.left, h: H.left });
      y += H.left + GAP;
    }

    // Center the left column against everything on the right
    const rightHeight = Math.max(cy - GAP, 0);
    const leftHeight = y - GAP;
    const shift = Math.max(0, (rightHeight - leftHeight) / 2);
    for (const o of [...model.orchestrators.map((c) => c.id), YOU]) {
      const b = boxes.get(o);
      if (b) b.y += shift;
    }

    for (const n of links) {
      const from = boxes.get(n.parent) ?? boxes.get(YOU);
      if (!from) continue;
      edges.push({
        from,
        to: n.box,
        color: n.c ? STATUS_META[n.c.status].cssVar : 'var(--aa-accent)',
        dashed: n.dashed || n.parent === YOU,
        active: n.c ? n.c.status === 'working' : false,
      });
    }

    const height = Math.max(rightHeight, leftHeight, 200) + 48;
    return { boxes, edges, teamRows, consoleRows, height };
    // consoleMatches is derived from filter/q, both listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, projects, jobs, filter, q]);

  const counts = fleetCounts(model.all);
  const total = model.all.length;
  const openTeams = model.teams.filter((t) => t.open).length;
  const jumpTo = (id: string) => {
    close();
    window.setTimeout(() => void flyTo(id), 30);
  };

  const chips: { key: Filter; label: string; count: number; dot?: string }[] = [
    { key: 'all', label: 'All', count: total },
    ...(['working', 'needs', 'idle', 'done'] as FleetBucket[]).map((k) => ({
      key: k as Filter,
      label: BUCKET_LABEL[k],
      count: counts[k],
      dot: BUCKET_DOT[k],
    })),
  ];

  const inspected = inspect?.kind === 'console' ? consolesById[inspect.id] : undefined;
  const inspectedTeam = inspect?.kind === 'team' ? projects[inspect.id] : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[3px] md:p-8"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Mission Map"
        data-testid="mission-map"
        className="flex h-full max-h-[880px] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-elevated shadow-2xl shadow-black/60"
      >
        {/* header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          <Network size={16} className="text-accent" />
          <h2 className="text-[14px] font-semibold text-fg">Mission Map</h2>
          <span className="truncate text-[12.5px] text-fg-subtle">
            — {plural(model.orchestrators.length, 'orchestrator')} · {plural(openTeams, 'team')} ·{' '}
            {plural(total, 'console')} · {counts.working} working
          </span>
          <button
            type="button"
            aria-label="Close Mission Map"
            onClick={close}
            className="ml-auto grid size-8 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        {/* filters */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
          <div className="flex items-center rounded-lg border border-line bg-surface p-0.5">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                data-testid={`map-filter-${chip.key}`}
                aria-pressed={filter === chip.key}
                onClick={() => setFilter(chip.key)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors
                            ${filter === chip.key ? 'bg-hover text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
              >
                {chip.dot && <span className={`size-1.5 rounded-full ${chip.dot}`} />}
                {chip.label}
                <span className="text-fg-subtle tabular-nums">{chip.count}</span>
              </button>
            ))}
          </div>
          <label className="ml-auto flex h-8 w-64 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-accent">
            <Search size={13} className="text-fg-subtle" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a console or team"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
            />
          </label>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* graph */}
          <div
            className="aa-scroll relative min-w-0 flex-1 overflow-auto bg-canvas"
            style={{
              backgroundImage: 'radial-gradient(var(--aa-dots) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }}
            onMouseDown={(e) => e.target === e.currentTarget && setInspect(null)}
          >
            {layout.consoleRows.length === 0 && layout.teamRows.length === 0 && (
              <div className="absolute inset-0 grid place-items-center text-fg-subtle">
                {total === 0 ? 'No consoles on the board yet.' : 'Nothing matches this filter.'}
              </div>
            )}
            <div
              className="relative mx-auto my-6"
              style={{ width: COL.console + W.console + 24, height: layout.height }}
            >
              <svg
                className="pointer-events-none absolute inset-0 overflow-visible"
                width="100%"
                height="100%"
              >
                {layout.edges.map((e, i) => (
                  <path
                    key={i}
                    d={curve(e.from, e.to)}
                    fill="none"
                    stroke={e.color}
                    strokeWidth={e.active ? 2 : 1.5}
                    strokeOpacity={e.dashed ? 0.45 : e.active ? 0.9 : 0.55}
                    strokeDasharray={e.dashed ? '5 5' : undefined}
                    strokeLinecap="round"
                  />
                ))}
              </svg>

              {model.orchestrators.map((o) => {
                const b = layout.boxes.get(o.id);
                if (!b) return null;
                return (
                  <LeftNode
                    key={o.id}
                    box={b}
                    title={o.name}
                    subtitle={[o.role || 'Orchestrator', shortModel(o.model)]
                      .filter(Boolean)
                      .join(' · ')}
                    console={o}
                    active={inspect?.kind === 'console' && inspect.id === o.id}
                    onClick={() => setInspect({ kind: 'console', id: o.id })}
                    onDoubleClick={() => jumpTo(o.id)}
                  />
                );
              })}
              {layout.boxes.get(YOU) && (
                <LeftNode
                  box={layout.boxes.get(YOU)!}
                  title="You"
                  subtitle="Command bar"
                  active={false}
                  onClick={() => setInspect(null)}
                />
              )}

              {layout.teamRows.map(({ team, box, members, total: count }) => {
                const color = projectHex(team.color);
                const p = combinedProgress(members, jobs);
                const working = members.filter((c) => c.status === 'working').length;
                const active = inspect?.kind === 'team' && inspect.id === team.id;
                return (
                  <button
                    key={team.id}
                    type="button"
                    data-testid="map-team"
                    onClick={() => setInspect({ kind: 'team', id: team.id })}
                    onDoubleClick={() => members[0] && jumpTo(members[0].id)}
                    className={`absolute rounded-xl border bg-surface px-3 py-2 text-left shadow-lg shadow-black/30 transition-colors
                                hover:bg-surface-2 ${active ? 'ring-2 ring-accent/60' : ''} ${team.open ? '' : 'opacity-60'}`}
                    style={{
                      left: box.x,
                      top: box.y,
                      width: box.w,
                      height: box.h,
                      borderColor: `${color}66`,
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: color }} />
                      <span
                        className="truncate text-[11.5px] font-semibold tracking-wider uppercase"
                        style={{ color }}
                      >
                        {team.name}
                      </span>
                      <span className="ml-auto text-[11px] text-fg-subtle tabular-nums">
                        {team.open ? `${working}/${count}` : 'Closed'}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-fg-subtle">
                      {plural(count, 'console')}
                      {p.total > 0 && ` · ${p.done}/${p.total} steps`}
                    </span>
                    <ProgressBar ratio={p.ratio} color={color} className="mt-1.5" />
                  </button>
                );
              })}

              {layout.consoleRows.map(({ c, box }) => {
                const active = inspect?.kind === 'console' && inspect.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-testid="map-console"
                    data-console-id={c.id}
                    onClick={() => setInspect({ kind: 'console', id: c.id })}
                    onDoubleClick={() => jumpTo(c.id)}
                    className={`absolute flex items-center gap-2.5 rounded-xl border bg-surface px-3 text-left shadow-md shadow-black/25 transition-colors
                                hover:bg-surface-2
                                ${active ? 'border-accent ring-2 ring-accent/40' : c.status === 'needs_you' ? 'border-needs/60' : 'border-line'}`}
                    style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  >
                    <span
                      className={`relative size-2.5 shrink-0 rounded-full ${STATUS_META[c.status].dot}
                                  ${c.status === 'working' || c.status === 'needs_you' ? 'aa-ping' : ''}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 truncate text-[12.5px] font-semibold text-fg">
                        <AgentMark agent={c.agent} />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="block truncate text-[11px] text-fg-subtle">
                        — {statusLine(c)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* side panel */}
          <aside className="aa-scroll w-72 shrink-0 overflow-y-auto border-l border-line bg-surface p-4">
            {inspected ? (
              <ConsoleInspector
                c={inspected}
                team={projectOf(inspected, projects)}
                jobs={jobs
                  .filter((j) => j.toId === inspected.id || j.fromId === inspected.id)
                  .slice(0, 5)}
                now={now}
                onBack={() => setInspect(null)}
                onJump={() => jumpTo(inspected.id)}
              />
            ) : inspectedTeam ? (
              <TeamInspector
                team={inspectedTeam}
                members={model.all.filter((c) => projectOf(c, projects)?.id === inspectedTeam.id)}
                jobs={jobs}
                onBack={() => setInspect(null)}
                onPick={(id) => setInspect({ kind: 'console', id })}
              />
            ) : (
              <Overview
                counts={counts}
                orchestrators={model.orchestrators.length}
                teams={openTeams}
                consoles={total}
              />
            )}
          </aside>
        </div>

        {/* legend */}
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-t border-line px-5 py-2 text-[11px] text-fg-subtle">
          {(['working', 'needs', 'idle', 'done'] as FleetBucket[]).map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${BUCKET_DOT[k]}`} />
              {BUCKET_LABEL[k]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <svg width="22" height="4" aria-hidden>
              <line
                x1="0"
                y1="2"
                x2="22"
                y2="2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
            </svg>
            Command bar only
          </span>
          <span className="ml-auto">
            Click to inspect · Double-click to jump there · Esc to close
          </span>
        </div>
      </div>
    </div>
  );
}

function LeftNode({
  box,
  title,
  subtitle,
  console: c,
  active,
  onClick,
  onDoubleClick,
}: {
  box: Box;
  title: string;
  subtitle: string;
  console?: ConsoleInfo;
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const Icon = c ? Network : User;
  return (
    <button
      type="button"
      data-testid="map-orchestrator"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`absolute flex items-center gap-2.5 rounded-xl border px-3 text-left shadow-lg shadow-black/30 transition-colors
                  ${c ? 'border-accent/50 bg-accent/10 hover:bg-accent/15' : 'border-dashed border-line-strong bg-surface hover:bg-surface-2'}
                  ${active ? 'ring-2 ring-accent/60' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-lg ${c ? 'bg-accent text-accent-fg' : 'bg-hover text-fg-muted'}`}
      >
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-fg">{title}</span>
        <span className="block truncate text-[11px] text-fg-subtle">{subtitle}</span>
      </span>
      {c && (
        <span
          title={STATUS_META[c.status].label}
          className={`relative size-2.5 shrink-0 rounded-full ${STATUS_META[c.status].dot}
                      ${c.status === 'working' || c.status === 'needs_you' ? 'aa-ping' : ''}`}
        />
      )}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-[12.5px]">
      <span className="flex items-center gap-2 text-fg-muted">
        {tone && <span className={`size-2 rounded-full ${tone}`} />}
        {label}
      </span>
      <span className="font-semibold text-fg tabular-nums">{value}</span>
    </div>
  );
}

function Overview({
  counts,
  orchestrators,
  teams,
  consoles,
}: {
  counts: Record<FleetBucket, number>;
  orchestrators: number;
  teams: number;
  consoles: number;
}) {
  const activeLoops = useLoops((s) => activeLoopCount(s.loops));
  return (
    <div data-testid="map-overview">
      <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
        Fleet
      </h3>
      {(['working', 'needs', 'idle', 'done'] as FleetBucket[]).map((k) => (
        <Stat key={k} label={BUCKET_LABEL[k]} value={counts[k]} tone={BUCKET_DOT[k]} />
      ))}
      <h3 className="mt-5 mb-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
        Structure
      </h3>
      <Stat label="Orchestrators" value={orchestrators} />
      <Stat label="Teams" value={teams} />
      <Stat label="Consoles" value={consoles} />
      <Stat label="Active loops" value={activeLoops} />
      <p className="mt-5 text-[11.5px] leading-[17px] text-fg-subtle">
        Click a console or team to inspect it. Double-click to jump to it on the board.
      </p>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-3 text-[11.5px] text-fg-subtle hover:text-fg"
    >
      ← Overview
    </button>
  );
}

function ConsoleInspector({
  c,
  team,
  jobs,
  now,
  onBack,
  onJump,
}: {
  c: ConsoleInfo;
  team?: Project;
  jobs: Job[];
  now: number;
  onBack: () => void;
  onJump: () => void;
}) {
  return (
    <div data-testid="map-inspector">
      <BackButton onClick={onBack} />
      <div className="flex items-center gap-2">
        <AgentMark agent={c.agent} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">{c.name}</span>
        <StatusPill status={c.status} />
      </div>
      <div className="mt-1 text-[11.5px] text-fg-subtle">
        {[...new Set([c.role, team?.name, shortModel(c.model)].filter(Boolean))].join(' · ') ||
          'Console'}
      </div>
      <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-subtle" title={c.cwd}>
        {c.cwd}
      </div>
      <p className="mt-3 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] leading-[17px] text-fg-muted">
        {statusLine(c)}
        <span className="mt-0.5 block text-[10.5px] text-fg-subtle">
          since {relativeTime(c.statusChangedAt, now)}
        </span>
      </p>
      <button
        type="button"
        onClick={onJump}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[12px] font-semibold text-accent-fg hover:brightness-110"
      >
        <Crosshair size={13} />
        Jump there
      </button>
      {c.todos && c.todos.length > 0 && (
        <>
          <h4 className="mt-5 mb-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
            Todos
          </h4>
          <TodoList todos={c.todos} />
        </>
      )}
      {jobs.length > 0 && (
        <>
          <h4 className="mt-5 mb-2 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
            Recent jobs
          </h4>
          <ol className="ml-1 border-l border-line">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} now={now} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function TeamInspector({
  team,
  members,
  jobs,
  onBack,
  onPick,
}: {
  team: Project;
  members: ConsoleInfo[];
  jobs: Job[];
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const color = projectHex(team.color);
  const p = combinedProgress(members, jobs);
  const counts = fleetCounts(members);
  return (
    <div data-testid="map-inspector">
      <BackButton onClick={onBack} />
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-full" style={{ background: color }} />
        <span className="text-[14px] font-semibold text-fg">{team.name}</span>
        {!team.open && <span className="text-[11px] text-fg-subtle">Closed</span>}
      </div>
      <ProgressBar ratio={p.ratio} color={color} className="mt-3" />
      <div className="mt-1 text-[11.5px] text-fg-subtle tabular-nums">
        {p.done}/{p.total} steps
      </div>
      <div className="mt-3">
        {(['working', 'needs', 'idle', 'done'] as FleetBucket[]).map((k) => (
          <Stat key={k} label={BUCKET_LABEL[k]} value={counts[k]} tone={BUCKET_DOT[k]} />
        ))}
      </div>
      <h4 className="mt-4 mb-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
        Consoles
      </h4>
      <ul>
        {[...members].sort(byStatus).map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c.id)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
            >
              <span className={`size-2 shrink-0 rounded-full ${STATUS_META[c.status].dot}`} />
              <AgentMark agent={c.agent} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{c.name}</span>
              <span className="text-[11px] text-fg-subtle">{STATUS_META[c.status].label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
