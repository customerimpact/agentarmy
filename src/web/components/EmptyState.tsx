import { Plus } from 'lucide-react';
import { useBoard } from '../lib/store';

export function EmptyState() {
  return (
    <div
      data-testid="empty-state"
      className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-6"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-line bg-surface/95 p-8 text-center shadow-2xl shadow-black/40 backdrop-blur">
        <div className="mx-auto grid w-fit grid-cols-2 gap-1.5">
          <span className="size-5 rounded-md bg-working" />
          <span className="size-5 rounded-md bg-resting" />
          <span className="size-5 rounded-md bg-needs" />
          <span className="size-5 rounded-md bg-line-strong" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-fg">Your board is empty</h1>
        <p className="mt-2 leading-relaxed text-fg-muted">
          Each agent is a real Claude Code terminal on this canvas. Start a few in different folders
          and see at a glance which ones are working, resting or waiting for you. Agents that need
          you glow amber and ping you.
        </p>
        <button
          type="button"
          data-testid="empty-state-new-agent"
          onClick={() => useBoard.getState().setNewAgentOpen(true)}
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-5 text-[14px] font-semibold text-accent-fg
                     hover:brightness-110"
        >
          <Plus size={17} />
          New agent
        </button>
        <p className="mt-3 text-[12px] text-fg-subtle">
          or press
          <kbd className="mx-1 rounded border border-line-strong px-1.5 font-mono text-[11px]">
            N
          </kbd>
        </p>
      </div>
    </div>
  );
}
