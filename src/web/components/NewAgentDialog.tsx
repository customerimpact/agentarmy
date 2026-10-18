import { useEffect, useState } from 'react';
import { FolderOpen, GitBranch, LoaderCircle } from 'lucide-react';
import { api } from '../lib/api';
import { createAgent, createAgentGrid } from '../lib/board-actions';
import { getRecentFolders } from '../lib/recent-folders';
import { useBoard } from '../lib/store';
import { FolderPicker, joinPath, repoNameFromUrl } from './FolderPicker';
import { Modal } from './Modal';

type Mode = 'folder' | 'clone';

const CLONE_PARENT_KEY = 'agentarmy.cloneParent';

// Lets other entry points (empty state, command bar) open the dialog straight on the clone tab
let nextMode: Mode = 'folder';
export function openNewAgentDialog(mode: Mode = 'folder', count = 1): void {
  nextMode = mode;
  useBoard.getState().setNewAgentOpen(true, count);
}

function loadCloneParent(): string | undefined {
  try {
    return localStorage.getItem(CLONE_PARENT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveCloneParent(path: string): void {
  try {
    localStorage.setItem(CLONE_PARENT_KEY, path);
  } catch {
    // convenience only
  }
}

// 'owner/repo' is GitHub shorthand; anything else must look like a git URL
function validRepo(text: string): boolean {
  const t = text.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(t) || /^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(t);
}

export function NewAgentDialog() {
  const close = () => useBoard.getState().setNewAgentOpen(false);
  const count = useBoard((s) => s.newAgentCount);
  const [mode, setMode] = useState<Mode>(() => nextMode);
  useEffect(() => {
    nextMode = 'folder';
  }, []);
  const [target, setTarget] = useState<string | null>(null);
  const [cloneParent, setCloneParent] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startFolder] = useState(() => getRecentFolders()[0]);
  const [startParent] = useState(loadCloneParent);

  const title = count > 1 ? `Spawn ${count} agents` : 'New agent';
  const repoName = repoNameFromUrl(repo);
  const clonePath = cloneParent && repoName ? joinPath(cloneParent, repoName) : null;

  const launchIn = async (cwd: string) => {
    if (count > 1) await createAgentGrid(cwd);
    else await createAgent(cwd, name);
  };

  const create = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await launchIn(target);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cloneAndOpen = async () => {
    if (!cloneParent || !validRepo(repo) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await api.cloneRepo({ url: repo.trim(), parent: cloneParent });
      saveCloneParent(cloneParent);
      await launchIn(path);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    if (busy) return;
    setMode(next);
    setError(null);
  };

  const tabClass = (active: boolean) =>
    `inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors
     ${active ? 'bg-accent/15 text-fg ring-1 ring-accent/40' : 'text-fg-muted hover:bg-hover hover:text-fg'}`;

  const nameInput = count === 1 && (
    <input
      data-testid="folder-picker-name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void (mode === 'clone' ? cloneAndOpen() : create());
      }}
      placeholder="Name (optional, a friendly name is picked for you)"
      className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-fg outline-none placeholder:text-fg-subtle
                 focus:border-accent"
    />
  );

  return (
    <Modal title={title} onClose={close} width="max-w-2xl" testId="folder-picker">
      <div className="aa-card-glow flex items-start gap-4 border-b border-line px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <p className="mt-0.5 text-fg-muted">
            {mode === 'clone'
              ? 'Clone a git repository and open Claude Code in it.'
              : count > 1
                ? `Pick a folder. ${count} consoles start there in a grid.`
                : 'Pick the folder Claude Code should work in.'}
          </p>
        </div>
        <div role="tablist" aria-label="Source" className="flex shrink-0 gap-1 rounded-full border border-line bg-surface p-0.5">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'folder'}
            data-testid="new-agent-tab-folder"
            onClick={() => switchMode('folder')}
            className={tabClass(mode === 'folder')}
          >
            <FolderOpen size={13} />
            Folder
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'clone'}
            data-testid="new-agent-tab-clone"
            onClick={() => switchMode('clone')}
            className={tabClass(mode === 'clone')}
          >
            <GitBranch size={13} />
            Clone repo
          </button>
        </div>
      </div>

      {mode === 'folder' ? (
        <FolderPicker
          startPath={startFolder}
          onTargetChange={setTarget}
          onGitUrl={(url) => {
            setRepo(url);
            setMode('clone');
            setError(null);
          }}
        />
      ) : (
        <>
          <div className="border-b border-line px-5 py-3">
            <label className="aa-label text-fg-subtle" htmlFor="clone-url">
              Repository
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent">
              <GitBranch size={14} className="shrink-0 text-accent" />
              <input
                id="clone-url"
                data-testid="clone-url"
                data-autofocus
                autoFocus
                value={repo}
                disabled={busy}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void cloneAndOpen();
                }}
                placeholder="https://github.com/owner/repo  or  owner/repo"
                spellCheck={false}
                className="h-9 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
              />
            </div>
            <p className="mt-2 text-[12px] text-fg-subtle">
              Uses your own git and credentials. Pick the folder to clone into below.
            </p>
          </div>
          <div className="aa-label px-5 pt-2.5 pb-1.5 text-fg-subtle">Clone into</div>
          <FolderPicker
            startPath={startParent}
            onTargetChange={setCloneParent}
            heightClass="h-56"
            autoFocus={false}
          />
          {busy && (
            <div
              data-testid="clone-progress"
              className="flex items-center gap-2 border-t border-accent/30 bg-accent/10 px-5 py-2 text-[12px] text-fg"
            >
              <LoaderCircle size={14} className="animate-spin text-accent" />
              Cloning… this can take a minute
            </div>
          )}
        </>
      )}

      {error && (
        <pre
          data-testid="new-agent-error"
          className="aa-scroll max-h-40 overflow-auto border-t border-error/30 bg-error/10 px-5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-error"
        >
          {error}
        </pre>
      )}

      <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-mono text-[11px] text-fg-subtle"
            title={(mode === 'clone' ? clonePath : target) ?? ''}
          >
            {mode === 'clone' ? (clonePath ?? cloneParent ?? ' ') : (target ?? ' ')}
          </div>
          {nameInput}
        </div>
        <button
          type="button"
          onClick={close}
          className="rounded-lg px-3 py-1.5 font-medium text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
        {mode === 'clone' ? (
          <button
            type="button"
            data-testid="clone-submit"
            disabled={!cloneParent || !validRepo(repo) || busy}
            onClick={() => void cloneAndOpen()}
            className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : <GitBranch size={13} />}
            {count > 1 ? `Clone & spawn ${count}` : 'Clone & open'}
          </button>
        ) : (
          <button
            type="button"
            data-testid="folder-picker-use"
            disabled={!target || busy}
            onClick={() => void create()}
            className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
          >
            {busy && <LoaderCircle size={13} className="animate-spin" />}
            {count > 1 ? `Spawn ${count} here` : 'Use this folder'}
          </button>
        )}
      </div>
    </Modal>
  );
}
