import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import type { ConsoleInfo } from '../../shared/protocol';
import type { GitBranchList, GitCommitInfo, GitRemoteResult, GitRepoChange, GitRepoStatus } from '../../shared/repo';
import { openReview } from '../lib/review';
import {
  closeGitPanel,
  invalidateRepoInfo,
  openCodeViewer,
  openGitPanel,
  relativeTime,
  repoApi,
  splitPatch,
  useCodeViewer,
  useGitPanel,
  useRepoInfo,
  type PullMode,
} from '../lib/repo';
import { basename } from '../lib/status';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';
import { DiffView } from './ReviewPanel';

// Per-repository Git panel for any console whose folder is in a git repo: branch switcher, stage /
// unstage, commit, push / pull / fetch and the last 20 commits. Worktree consoles keep their Review
// panel (merge / discard) and link to it from here.

const STATUS_CLS: Record<string, string> = {
  A: 'text-project-green bg-project-green/12',
  '?': 'text-project-green bg-project-green/12',
  M: 'text-project-amber bg-project-amber/12',
  D: 'text-error bg-error/12',
  R: 'text-project-blue bg-project-blue/12',
  C: 'text-project-blue bg-project-blue/12',
  T: 'text-fg-muted bg-hover',
  U: 'text-error bg-error/12',
};

type Busy = null | 'checkout' | 'branch' | 'stage' | 'commit' | 'push' | 'pull' | 'fetch';

interface RemoteNote {
  kind: 'push' | 'pull' | 'fetch';
  result: GitRemoteResult;
}

