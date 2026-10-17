import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import type { ConsoleInfo } from '../../shared/protocol';
import { flyTo } from '../lib/board-actions';
import { STATUS_META, basename, formatSince } from '../lib/status';
import { useBoard, useClock } from '../lib/store';
import { StatusDot } from './StatusDot';

interface Group {
  key: string;
  label: string;
  items: ConsoleInfo[];
  tone: string;
}

function groupConsoles(consoles: ConsoleInfo[]): Group[] {
  const byRank = (a: ConsoleInfo, b: ConsoleInfo) =>
    STATUS_META[a.status].rank - STATUS_META[b.status].rank ||
    a.statusChangedAt - b.statusChangedAt;
  const needs = consoles.filter((c) => c.status === 'needs_you').sort(byRank);
  const working = consoles.filter((c) => c.status === 'working').sort(byRank);
  const rest = consoles
    .filter((c) => c.status !== 'needs_you' && c.status !== 'working')
    .sort(byRank);
  return [
    { key: 'needs', label: 'Needs you', items: needs, tone: 'text-needs' },
    { key: 'working', label: 'Working', items: working, tone: 'text-working' },
    { key: 'other', label: 'Other', items: rest, tone: 'text-fg-subtle' },
  ].filter((g) => g.items.length > 0);
}

function MissionItem({
  console: c,
  now,
  selected,
}: {
  console: ConsoleInfo;
  now: number;
  selected: boolean;
}) {
  const meta = STATUS_META[c.status];
  return (
    <button
      type="button"
      data-testid="mission-item"
      data-console-id={c.id}
      data-status={c.status}
      onClick={() => void flyTo(c.id)}
      className={`group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors
                  hover:bg-hover
                  ${selected ? 'bg-hover' : ''}
                  ${c.status === 'needs_you' ? 'bg-needs/10 ring-1 ring-needs/40 hover:bg-needs/15' : ''}`}
    >
      <span className="mt-[5px]">
        <StatusDot status={c.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-medium text-fg">{c.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-fg-subtle tabular-nums">
            {formatSince(c.statusChangedAt, now)}
          </span>
        </span>
        <span className="flex items-baseline gap-2 text-[12px]">
          <span className={`shrink-0 ${meta.text}`}>{meta.label}</span>
          <span className="truncate font-mono text-[11px] text-fg-subtle">{basename(c.cwd)}</span>
        </span>
        {c.statusDetail && c.status === 'needs_you' && (
          <span className="mt-1 line-clamp-2 block text-[12px] text-fg-muted">
            {c.statusDetail}
          </span>
        )}
      </span>
    </button>
  );
}

export function Sidebar() {
  const open = useBoard((s) => s.sidebarOpen);
  const consoles = useBoard((s) => s.consoles);
  const selectedId = useBoard((s) => s.selectedId);
  const now = useClock((s) => s.now);
  const list = Object.values(consoles);
  const needsCount = list.filter((c) => c.status === 'needs_you').length;
  const workingCount = list.filter((c) => c.status === 'working').length;
  const { setSidebarOpen, setNewAgentOpen } = useBoard.getState();

  if (!open) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-3">
        <button
          type="button"
          title="Show mission list"
          aria-label="Show mission list"
          onClick={() => setSidebarOpen(true)}
          className="grid size-8 place-items-center rounded-md text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          <PanelLeftOpen size={16} />
        </button>
        {needsCount > 0 && (
          <span
            title={`${needsCount} need you`}
            className="grid size-6 place-items-center rounded-full bg-needs text-[11px] font-bold text-black"
          >
            {needsCount}
          </span>
        )}
      </aside>
    );
  }

  const groups = groupConsoles(list);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <img src="/icon.svg" alt="" className="size-5" />
        <span className="font-semibold tracking-tight text-fg">AgentArmy</span>
        <span className="ml-auto" />
        <button
          type="button"
          title="Hide mission list"
          aria-label="Hide mission list"
          onClick={() => setSidebarOpen(false)}
          className="grid size-8 place-items-center rounded-md text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-3 px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
        <span>Missions</span>
        <span className="ml-auto flex items-center gap-3 normal-case">
          <span className={needsCount ? 'text-needs' : ''}>{needsCount} need you</span>
          <span className={workingCount ? 'text-working' : ''}>{workingCount} working</span>
          <span>{list.length} total</span>
        </span>
      </div>

      <nav
        data-testid="mission-list"
        className="aa-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {groups.length === 0 && (
          <p className="px-2.5 py-6 text-center text-fg-subtle">No agents yet.</p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="mt-3">
            <h3
              className={`mb-1 px-2.5 text-[11px] font-semibold tracking-wide uppercase ${group.tone}`}
            >
              {group.label}
              <span className="ml-1.5 text-fg-subtle">{group.items.length}</span>
            </h3>
            <div className="flex flex-col gap-0.5">
              {group.items.map((c) => (
                <MissionItem key={c.id} console={c} now={now} selected={c.id === selectedId} />
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="shrink-0 border-t border-line p-2">
        <button
          type="button"
          onClick={() => setNewAgentOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          <Plus size={15} />
          New agent
          <kbd className="ml-auto rounded border border-line px-1.5 font-mono text-[10px] text-fg-subtle">
            N
          </kbd>
        </button>
      </div>
    </aside>
  );
}
