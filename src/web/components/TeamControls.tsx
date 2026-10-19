import { useState } from 'react';
import { MessageSquare, Pause, Play, Repeat, SendHorizontal } from 'lucide-react';
import { agentsLabel, pauseAll, resumePaused, teamApi, useLoops } from '../lib/loops';
import { useBoard } from '../lib/store';

// Pause all / Resume all (optionally one project) and the "Paused" pill.

export function usePausedCount(projectId?: string): number {
  return useBoard((s) => {
    const ids = projectId ? (s.projects[projectId]?.consoleIds ?? []) : Object.keys(s.consoles);
    return ids.filter((id) => s.consoles[id]?.paused).length;
  });
}

export function useWorkingCount(projectId?: string): number {
  return useBoard((s) => {
    const ids = projectId ? (s.projects[projectId]?.consoleIds ?? []) : Object.keys(s.consoles);
    return ids.filter((id) => s.consoles[id]?.status === 'working').length;
  });
}

export function PausedPill() {
  return (
    <span
      data-testid="paused-pill"
      title="Paused by Pause all. Resume all types “Continue where you left off.”"
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-project-amber/12 px-1.5 py-[1px] text-[10.5px] font-semibold text-project-amber ring-1 ring-project-amber/35"
    >
      <Pause size={9} strokeWidth={3} />
      Paused
    </span>
  );
}

// Project menu entries (board frame menu): message the whole team, pause / resume it, add a loop
export function TeamMenuItems({ projectId, onDone, className }: { projectId: string; onDone: () => void; className: string }) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState('');
  const working = useWorkingCount(projectId);
  const paused = usePausedCount(projectId);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const { toast } = useBoard.getState();
    try {
      const res = await teamApi.sendToProject(projectId, body);
      toast(
        res.sent
          ? `Sent to ${agentsLabel(res.sent)}${res.skipped.length ? ` (skipped ${res.skipped.join(', ')})` : ''}`
          : 'No agent in this project is running',
      );
      onDone();
    } catch (error) {
      toast(`Send failed: ${(error as Error).message}`);
    }
  };

  return (
    <>
      {composing ? (
        <form
          data-testid="project-message-form"
          className="flex items-center gap-1 px-1 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            autoFocus
            data-testid="project-message-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Message every agent…"
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1 text-[12px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <button
            type="submit"
            aria-label="Send to team"
            data-testid="project-message-send"
            disabled={!text.trim()}
            className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-40"
          >
            <SendHorizontal size={12} />
          </button>
        </form>
      ) : (
        <button type="button" role="menuitem" data-testid="project-message-team" className={className} onClick={() => setComposing(true)}>
          <MessageSquare size={13} className="text-fg-subtle" />
          Message team
        </button>
      )}
      {working > 0 && (
        <button
          type="button"
          role="menuitem"
          data-testid="project-pause"
          className={className}
          onClick={() => {
            onDone();
            void pauseAll(projectId);
          }}
        >
          <Pause size={13} className="text-fg-subtle" />
          Pause team ({working} working)
        </button>
      )}
      {paused > 0 && (
        <button
          type="button"
          role="menuitem"
          data-testid="project-resume"
          className={className}
          onClick={() => {
            onDone();
            void resumePaused(projectId);
          }}
        >
          <Play size={13} className="text-fg-subtle" />
          Resume team ({paused})
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="project-new-loop"
        className={className}
        onClick={() => {
          onDone();
          useLoops.getState().openLoops({ id: 'new', projectId });
        }}
      >
        <Repeat size={13} className="text-fg-subtle" />
        New loop for this team
      </button>
    </>
  );
}

// Sidebar (Agents tab) header button: opens the Loops list, shows how many are active
export function LoopsButton() {
  const active = useLoops((s) => Object.values(s.loops).filter((l) => l.enabled).length);
  return (
    <button
      type="button"
      data-testid="loops-button"
      title="Loops: re-send a prompt on a schedule, on idle or on output"
      onClick={() => useLoops.getState().openLoops()}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium
                  hover:border-line-strong hover:bg-hover hover:text-fg
                  ${active ? 'border-accent/40 text-fg' : 'border-line text-fg-muted'}`}
    >
      <Repeat size={13} className={active ? 'text-accent' : ''} />
      Loops
      {active > 0 && (
        <span data-testid="loops-active-count" className="rounded-full bg-accent/15 px-1.5 text-[10.5px] font-semibold text-accent tabular-nums">
          {active}
        </span>
      )}
    </button>
  );
}
