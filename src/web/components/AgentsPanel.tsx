import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  FolderClosed,
  FolderOpen,
  LayoutTemplate,
  MoreHorizontal,
  Pencil,
  Plus,
  Ungroup,
  X,
} from 'lucide-react';
import type { ConsoleInfo, Project } from '../../shared/protocol';
import { api } from '../lib/api';
import { flyTo } from '../lib/board-actions';
import {
  folderName,
  groupByProject,
  needsYouLabel,
  projectHex,
  rangeBetween,
  shortModel,
} from '../lib/fleet';
import { formatSince } from '../lib/status';
import { useBoard, useClock } from '../lib/store';
import { Avatar, Ring, StatusPill } from './AgentBadges';

const fail = (what: string) => (error: unknown) =>
  useBoard.getState().toast(`${what} failed: ${(error as Error).message}`);

function AgentRow({
  console: c,
  now,
  focused,
  selected,
  onClick,
}: {
  console: ConsoleInfo;
  now: number;
  focused: boolean;
  selected: boolean;
  onClick: (e: MouseEvent, id: string) => void;
}) {
  const meta = [c.role, shortModel(c.model), folderName(c.cwd)].filter(Boolean).join(' · ');
  const needs = c.status === 'needs_you';
  return (
    <button
      type="button"
      data-testid="mission-item"
      data-console-id={c.id}
      data-status={c.status}
      aria-pressed={selected}
      onClick={(e) => onClick(e, c.id)}
      className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors select-none
                  hover:bg-hover
                  ${focused ? 'bg-hover' : ''}
                  ${selected ? 'bg-accent/10 ring-1 ring-accent/50 hover:bg-accent/15' : ''}
                  ${needs && !selected ? 'bg-needs/8 ring-1 ring-needs/35 hover:bg-needs/12' : ''}`}
    >
      <Avatar name={c.name} status={c.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 font-medium text-fg">{c.name}</span>
        <span className="block truncate text-[11.5px] leading-4 text-fg-subtle">{meta}</span>
        {needs && c.statusDetail && (
          <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-4 text-needs/90">
            {c.statusDetail}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <StatusPill status={c.status} />
        <span className="text-[10px] text-fg-subtle tabular-nums">
          {formatSince(c.statusChangedAt, now)}
        </span>
      </span>
    </button>
  );
}

function ProjectMenu({
  project,
  onRename,
  onClose,
}: {
  project: Project;
  onRename: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const item = (icon: ReactNode, label: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose();
        run();
      }}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]
                  hover:bg-hover ${danger ? 'text-error' : 'text-fg'}`}
    >
      {icon}
      {label}
    </button>
  );

  const { upsertProject, removeProject } = useBoard.getState();
  return (
    <div
      ref={ref}
      role="menu"
      className="absolute top-7 right-1 z-30 w-44 rounded-lg border border-line-strong bg-elevated p-1 shadow-xl shadow-black/40"
    >
      {project.open
        ? item(<FolderClosed size={14} />, 'Close project', () =>
            api.closeProject(project.id).then(upsertProject).catch(fail('Close project')),
          )
        : item(<FolderOpen size={14} />, 'Open project', () =>
            api.openProject(project.id).then(upsertProject).catch(fail('Open project')),
          )}
      {item(<Pencil size={14} />, 'Rename', onRename)}
      {item(<Ungroup size={14} />, 'Ungroup', () =>
        api
          .deleteProject(project.id)
          .then(() => removeProject(project.id))
          .catch(fail('Ungroup')),
      )}
    </div>
  );
}

function NameInput({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1 text-[12.5px] text-fg outline-none
                   placeholder:text-fg-subtle focus:border-accent"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="rounded-md bg-accent px-2 py-1 text-[12px] font-semibold text-accent-fg disabled:opacity-40
                   hover:brightness-110"
      >
        {submitLabel}
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="grid size-6 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
      >
        <X size={13} />
      </button>
    </form>
  );
}

