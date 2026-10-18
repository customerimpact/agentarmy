import { useEffect, useRef, useState } from 'react';
import { Group, Scaling, X } from 'lucide-react';
import { clearSelection, groupSelection, makeSameSize, nextProjectName } from '../lib/board-actions';
import { useBoardUi } from '../lib/board-ui';
import { useBoard } from '../lib/store';
import { ArrangeMenu } from './ArrangeMenu';
import { KillButton } from './KillButton';

function GroupPrompt() {
  const [name, setName] = useState(nextProjectName);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => useBoardUi.getState().setGroupPromptOpen(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await groupSelection(name);
    setBusy(false);
    if (ok) close();
  };

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={inputRef}
        data-testid="group-name-input"
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
        className="h-7 w-44 rounded-md border border-line-strong bg-surface px-2 text-fg outline-none
                   focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy}
        data-testid="group-name-submit"
        className="h-7 rounded-md bg-accent px-2.5 font-semibold text-accent-fg
                   hover:brightness-110 disabled:opacity-60"
      >
        Group
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={close}
        className="grid size-7 place-items-center rounded-md text-fg-subtle
                   hover:bg-hover hover:text-fg"
      >
        <X size={14} />
      </button>
    </form>
  );
}

// Floating bar when several nodes are selected: group, arrange, same size, clear
export function SelectionBar() {
  const count = useBoard((s) => s.selectedIds.length);
  const consoleCount = useBoard((s) => s.selectedIds.filter((id) => s.consoles[id]).length);
  const promptOpen = useBoardUi((s) => s.groupPromptOpen);
  if (count < 2 && !promptOpen) return null;

  const button = `inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-fg-muted
                  hover:bg-hover hover:text-fg`;

  return (
    <div
      data-testid="selection-bar"
      className="flex items-center gap-1 rounded-xl border border-line-strong bg-elevated/95 px-2 py-1.5 text-[12px] text-fg shadow-2xl shadow-black/40 backdrop-blur"
    >
      <span className="px-1.5 font-semibold tabular-nums">
        {count} selected
      </span>
      <span className="mx-0.5 h-4 w-px bg-line" />
      {promptOpen ? (
        <GroupPrompt />
      ) : (
        <>
          <button
            type="button"
            data-testid="group-as-project"
            disabled={!consoleCount}
            onClick={() => useBoardUi.getState().setGroupPromptOpen(true)}
            className={`${button} disabled:opacity-40`}
            title="Group as project (G)"
          >
            <Group size={13} />
            Group as project…
          </button>
          <ArrangeMenu align="center" compact />
          <button type="button" className={button} onClick={() => makeSameSize()} title="Give them all the same size">
            <Scaling size={13} />
            Same size
          </button>
          <KillButton compact />
          <button
            type="button"
            data-testid="selection-clear"
            className={button}
            onClick={clearSelection}
            title="Clear selection (Esc)"
          >
            <X size={13} />
            Clear
          </button>
        </>
      )}
    </div>
  );
}
