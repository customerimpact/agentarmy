import { Asterisk, GitBranch, LayoutTemplate, Plus } from 'lucide-react';
import { useBoard } from '../lib/store';
import { openNewAgentDialog } from './NewAgentDialog';

export function EmptyState() {
  return (
    <div
      data-testid="empty-state"
      className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-6"
    >
      <div className="aa-pop aa-card-glow pointer-events-auto relative w-full max-w-lg overflow-hidden rounded-3xl border border-line-strong bg-surface/90 p-9 text-center shadow-[0_40px_120px_-30px_rgb(0_0_0/0.8),0_0_90px_-30px_color-mix(in_srgb,var(--aa-glow)_45%,transparent)] backdrop-blur-md">
        <div className="relative mx-auto grid size-16 place-items-center">
          <span className="absolute inset-0 rounded-2xl bg-accent/25 blur-xl" />
          <span className="relative grid size-14 place-items-center rounded-2xl border border-accent/40 bg-[linear-gradient(140deg,color-mix(in_srgb,var(--aa-accent)_30%,transparent),color-mix(in_srgb,var(--aa-accent)_8%,transparent))] text-accent">
            <Asterisk size={30} strokeWidth={2.5} />
          </span>
        </div>
        <p className="aa-label mt-6 text-accent">Agent board</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">Your board is empty</h1>
        <p className="mx-auto mt-2.5 max-w-sm leading-relaxed text-fg-muted">
          Each agent is a real Claude Code terminal on this canvas. Start a few in different folders
          and see at a glance which ones are working, resting or waiting for you.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            data-testid="empty-state-new-agent"
            onClick={() => useBoard.getState().setNewAgentOpen(true)}
            className="aa-btn-primary inline-flex h-10 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold"
          >
            <Plus size={17} />
            New agent
          </button>
          <button
            type="button"
            data-testid="empty-state-templates"
            onClick={() => useBoard.getState().setTemplatesOpen(true)}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-4 text-[14px] font-medium text-fg
                       hover:border-accent/60 hover:text-accent"
          >
            <LayoutTemplate size={16} />
            Start from a template
          </button>
        </div>
        <button
          type="button"
          data-testid="empty-state-clone"
          onClick={() => openNewAgentDialog('clone')}
          className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted
                     hover:text-accent"
        >
          <GitBranch size={13} />
          or clone a GitHub repo
        </button>
        <p className="mt-4 text-[12px] text-fg-subtle">
          Press
          <kbd className="mx-1 rounded border border-line-strong px-1.5 font-mono text-[11px]">
            N
          </kbd>
          for a new agent anytime
        </p>
      </div>
    </div>
  );
}
