import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, FolderInput, Plus, X } from 'lucide-react';
import type { Workspace } from '../../shared/protocol';
import { switchWorkspace } from '../lib/board-actions';
import {
  deleteWorkspace,
  moveToWorkspace,
  newWorkspace,
  renameWorkspace,
  reorderWorkspaces,
  selectionForMove,
  workspaceContents,
} from '../lib/item-actions';
import { useItems, workspaceOf } from '../lib/items';
import { useBoard } from '../lib/store';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// Consoles waiting on the user, per workspace
export function useNeedsYouByWorkspace(): Record<string, number> {
  const consoles = useBoard((s) => s.consoles);
  const out: Record<string, number> = {};
  for (const c of Object.values(consoles)) {
    if (c.status !== 'needs_you') continue;
    const ws = workspaceOf(c);
    out[ws] = (out[ws] ?? 0) + 1;
  }
  return out;
}

function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, onClose]);
}

// Floating list of workspaces (portal, so board zoom never scales it)
export function WorkspacePickerPopover({
  anchor,
  title,
  exclude,
  onPick,
  onClose,
  footer,
}: {
  anchor: DOMRect;
  title: string;
  exclude?: string;
  onPick: (workspaceId: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const workspaces = useItems((s) => s.workspaces);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const left = Math.min(anchor.left, window.innerWidth - 240);
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 220);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="workspace-picker"
      className="fixed z-50 w-56 rounded-xl border border-line-strong bg-elevated p-1.5 text-[12.5px] text-fg shadow-2xl shadow-black/40"
      style={{ left, top }}
    >
      <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{title}</div>
      {workspaces
        .filter((w) => w.id !== exclude)
        .map((w) => (
          <button
            key={w.id}
            type="button"
            role="menuitem"
            data-testid={`workspace-pick-${w.name}`}
            onClick={() => onPick(w.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
          >
            <FolderInput size={13} className="text-fg-subtle" />
            <span className="truncate">{w.name}</span>
          </button>
        ))}
      {footer}
    </div>,
    document.body,
  );
}

// "Move to workspace…" for one console (terminal header), only when there is somewhere to go
export function MoveToWorkspaceButton({ consoleId, className = '' }: { consoleId: string; className?: string }) {
  const many = useItems((s) => s.workspaces.length > 1);
  const current = useBoard((s) => workspaceOf(s.consoles[consoleId]));
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!many) return null;
  return (
    <>
      <button
        type="button"
        title="Move to workspace…"
        aria-label="Move to workspace"
        data-testid="console-move-workspace"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        className={`nodrag grid size-6 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-accent ${className}`}
      >
        <FolderInput size={13} />
      </button>
      {anchor && (
        <WorkspacePickerPopover
          anchor={anchor}
          title="Move to workspace"
          exclude={current}
          onClose={() => setAnchor(null)}
          onPick={(ws) => {
            setAnchor(null);
            // Moving a selected console takes the rest of the selection along
            const sel = selectionForMove();
            const ids = sel.consoleIds.includes(consoleId) ? sel : { consoleIds: [consoleId] };
            void moveToWorkspace(ws, ids);
          }}
        />
      )}
    </>
  );
}

// Menu rows for project menus: one "Move to <workspace>" per other workspace
export function MoveProjectMenuItems({
  projectId,
  onDone,
  className,
}: {
  projectId: string;
  onDone: () => void;
  className: string;
}) {
  const workspaces = useItems((s) => s.workspaces);
  const current = useBoard((s) => workspaceOf(s.projects[projectId]));
  const others = workspaces.filter((w) => w.id !== current);
  if (!others.length) return null;
  return (
    <>
      {others.map((w) => (
        <button
          key={w.id}
          type="button"
          role="menuitem"
          data-testid={`project-move-${w.name}`}
          className={className}
          onClick={() => {
            onDone();
            void moveToWorkspace(w.id, { projectIds: [projectId] });
          }}
        >
          <FolderInput size={14} />
          <span className="truncate">Move to {w.name}</span>
        </button>
      ))}
    </>
  );
}

// Selection bar: move everything selected
export function MoveSelectionButton({ className }: { className: string }) {
  const many = useItems((s) => s.workspaces.length > 1);
  const active = useItems((s) => s.activeWorkspaceId);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!many) return null;
  return (
    <>
      <button
        type="button"
        data-testid="selection-move-workspace"
        className={className}
        title="Move the selection to another workspace"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <FolderInput size={13} />
        Move to…
      </button>
      {anchor && (
        <WorkspacePickerPopover
          anchor={anchor}
          title="Move selection to"
          exclude={active}
          onClose={() => setAnchor(null)}
          onPick={(ws) => {
            setAnchor(null);
            void moveToWorkspace(ws, selectionForMove());
          }}
        />
      )}
    </>
  );
}

