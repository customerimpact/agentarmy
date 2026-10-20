import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type Node, type NodeProps } from '@xyflow/react';
import { Check, ChevronDown, ExternalLink, FolderX, Pencil, Ungroup } from 'lucide-react';
import { PROJECT_COLORS, type ProjectColor } from '../../shared/protocol';
import { api } from '../lib/api';
import { FRAME_TITLE } from '../lib/arrange';
import { projectColor } from '../lib/board-ui';
import { useBoard } from '../lib/store';
import { openPopout } from '../lib/popout';
import { ProjectPoppedOutTag } from './PopoutControls';
import { MoveProjectMenuItems } from './WorkspaceTabs';
import { TeamMenuItems } from './TeamControls';

export type FrameFlowNode = Node<{ projectId: string }, 'frame'>;

// "4 · 2 working · 1 needs you" for the frame title; a string so the selector stays cheap
function useMemberSummary(projectId: string): string {
  return useBoard((s) => {
    const project = s.projects[projectId];
    if (!project) return '';
    let total = 0;
    let working = 0;
    let needs = 0;
    for (const id of project.consoleIds) {
      const c = s.consoles[id];
      if (!c) continue;
      total++;
      if (c.status === 'working') working++;
      else if (c.status === 'needs_you') needs++;
    }
    const parts = [String(total), working ? `${working} working` : 'idle'];
    if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
    return parts.join(' · ');
  });
}

