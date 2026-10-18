import { ExternalLink, MonitorUp, Undo2 } from 'lucide-react';
import { bringBack, openPopout, usePopouts } from '../lib/popout';
import { popoutKey, type PopoutView } from '../lib/views';

// Buttons and overlays for pop-out windows (see lib/popout.ts)

export function PopOutButton({
  view,
  label = 'Pop out to a new window',
  testId,
  size = 13,
}: {
  view: PopoutView;
  label?: string;
  testId?: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        openPopout(view);
      }}
      className="nodrag grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors
                 hover:bg-hover hover:text-accent"
    >
      <ExternalLink size={size} />
    </button>
  );
}

// Covers a console on the main board while it lives in another window
export function PoppedOutOverlay({ popoutKeyName, name }: { popoutKeyName: string; name: string }) {
  const entry = usePopouts((s) => s.open[popoutKeyName]);
  const where = entry?.view.kind === 'project' ? 'its project window' : 'another window';
  return (
    <div
      data-testid="console-popped-out"
      className="absolute inset-0 z-[2] grid place-items-center bg-term/90 p-6 text-center backdrop-blur-[1px]"
    >
      <div>
        <MonitorUp size={22} className="mx-auto text-fg-subtle" />
        <p className="mt-2 text-[13px] font-semibold text-term-fg">Open in {where}</p>
        <p className="mt-1 max-w-xs text-[12px] text-term-fg/60">
          {name} keeps running there. Bring it back to use it on this board again.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <button
            type="button"
            data-testid="popout-focus"
            onClick={() => entry && openPopout(entry.view)}
            className="nodrag inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-3 text-[12px] font-medium text-term-fg
                       hover:bg-hover"
          >
            <ExternalLink size={12} />
            Show window
          </button>
          <button
            type="button"
            data-testid="popout-bring-back"
            onClick={() => bringBack(popoutKeyName)}
            className="aa-btn-primary nodrag inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold"
          >
            <Undo2 size={12} />
            Bring back
          </button>
        </div>
      </div>
    </div>
  );
}

// Small tag for project frames and lists: "in window · Bring back"
export function ProjectPoppedOutTag({ projectId }: { projectId: string }) {
  const key = popoutKey({ kind: 'project', id: projectId });
  const open = usePopouts((s) => !!s.open[key]);
  if (!open) return null;
  return (
    <button
      type="button"
      data-testid="project-bring-back"
      title="This project is open in another window. Click to bring it back."
      onClick={(e) => {
        e.stopPropagation();
        bringBack(key);
      }}
      className="nodrag inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[0.9em] font-medium text-fg-muted
                 hover:text-fg"
    >
      <MonitorUp style={{ width: '1em', height: '1em' }} />
      In window · Bring back
    </button>
  );
}

export const consoleView = (id: string): PopoutView => ({ kind: 'console', id });
export const projectView = (id: string): PopoutView => ({ kind: 'project', id });