function ProjectSection({
  project,
  consoles,
  children,
}: {
  project: Project;
  consoles: ConsoleInfo[];
  children: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const color = projectHex(project.color);
  const working = consoles.filter((c) => c.status === 'working').length;
  const needs = consoles.filter((c) => c.status === 'needs_you').length;
  const count = consoles.length || project.consoleIds.length;

  const rename = (name: string) => {
    setRenaming(false);
    api
      .updateProject(project.id, { name })
      .then(useBoard.getState().upsertProject)
      .catch(fail('Rename'));
  };

  if (renaming) {
    return (
      <section className="mt-3 px-1">
        <NameInput
          initial={project.name}
          placeholder="Project name"
          submitLabel="Save"
          onSubmit={rename}
          onCancel={() => setRenaming(false)}
        />
      </section>
    );
  }

  return (
    <section data-testid="project-section" data-project-id={project.id} className="relative mt-3">
      <div className="group/h flex h-7 items-center gap-1.5 rounded-md pr-1 pl-1.5 hover:bg-hover/60">
        <button
          type="button"
          onClick={() => project.open && setCollapsed(!collapsed)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
          <span
            className="truncate text-[11px] font-semibold tracking-wider uppercase"
            style={{ color }}
          >
            {project.name}
          </span>
          {project.open ? (
            <span className="shrink-0 text-[11px] text-fg-subtle tabular-nums">
              {working}/{count} working
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-fg-subtle">Closed · {count} agents</span>
          )}
          {needs > 0 && (
            <span className="shrink-0 rounded-full bg-needs/15 px-1.5 text-[10px] font-semibold text-needs">
              {needsYouLabel(needs)}
            </span>
          )}
          {project.open && (
            <ChevronDown
              size={12}
              className={`shrink-0 text-fg-subtle transition-transform ${collapsed ? '-rotate-90' : ''}`}
            />
          )}
        </button>
        {!project.open && (
          <button
            type="button"
            data-testid="project-open"
            onClick={() =>
              api
                .openProject(project.id)
                .then(useBoard.getState().upsertProject)
                .catch(fail('Open project'))
            }
            className="rounded-md px-2 py-0.5 text-[11.5px] font-semibold text-accent ring-1 ring-accent/40
                       hover:bg-accent/10"
          >
            Open
          </button>
        )}
        <button
          type="button"
          aria-label={`${project.name} menu`}
          onClick={() => setMenu(!menu)}
          className={`grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg
                      ${menu ? 'bg-hover text-fg' : 'opacity-0 group-hover/h:opacity-100 focus-visible:opacity-100'}`}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {menu && (
        <ProjectMenu
          project={project}
          onRename={() => setRenaming(true)}
          onClose={() => setMenu(false)}
        />
      )}
      {project.open && !collapsed && (
        <div
          className="mt-0.5 ml-[7px] flex flex-col gap-0.5 border-l pl-1.5"
          style={{ borderColor: `${color}40` }}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export function AgentsPanel() {
  const consoles = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  const selectedId = useBoard((s) => s.selectedId);
  const selectedIds = useBoard((s) => s.selectedIds);
  const now = useClock((s) => s.now);
  const anchor = useRef<string | null>(null);
  const [grouping, setGrouping] = useState(false);

  const list = Object.values(consoles);
  const { groups, ungrouped } = groupByProject(list, projects);
  const projectCount = groups.length;
  const working = list.filter((c) => c.status === 'working').length;
  const order = [
    ...groups.filter((g) => g.project.open).flatMap((g) => g.consoles.map((c) => c.id)),
    ...ungrouped.map((c) => c.id),
  ];
  const selectedConsoles = selectedIds.filter((id) => consoles[id]);
  const { setSelectedIds, toggleSelected, select, setNewAgentOpen, setTemplatesOpen } =
    useBoard.getState();

  useEffect(() => {
    if (selectedConsoles.length < 2) setGrouping(false);
  }, [selectedConsoles.length]);

  const onRowClick = (e: MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelected(id);
      anchor.current = id;
      select(id);
    } else if (e.shiftKey) {
      const from = anchor.current ?? selectedId ?? id;
      setSelectedIds(rangeBetween(order, from, id));
      select(id);
    } else {
      anchor.current = id;
      setSelectedIds([id]);
      void flyTo(id);
    }
  };

  const groupSelected = (name: string) => {
    setGrouping(false);
    api
      .createProject({ name, consoleIds: selectedConsoles })
      .then((project) => {
        useBoard.getState().upsertProject(project);
        setSelectedIds([]);
      })
      .catch(fail('Group as project'));
  };

  const row = (c: ConsoleInfo) => (
    <AgentRow
      key={c.id}
      console={c}
      now={now}
      focused={c.id === selectedId}
      selected={selectedIds.length > 1 && selectedIds.includes(c.id)}
      onClick={onRowClick}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <Ring ratio={list.length ? working / list.length : 0} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-semibold text-fg">Orchestrator</span>
            <span className="text-[11.5px] text-fg-subtle tabular-nums">
              {working}/{list.length}
            </span>
          </div>
          <div className="truncate text-[11.5px] text-fg-subtle">
            {list.length} {list.length === 1 ? 'agent' : 'agents'} · {projectCount}{' '}
            {projectCount === 1 ? 'project' : 'projects'}
          </div>
        </div>
        <button
          type="button"
          title="New agent (N)"
          aria-label="New agent"
          onClick={() => setNewAgentOpen(true)}
          className="grid size-7 place-items-center rounded-md border border-line text-fg-muted
                     hover:border-line-strong hover:bg-hover hover:text-fg"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          title="Launch a team from a template"
          onClick={() => setTemplatesOpen(true)}
          className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] font-medium text-fg-muted
                     hover:border-line-strong hover:bg-hover hover:text-fg"
        >
          <LayoutTemplate size={13} />
          Templates
        </button>
      </div>

      {selectedConsoles.length >= 2 && (
        <div
          data-testid="group-bar"
          className="mx-2 mb-1 shrink-0 rounded-lg border border-accent/40 bg-accent/8 p-2"
        >
          {grouping ? (
            <NameInput
              initial=""
              placeholder="Project name, e.g. Frontend"
              submitLabel="Group"
              onSubmit={groupSelected}
              onCancel={() => setGrouping(false)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-fg-muted">
                <span className="font-semibold text-fg">{selectedConsoles.length}</span> selected
              </span>
              <button
                type="button"
                onClick={() => setGrouping(true)}
                className="ml-auto rounded-md bg-accent px-2 py-1 text-[12px] font-semibold text-accent-fg hover:brightness-110"
              >
                Group as project
              </button>
              <button
                type="button"
                aria-label="Clear selection"
                onClick={() => setSelectedIds([])}
                className="grid size-6 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      <nav
        data-testid="mission-list"
        className="aa-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        {list.length === 0 && groups.length === 0 && (
          <div className="px-3 py-10 text-center">
            <p className="text-fg-muted">No agents yet.</p>
            <p className="mt-1 text-[12px] text-fg-subtle">
              Press <kbd className="rounded border border-line px-1 font-mono text-[10px]">N</kbd>{' '}
              to start one, or launch a team from a template.
            </p>
          </div>
        )}
        {groups.map((g) => (
          <ProjectSection key={g.project.id} project={g.project} consoles={g.consoles}>
            {g.consoles.map(row)}
          </ProjectSection>
        ))}
        {ungrouped.length > 0 && (
          <section className="mt-3">
            {groups.length > 0 && (
              <h3 className="mb-1 flex h-7 items-center gap-1.5 px-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
                <span className="size-2 rounded-full border border-fg-subtle" />
                Ungrouped
                <span className="font-normal tabular-nums normal-case">{ungrouped.length}</span>
              </h3>
            )}
            <div className="flex flex-col gap-0.5">{ungrouped.map(row)}</div>
          </section>
        )}
        {list.length >= 2 && selectedConsoles.length < 2 && (
          <p className="mt-4 px-2 text-center text-[11px] text-fg-subtle">
            Ctrl/Shift+click agents to group them into a project.
          </p>
        )}
      </nav>
    </div>
  );
}