function SmallButton({
  label,
  onClick,
  children,
  testId,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle disabled:opacity-40
                 hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function ChangeRow({
  id,
  file,
  scope,
  action,
  onAction,
  busy,
}: {
  id: string;
  file: GitRepoChange;
  scope: 'staged' | 'unstaged';
  action: 'stage' | 'unstage' | null;
  onAction: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = file.status === '?' ? 'U' : file.status === 'U' ? '!' : file.status;
  return (
    <div data-testid="git-file" data-file={file.path} data-scope={scope} className="border-b border-line last:border-b-0">
      <div className="group flex items-center gap-1.5 pr-1.5 hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
        >
          <ChevronRight size={13} className={`shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className={`grid size-[18px] shrink-0 place-items-center rounded font-mono text-[10.5px] font-bold ${STATUS_CLS[file.status] ?? STATUS_CLS.M}`}>
            {label}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={file.path}>
            {file.path}
          </span>
        </button>
        {file.status !== 'D' && (
          <SmallButton label={`Open ${file.path}`} testId="git-file-open" onClick={() => openCodeViewer(id, file.path)}>
            <FileCode size={13} />
          </SmallButton>
        )}
        {action && (
          <SmallButton
            label={action === 'stage' ? `Stage ${file.path}` : `Unstage ${file.path}`}
            testId={action === 'stage' ? 'git-stage' : 'git-unstage'}
            disabled={busy}
            onClick={onAction}
          >
            {action === 'stage' ? <Plus size={14} /> : <Minus size={14} />}
          </SmallButton>
        )}
      </div>
      {open && (
        <DiffView id={id} file={file.path} scope={`repo-${scope}`} load={() => repoApi.diff(id, file.path, scope)} />
      )}
    </div>
  );
}

function ChangeSection({
  title,
  testId,
  files,
  children,
  actions,
  empty,
}: {
  title: string;
  testId: string;
  files: GitRepoChange[];
  children: ReactNode;
  actions?: ReactNode;
  empty: string;
}) {
  return (
    <section data-testid={testId} className="mb-3">
      <h3 className="aa-label mb-1.5 flex items-center gap-2 px-1 text-fg-subtle">
        {title}
        <span className="rounded-full bg-hover px-1.5 font-normal tabular-nums normal-case">{files.length}</span>
        <span className="ml-auto flex items-center gap-1 normal-case">{actions}</span>
      </h3>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {files.length === 0 ? <p className="px-3 py-2.5 text-[12px] text-fg-subtle">{empty}</p> : children}
      </div>
    </section>
  );
}

function BranchMenu({
  id,
  status,
  disabled,
  onCheckout,
  onCreate,
}: {
  id: string;
  status: GitRepoStatus;
  disabled: boolean;
  onCheckout: (branch: string) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<GitBranchList | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setList(null);
    setError(null);
    repoApi.branches(id).then(setList, (e: Error) => setError(e.message));
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open, id]);

  const q = query.trim().toLowerCase();
  const local = (list?.local ?? []).filter((b) => b.name.toLowerCase().includes(q));
  const localNames = new Set(list?.local.map((b) => b.name));
  const remote = (list?.remote ?? []).filter(
    (r) => r.toLowerCase().includes(q) && !localNames.has(r.slice(r.indexOf('/') + 1)),
  );
  const canCreate = !!q && !list?.local.some((b) => b.name === query.trim());
  const dirty = status.staged.length + status.unstaged.length + status.conflicted.length > 0;
  const pick = (b: string) => {
    setOpen(false);
    setQuery('');
    onCheckout(b);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="git-branch"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-line bg-surface px-2 font-mono text-[12px] text-fg disabled:opacity-60
                   hover:border-accent/60"
      >
        <GitBranch size={13} className="shrink-0 text-accent" />
        <span className="truncate">{status.branch ?? `detached at ${status.head ?? '?'}`}</span>
        <ChevronDown size={12} className="shrink-0 text-fg-subtle" />
      </button>
      {open && (
        <div
          data-testid="git-branch-menu"
          className="absolute top-8 left-0 z-10 w-80 rounded-xl border border-line-strong bg-elevated p-1.5 text-[12px] shadow-2xl shadow-black/40"
        >
          <label className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2">
            <Search size={12} className="shrink-0 text-fg-subtle" />
            <input
              autoFocus
              data-testid="git-branch-filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate && local.length === 0) {
                  setOpen(false);
                  onCreate(query.trim());
                  setQuery('');
                }
              }}
              placeholder="Find or create a branch"
              className="h-7 min-w-0 flex-1 bg-transparent font-mono text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle"
            />
          </label>
          {dirty && (
            <p className="mt-1.5 px-2 text-[11.5px] text-needs">
              Uncommitted changes: switching is blocked until you commit or stash. New branches keep the changes.
            </p>
          )}
          {error && <p className="px-2 py-1.5 text-error">{error}</p>}
          {!list && !error && (
            <p className="flex items-center gap-1.5 px-2 py-2 text-fg-subtle">
              <LoaderCircle size={12} className="animate-spin" /> Loading branches…
            </p>
          )}
          <ul className="aa-scroll mt-1 max-h-72 overflow-y-auto">
            {canCreate && (
              <li>
                <button
                  type="button"
                  data-testid="git-branch-create"
                  onClick={() => {
                    setOpen(false);
                    onCreate(query.trim());
                    setQuery('');
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-accent hover:bg-hover"
                >
                  <Plus size={13} /> Create branch <span className="truncate font-mono">{query.trim()}</span>
                </button>
              </li>
            )}
            {local.length > 0 && <li className="aa-label px-2 pt-1.5 pb-0.5 text-fg-subtle">Local</li>}
            {local.map((b) => (
              <li key={b.name}>
                <button
                  type="button"
                  data-testid="git-branch-item"
                  data-branch={b.name}
                  disabled={b.name === list?.current}
                  onClick={() => pick(b.name)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:hover:bg-transparent"
                >
                  <span className="w-3.5 shrink-0 text-accent">{b.name === list?.current && <Check size={13} />}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg">{b.name}</span>
                  {b.upstream && <span className="truncate font-mono text-[10.5px] text-fg-subtle">{b.upstream}</span>}
                </button>
              </li>
            ))}
            {remote.length > 0 && <li className="aa-label px-2 pt-1.5 pb-0.5 text-fg-subtle">Remote</li>}
            {remote.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  data-testid="git-branch-item"
                  data-branch={r}
                  onClick={() => pick(r)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                >
                  <span className="w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{r}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CommitRow({ id, commit, now }: { id: string; commit: GitCommitInfo; now: number }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<{ file: string; diff: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!open || files) return;
    repoApi.show(id, commit.hash).then(
      (r) => {
        setFiles(splitPatch(r.diff));
        setTruncated(r.truncated);
      },
      (e: Error) => setError(e.message),
    );
  }, [open, files, id, commit.hash]);

  return (
    <li data-testid="git-log-entry" data-hash={commit.hash} className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-hover"
      >
        <ChevronRight size={13} className={`mt-0.5 shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-fg" title={commit.subject}>
            {commit.subject}
          </span>
          <span className="block truncate text-[11px] text-fg-subtle">
            <span className="font-mono text-accent/90">{commit.short}</span> · {commit.author} · {relativeTime(commit.date, now)}
          </span>
        </span>
      </button>
      {open && (
        <div data-testid="git-commit-diff" className="pb-1">
          {error && <p className="px-4 py-2 text-[12px] text-error">{error}</p>}
          {!files && !error && (
            <p className="flex items-center gap-2 px-4 py-2 text-[12px] text-fg-subtle">
              <LoaderCircle size={13} className="animate-spin" /> Loading commit…
            </p>
          )}
          {files?.length === 0 && <p className="px-4 py-2 text-[12px] text-fg-subtle">No file changes (merge or empty commit).</p>}
          {files?.map((f) => (
            <div key={f.file} className="mx-2 mb-1.5 overflow-hidden rounded-md border border-line">
              <p className="truncate bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-fg-muted" title={f.file}>
                {f.file}
              </p>
              <DiffView id={id} file={f.file} scope={`commit-${commit.hash}`} load={() => Promise.resolve({ diff: f.diff, truncated: false })} />
            </div>
          ))}
          {truncated && <p className="px-4 pb-1 text-[11.5px] text-fg-subtle">Patch cut at 4 MB.</p>}
        </div>
      )}
    </li>
  );
}

function GitPanel({ console: c }: { console: ConsoleInfo }) {
  const id = c.id;
  const [status, setStatus] = useState<GitRepoStatus | null>(null);
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<RemoteNote | null>(null);
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0); // remounts file rows (fresh diffs) after an action
  const now = Date.now();

  const apply = useCallback((s: GitRepoStatus) => {
    setStatus(s);
    setVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, log] = await Promise.all([repoApi.status(id), repoApi.log(id)]);
      apply(s);
      setCommits(log);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (kind: Busy, fn: () => Promise<GitRepoStatus>, done?: string, reloadLog = false) => {
    setBusy(kind);
    setError(null);
    try {
      apply(await fn());
      if (reloadLog) setCommits(await repoApi.log(id));
      if (done) useBoard.getState().toast(done);
      if (kind === 'checkout' || kind === 'branch') invalidateRepoInfo(c.cwd);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remote = async (kind: 'push' | 'pull' | 'fetch', mode?: PullMode) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const result = kind === 'push' ? await repoApi.push(id) : kind === 'pull' ? await repoApi.pull(id, mode) : await repoApi.fetch(id);
      setNote({ kind, result });
      if (result.status) apply(result.status);
      if (result.ok && kind === 'pull') setCommits(await repoApi.log(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const changes = useMemo(
    () => [...(status?.unstaged ?? []), ...(status?.untracked ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1)),
    [status],
  );
  const stagedCount = status?.staged.length ?? 0;

  const commit = () => {
    if (!message.trim() || !stagedCount || busy) return;
    void run('commit', () => repoApi.commit(id, message.trim()), 'Committed', true).then(() => setMessage(''));
  };

  const repoName = status ? basename(status.repoRoot) : basename(c.cwd);

  return (
    <Modal
      title={`Git ${repoName}`}
      // Escape with the code viewer on top closes only the viewer
      onClose={() => !useCodeViewer.getState().target && closeGitPanel()}
      width="max-w-6xl"
      testId="git-panel"
    >
      <div className="aa-card-glow flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 pt-4 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <GitBranch size={16} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg">
            <span data-testid="git-repo-name">{repoName}</span>
            <span className="ml-2 text-[12px] font-normal text-fg-subtle">{c.name}</span>
          </h2>
          <p className="truncate font-mono text-[11px] text-fg-subtle" title={status?.repoRoot}>
            {status?.repoRoot ?? c.cwd}
          </p>
        </div>
        {status && (
          <BranchMenu
            id={id}
            status={status}
            disabled={!!busy}
            onCheckout={(b) => void run('checkout', () => repoApi.checkout(id, b), `Switched to ${b}`, true)}
            onCreate={(name) => void run('branch', () => repoApi.createBranch(id, name), `Created ${name}`, true)}
          />
        )}
        {status && (
          <span className="flex items-center gap-2 text-[12px] text-fg-muted">
            {status.upstream ? (
              <>
                <span data-testid="git-ahead" title={`Commits not on ${status.upstream} yet`} className="inline-flex items-center gap-0.5 tabular-nums">
                  <ArrowUp size={12} className="text-project-green" />
                  {status.ahead}
                </span>
                <span data-testid="git-behind" title={`Commits on ${status.upstream} you do not have`} className="inline-flex items-center gap-0.5 tabular-nums">
                  <ArrowDown size={12} className="text-project-amber" />
                  {status.behind}
                </span>
                <span className="font-mono text-[11px] text-fg-subtle">{status.upstream}</span>
              </>
            ) : (
              <span data-testid="git-no-upstream" className="text-[11.5px] text-fg-subtle">
                {status.remotes.length ? 'not pushed yet' : 'no remote'}
              </span>
            )}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {c.git && (
            <button
              type="button"
              data-testid="git-open-review"
              onClick={() => {
                closeGitPanel();
                openReview(id);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] text-fg-muted hover:border-accent/60 hover:text-fg"
            >
              <GitPullRequestArrow size={13} /> Review &amp; merge
            </button>
          )}
          <RemoteButton testId="git-fetch" label="Fetch" busy={busy === 'fetch'} disabled={!!busy || !status?.remotes.length} onClick={() => void remote('fetch')}>
            <RefreshCw size={13} />
          </RemoteButton>
          <RemoteButton testId="git-pull" label="Pull" busy={busy === 'pull'} disabled={!!busy || !status?.upstream} onClick={() => void remote('pull')}>
            <CloudDownload size={13} />
          </RemoteButton>
          <RemoteButton testId="git-push" label="Push" busy={busy === 'push'} disabled={!!busy || !status?.remotes.length || !status.branch} onClick={() => void remote('push')}>
            <Upload size={13} />
          </RemoteButton>
          <button
            type="button"
            title="Refresh"
            aria-label="Refresh"
            data-testid="git-refresh"
            onClick={() => void refresh()}
            className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            aria-label="Close Git panel"
            onClick={closeGitPanel}
            className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X size={15} />
          </button>
        </span>
      </div>

      {note && <RemoteNoteBar note={note} busy={!!busy} onPull={(mode) => void remote('pull', mode)} onClose={() => setNote(null)} />}
      {error && (
        <div data-testid="git-error" className="flex items-start gap-2 border-b border-error/30 bg-error/10 px-5 py-2 text-[12px] text-error">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <p className="flex-1 font-medium whitespace-pre-wrap">{error}</p>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <X size={13} />
          </button>
        </div>
      )}
      {status?.operation && (
        <p className="flex items-center gap-2 border-b border-needs/30 bg-needs/10 px-5 py-2 text-[12px] text-needs">
          <TriangleAlert size={14} /> A {status.operation} is in progress in this repository. Finish or abort it in a terminal.
        </p>
      )}

      <div className="grid min-h-60 grid-cols-1 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="aa-scroll max-h-[60vh] overflow-y-auto border-line px-5 pt-3 pb-1 md:border-r">
          {!status && loading && (
            <p className="flex items-center justify-center gap-2 py-12 text-fg-subtle">
              <LoaderCircle size={15} className="animate-spin" /> Reading the repository…
            </p>
          )}
          {status && (
            <div key={version}>
              {status.conflicted.length > 0 && (
                <ChangeSection title="Conflicts" testId="git-conflicted" files={status.conflicted} empty="">
                  {status.conflicted.map((f) => (
                    <ChangeRow key={f.path} id={id} file={f} scope="unstaged" action="stage" busy={!!busy} onAction={() => void run('stage', () => repoApi.stage(id, [f.path]))} />
                  ))}
                </ChangeSection>
              )}
              <ChangeSection
                title="Staged"
                testId="git-staged"
                files={status.staged}
                empty="Nothing staged. Use + on a file, or Stage all."
                actions={
                  stagedCount > 0 && (
                    <button type="button" data-testid="git-unstage-all" disabled={!!busy} onClick={() => void run('stage', () => repoApi.unstage(id))} className="rounded px-1.5 text-[11px] font-medium text-fg-muted hover:bg-hover hover:text-fg">
                      Unstage all
                    </button>
                  )
                }
              >
                {status.staged.map((f) => (
                  <ChangeRow key={f.path} id={id} file={f} scope="staged" action="unstage" busy={!!busy} onAction={() => void run('stage', () => repoApi.unstage(id, [f.path]))} />
                ))}
              </ChangeSection>
              <ChangeSection
                title="Changes"
                testId="git-changes"
                files={changes}
                empty="The working tree is clean."
                actions={
                  changes.length > 0 && (
                    <button type="button" data-testid="git-stage-all" disabled={!!busy} onClick={() => void run('stage', () => repoApi.stage(id))} className="rounded px-1.5 text-[11px] font-medium text-fg-muted hover:bg-hover hover:text-fg">
                      Stage all
                    </button>
                  )
                }
              >
                {changes.map((f) => (
                  <ChangeRow key={f.path} id={id} file={f} scope="unstaged" action="stage" busy={!!busy} onAction={() => void run('stage', () => repoApi.stage(id, [f.path]))} />
                ))}
              </ChangeSection>
            </div>
          )}
        </div>
        <div className="aa-scroll max-h-[60vh] overflow-y-auto px-4 pt-3 pb-2">
          <h3 className="aa-label mb-1.5 px-1 text-fg-subtle">Recent commits</h3>
          <ul data-testid="git-log" className="overflow-hidden rounded-lg border border-line bg-surface">
            {commits === null && <li className="px-3 py-2.5 text-[12px] text-fg-subtle">Loading…</li>}
            {commits?.length === 0 && <li className="px-3 py-2.5 text-[12px] text-fg-subtle">No commits yet.</li>}
            {commits?.map((cm) => <CommitRow key={cm.hash} id={id} commit={cm} now={now} />)}
          </ul>
        </div>
      </div>

      <form
        className="flex items-start gap-2 border-t border-line px-5 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
      >
        <GitCommitHorizontal size={15} className="mt-2 shrink-0 text-fg-subtle" />
        <textarea
          data-testid="git-commit-message"
          value={message}
          rows={message.includes('\n') ? 3 : 1}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={stagedCount ? `Commit message for ${stagedCount} staged file${stagedCount === 1 ? '' : 's'} (Ctrl+Enter)` : 'Stage files to commit'}
          className="min-h-8 min-w-0 flex-1 resize-y rounded-md border border-line bg-surface px-2 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-fg-subtle
                     focus:border-accent"
        />
        <button
          type="submit"
          data-testid="git-commit"
          disabled={!message.trim() || !stagedCount || !!busy}
          className="aa-btn-primary inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold disabled:opacity-50"
        >
          {busy === 'commit' ? <LoaderCircle size={13} className="animate-spin" /> : <GitCommitHorizontal size={13} />}
          Commit
        </button>
      </form>
      <p className="border-t border-line bg-surface-2 px-5 py-2 text-[11px] text-fg-subtle">
        Push and pull never ask for passwords here. HTTPS remotes need a credential manager (Git Credential Manager may
        open its own sign-in window) or use an SSH key.
      </p>
    </Modal>
  );
}

function RemoteButton({
  label,
  onClick,
  children,
  busy,
  disabled,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  busy: boolean;
  disabled: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] font-medium text-fg disabled:opacity-45
                 hover:border-accent/60 hover:bg-hover"
    >
      {busy ? <LoaderCircle size={13} className="animate-spin" /> : children}
      {label}
    </button>
  );
}

function RemoteNoteBar({
  note,
  busy,
  onPull,
  onClose,
}: {
  note: RemoteNote;
  busy: boolean;
  onPull: (mode: PullMode) => void;
  onClose: () => void;
}) {
  const { result } = note;
  const verb = note.kind === 'push' ? 'Pushed' : note.kind === 'pull' ? 'Pulled' : 'Fetched';
  const diverged = !result.ok && note.kind === 'pull' && result.reason === 'non-ff';
  return (
    <div
      data-testid="git-remote-note"
      data-ok={result.ok}
      data-reason={result.reason}
      className={`border-b px-5 py-2 text-[12px] ${result.ok ? 'border-line bg-project-green/8 text-fg' : 'border-error/30 bg-error/10 text-error'}`}
    >
      <div className="flex items-start gap-2">
        {result.ok ? <Check size={14} className="mt-0.5 shrink-0 text-project-green" /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" />}
        <p className="flex-1 font-medium whitespace-pre-wrap">{result.ok ? verb : result.error}</p>
        <button type="button" aria-label="Dismiss" onClick={onClose} className="shrink-0 opacity-70 hover:opacity-100">
          <X size={13} />
        </button>
      </div>
      {diverged && (
        <div className="mt-1.5 flex gap-2 pl-6">
          <button type="button" data-testid="git-pull-rebase" disabled={busy} onClick={() => onPull('rebase')} className="aa-btn-primary inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-semibold disabled:opacity-50">
            Pull with rebase
          </button>
          <button type="button" data-testid="git-pull-merge" disabled={busy} onClick={() => onPull('merge')} className="inline-flex h-7 items-center rounded-md border border-line px-2.5 text-[12px] font-semibold text-fg disabled:opacity-50 hover:bg-hover">
            Pull with merge
          </button>
        </div>
      )}
      {result.output && (
        <pre data-testid="git-remote-output" className="aa-scroll mt-1.5 max-h-32 overflow-auto rounded-md bg-term/60 px-2 py-1.5 pl-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
          {result.output}
        </pre>
      )}
    </div>
  );
}

// Mounted once in App; renders the panel for the console picked with openGitPanel(id)
export function GitPanelHost() {
  const id = useGitPanel((s) => s.id);
  const c = useBoard((s) => (id ? s.consoles[id] : undefined));
  useEffect(() => {
    if (id && !c) closeGitPanel();
  }, [id, c]);
  if (!id || !c) return null;
  return <GitPanel key={id} console={c} />;
}

// Console header chip: current branch, opens the Git panel. Shown when the folder is in a repo.
export function GitChip({ console: c }: { console: ConsoleInfo }) {
  const info = useRepoInfo(c.cwd);
  if (!info?.repoRoot) return null;
  return (
    <button
      type="button"
      data-testid="console-git"
      title={`Git: ${info.branch ?? 'detached HEAD'} in ${info.repoRoot}`}
      aria-label="Open Git panel"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => openGitPanel(c.id)}
      className="nodrag inline-flex h-5 max-w-[30%] min-w-0 shrink items-center gap-1 rounded-full border border-line px-1.5 text-[10.5px] text-fg-muted
                 hover:border-accent/60 hover:text-fg"
    >
      <GitBranch size={11} className="shrink-0 text-accent" />
      <span className="truncate font-mono">{c.git ? 'Git' : (info.branch ?? 'detached')}</span>
    </button>
  );
}

// Agents tab: small "Git" link under a console that works in a repository
export function GitLink({ console: c }: { console: ConsoleInfo }) {
  const info = useRepoInfo(c.cwd);
  if (!info?.repoRoot) return null;
  const open = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    openGitPanel(c.id);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid="mission-git"
      title={`Git panel for ${info.repoRoot}`}
      onClick={open}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open(e)}
      className="mt-0.5 mr-1 inline-flex max-w-full items-center gap-1 rounded-md border border-line px-1.5 text-[10.5px] leading-4 text-fg-muted
                 hover:border-accent/60 hover:text-fg"
    >
      <GitBranch size={10} className="shrink-0 text-accent" />
      {!c.git && <span className="truncate font-mono">{info.branch ?? 'detached'}</span>}
      <span className="shrink-0">Git</span>
    </span>
  );
}