function FrameMenu({
  projectId,
  anchor,
  onClose,
  onRename,
}: {
  projectId: string;
  anchor: DOMRect;
  onClose: () => void;
  onRename: () => void;
}) {
  const project = useBoard((s) => s.projects[projectId]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (ref.current?.contains(target)) return;
      // The chevron toggles the menu itself; closing here would make it reopen on click
      if (target.closest?.('[data-testid="project-frame-menu-button"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  if (!project) return null;
  const { toast, upsertProject, askConfirm } = useBoard.getState();

  const setColor = async (color: ProjectColor) => {
    upsertProject({ ...project, color });
    try {
      upsertProject(await api.updateProject(project.id, { color }));
    } catch (error) {
      toast(`Could not change the color: ${(error as Error).message}`);
    }
  };

  const closeProject = () => {
    onClose();
    askConfirm({
      title: `Close ${project.name}?`,
      message: `Its ${project.consoleIds.length} console${project.consoleIds.length === 1 ? '' : 's'} stop and leave the board. Open the project again to resume every conversation where it stopped.`,
      confirmLabel: 'Close project',
      onConfirm: async () => {
        try {
          upsertProject(await api.closeProject(project.id));
        } catch (error) {
          toast(`Could not close the project: ${(error as Error).message}`);
        }
      },
    });
  };

  const ungroup = async () => {
    onClose();
    try {
      await api.deleteProject(project.id);
      const board = useBoard.getState();
      board.removeProject(project.id);
      for (const id of project.consoleIds) {
        const c = useBoard.getState().consoles[id];
        if (c?.projectId === project.id) board.upsertConsole({ ...c, projectId: null });
      }
    } catch (error) {
      toast(`Could not ungroup: ${(error as Error).message}`);
    }
  };

  const item = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-fg
                hover:bg-hover`;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="project-frame-menu"
      className="fixed z-50 w-52 rounded-xl border border-line-strong bg-elevated p-1.5 shadow-2xl shadow-black/40"
      style={{ left: anchor.left, top: anchor.bottom + 6 }}
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <Pencil size={13} className="text-fg-subtle" />
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-popout"
        className={item}
        onClick={() => {
          onClose();
          openPopout({ kind: 'project', id: project.id });
        }}
      >
        <ExternalLink size={13} className="text-fg-subtle" />
        Pop out to a window
      </button>
      <MoveProjectMenuItems projectId={project.id} onDone={onClose} className={item} />
      <TeamMenuItems projectId={project.id} onDone={onClose} className={item} />
      <div className="flex items-center gap-1.5 px-2 py-2">
        {PROJECT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={`Color ${color}`}
            onClick={() => void setColor(color)}
            className="grid size-5 place-items-center rounded-full ring-offset-2 ring-offset-elevated
                       hover:ring-2 hover:ring-line-strong"
            style={{ background: projectColor(color) }}
          >
            {project.color === color && <Check size={11} strokeWidth={3} className="text-black/70" />}
          </button>
        ))}
      </div>
      <div className="my-1 border-t border-line" />
      <button type="button" role="menuitem" className={item} onClick={closeProject}>
        <FolderX size={13} className="text-fg-subtle" />
        Close project
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => void ungroup()}>
        <Ungroup size={13} className="text-fg-subtle" />
        Ungroup
      </button>
    </div>,
    document.body,
  );
}

function ProjectFrameImpl({ data }: NodeProps<FrameFlowNode>) {
  const { projectId } = data;
  const project = useBoard((s) => s.projects[projectId]);
  const summary = useMemberSummary(projectId);
  // Keep the title readable when zoomed far out (grows above the frame instead of shrinking)
  const titleScale = useStore((s) => Math.min(2.4, Math.max(1, 0.85 / s.transform[2])));
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!project) return null;
  const color = projectColor(project.color);

  const startRename = () => {
    setDraft(project.name);
    setEditing(true);
  };

  const commitRename = async () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === project.name) return;
    const { upsertProject, toast } = useBoard.getState();
    upsertProject({ ...project, name });
    try {
      upsertProject(await api.updateProject(project.id, { name }));
    } catch (error) {
      toast(`Could not rename: ${(error as Error).message}`);
    }
  };

  return (
    <div
      data-testid="project-frame"
      data-project-id={project.id}
      className="relative h-full w-full rounded-xl"
      style={{
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 3%, transparent)`,
      }}
    >
      <div
        className="aa-frame-handle absolute inset-x-0 flex cursor-grab items-center gap-2 px-3.5 select-none
                   active:cursor-grabbing"
        style={{
          pointerEvents: 'auto',
          bottom: `calc(100% - ${FRAME_TITLE}px)`,
          minHeight: FRAME_TITLE,
          fontSize: 11 * titleScale,
        }}
        title="Drag to move the project · click to select its consoles"
        onDoubleClick={startRename}
      >
        <span
          className="shrink-0 rounded-[2px]"
          style={{
            width: '0.65em',
            height: '0.65em',
            background: color,
          }}
        />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            aria-label="Project name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="nodrag min-w-0 rounded-md border border-line-strong bg-surface px-1.5 py-0.5 font-semibold tracking-[0.12em] text-fg uppercase outline-none"
            style={{ fontSize: '1em' }}
          />
        ) : (
          <span
            data-testid="project-frame-title"
            className="truncate font-mono font-semibold tracking-[0.08em] uppercase"
            style={{ color }}
          >
            {project.name}
          </span>
        )}
        <span className="shrink-0 font-mono text-fg-subtle tabular-nums">{summary}</span>
        <ProjectPoppedOutTag projectId={project.id} />
        <button
          ref={chevronRef}
          type="button"
          aria-label="Project menu"
          data-testid="project-frame-menu-button"
          onClick={() => setMenu(menu ? null : (chevronRef.current?.getBoundingClientRect() ?? null))}
          className="nodrag grid shrink-0 place-items-center rounded-md text-fg-subtle
                     hover:bg-hover hover:text-fg"
          style={{ width: '1.9em', height: '1.9em' }}
        >
          <ChevronDown style={{ width: '1.2em', height: '1.2em' }} />
        </button>
      </div>
      {menu && (
        <FrameMenu
          projectId={project.id}
          anchor={menu}
          onClose={() => setMenu(null)}
          onRename={startRename}
        />
      )}
    </div>
  );
}

export const ProjectFrame = memo(ProjectFrameImpl);