function Tab({
  ws,
  active,
  needsYou,
  canClose,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  ws: Workspace;
  active: boolean;
  needsYou: number;
  canClose: boolean;
  dragOver: 'before' | 'after' | null;
  onDragStart: () => void;
  onDragOver: (side: 'before' | 'after') => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ws.name);
  const [closeAnchor, setCloseAnchor] = useState<DOMRect | null>(null);

  const askClose = (rect: DOMRect) => {
    const contents = workspaceContents(ws.id);
    if (contents.total === 0) void deleteWorkspace(ws.id);
    else setCloseAnchor(rect);
  };

  const contents = closeAnchor ? workspaceContents(ws.id) : null;
  const what = contents
    ? [
        contents.consoles && plural(contents.consoles, 'agent'),
        contents.browsers && plural(contents.browsers, 'browser tile'),
        contents.items && plural(contents.items, 'item'),
      ]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid="workspace-tab"
      data-workspace={ws.name}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-agentarmy-workspace', ws.id);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientX < box.left + box.width / 2 ? 'before' : 'after');
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      onClick={() => !editing && void switchWorkspace(ws.id)}
      onDoubleClick={() => {
        setDraft(ws.name);
        setEditing(true);
      }}
      className={`group/tab relative flex h-7 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border pr-1 pl-2.5 text-[12px] font-medium transition-colors select-none
                  ${active ? 'border-line-strong bg-elevated text-fg' : 'border-line bg-surface/90 text-fg-muted hover:bg-hover hover:text-fg'}`}
    >
      {dragOver && (
        <span className={`absolute top-1 bottom-1 w-0.5 rounded bg-accent ${dragOver === 'before' ? '-left-1' : '-right-1'}`} />
      )}
      {active && <span className="absolute inset-x-2.5 -bottom-px h-0.5 rounded-full bg-accent" />}
      {editing ? (
        <input
          autoFocus
          data-testid="workspace-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft.trim() !== ws.name) void renameWorkspace(ws.id, draft);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(ws.name);
              setEditing(false);
            }
          }}
          className="w-28 rounded bg-canvas px-1 text-fg outline-none ring-1 ring-accent"
        />
      ) : (
        <span className="truncate" title={`${ws.name} (double-click to rename)`}>
          {ws.name}
        </span>
      )}
      {needsYou > 0 && (
        <span
          data-testid="workspace-needs-you"
          title={`${plural(needsYou, 'agent')} waiting on you`}
          className="grid h-4 min-w-4 place-items-center rounded-full bg-needs px-1 text-[10px] leading-none font-bold text-black tabular-nums"
        >
          {needsYou}
        </span>
      )}
      {canClose && !editing ? (
        <button
          type="button"
          aria-label={`Close ${ws.name}`}
          data-testid="workspace-close"
          onClick={(e) => {
            e.stopPropagation();
            askClose(e.currentTarget.getBoundingClientRect());
          }}
          className={`grid size-5 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-fg
                      ${active ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-70'}`}
        >
          <X size={12} />
        </button>
      ) : (
        <span className="w-1" />
      )}
      {closeAnchor && (
        <WorkspacePickerPopover
          anchor={closeAnchor}
          title={`Move ${what} to…`}
          exclude={ws.id}
          onClose={() => setCloseAnchor(null)}
          onPick={(target) => {
            setCloseAnchor(null);
            void deleteWorkspace(ws.id, target);
          }}
          footer={
            <p className="px-2 pt-1.5 pb-1 text-[11px] leading-snug text-fg-subtle">
              Agents keep running; the tab closes after the move.
            </p>
          }
        />
      )}
    </div>
  );
}

// Tab strip at the top of the board: one tab per workspace
export function WorkspaceTabs() {
  const workspaces = useItems((s) => s.workspaces);
  const active = useItems((s) => s.activeWorkspaceId);
  const needs = useNeedsYouByWorkspace();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

  const drop = () => {
    if (!drag || !over || drag === over.id) return;
    const ids = workspaces.map((w) => w.id).filter((id) => id !== drag);
    const at = ids.indexOf(over.id) + (over.side === 'after' ? 1 : 0);
    ids.splice(at, 0, drag);
    void reorderWorkspaces(ids);
  };

  return (
    <div
      role="tablist"
      aria-label="Workspaces"
      data-testid="workspace-tabs"
      className="aa-scroll-x flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5"
    >
      {workspaces.map((ws) => (
        <Tab
          key={ws.id}
          ws={ws}
          active={ws.id === active}
          needsYou={needs[ws.id] ?? 0}
          canClose={workspaces.length > 1}
          dragOver={drag && over?.id === ws.id && drag !== ws.id ? over.side : null}
          onDragStart={() => setDrag(ws.id)}
          onDragOver={(side) => drag && setOver({ id: ws.id, side })}
          onDrop={() => {
            drop();
            setDrag(null);
            setOver(null);
          }}
          onDragEnd={() => {
            setDrag(null);
            setOver(null);
          }}
        />
      ))}
      <button
        type="button"
        data-testid="workspace-new"
        title="New workspace"
        aria-label="New workspace"
        onClick={() => void newWorkspace()}
        className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface/90 text-fg-muted
                   hover:bg-hover hover:text-fg"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

// Sidebar: a collapsible workspace heading above that workspace's agents
export function WorkspaceSection({
  workspace,
  count,
  children,
}: {
  workspace: Workspace;
  count: number;
  children: ReactNode;
}) {
  const active = useItems((s) => s.activeWorkspaceId === workspace.id);
  const needs = useNeedsYouByWorkspace()[workspace.id] ?? 0;
  const [open, setOpen] = useState(true);
  return (
    <section data-testid="sidebar-workspace" data-workspace={workspace.name} className="mt-2 first:mt-1">
      <h3 className="flex h-7 items-center gap-1 px-1 text-[11px] font-semibold tracking-wider uppercase">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
          onClick={() => setOpen(!open)}
          className="grid size-5 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-fg"
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          onClick={() => void switchWorkspace(workspace.id)}
          title="Show this workspace"
          className={`truncate hover:text-fg ${active ? 'text-fg' : 'text-fg-subtle'}`}
        >
          {workspace.name}
        </button>
        <span className="font-normal text-fg-subtle tabular-nums normal-case">{count}</span>
        {needs > 0 && (
          <span className="ml-1 grid h-4 min-w-4 place-items-center rounded-full bg-needs px-1 text-[10px] leading-none font-bold text-black normal-case">
            {needs}
          </span>
        )}
        {active && <span className="ml-auto size-1.5 rounded-full bg-accent" title="On screen" />}
      </h3>
      {open && <div className="pl-1">{children}</div>}
    </section>
  );
}
