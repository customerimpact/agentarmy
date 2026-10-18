import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  LoaderCircle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ConsoleInfo, GitFileChange, GitSummary } from '../../shared/protocol';
import {
  GitApiError,
  closeReview,
  defaultCommitMessage,
  gitApi,
  openReview,
  parseUnifiedDiff,
  useReview,
  type DiffLine,
} from '../lib/review';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';

const PAGE_LINES = 5000;

type Scope = 'committed' | 'uncommitted';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  A: { label: 'A', cls: 'text-project-green bg-project-green/12' },
  '?': { label: 'U', cls: 'text-project-green bg-project-green/12' },
  M: { label: 'M', cls: 'text-project-amber bg-project-amber/12' },
  D: { label: 'D', cls: 'text-error bg-error/12' },
  R: { label: 'R', cls: 'text-project-blue bg-project-blue/12' },
  C: { label: 'C', cls: 'text-project-blue bg-project-blue/12' },
  T: { label: 'T', cls: 'text-fg-muted bg-hover' },
  U: { label: '!', cls: 'text-error bg-error/12' },
};

function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) {
    return <span className="font-mono text-[11px] text-fg-subtle">binary</span>;
  }
  return (
    <span className="font-mono text-[11.5px] tabular-nums">
      <span className="text-project-green">+{added ?? 0}</span>{' '}
      <span className="text-error">−{removed ?? 0}</span>
    </span>
  );
}

const ROW_CLS: Record<DiffLine['kind'], string> = {
  add: 'bg-project-green/10',
  del: 'bg-error/10',
  ctx: '',
  hunk: 'bg-accent/8 text-fg-subtle',
  meta: 'text-fg-subtle italic',
};

function DiffView({ id, file, scope }: { id: string; file: string; scope: Scope }) {
  const [rows, setRows] = useState<DiffLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_LINES);

  useEffect(() => {
    let cancelled = false;
    gitApi
      .diff(id, file, scope)
      .then((res) => {
        if (cancelled) return;
        setRows(parseUnifiedDiff(res.diff));
        setTruncated(res.truncated);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, file, scope]);

  if (error) return <p className="px-4 py-2 text-[12px] text-error">{error}</p>;
  if (!rows) {
    return (
      <p className="flex items-center gap-2 px-4 py-2 text-[12px] text-fg-subtle">
        <LoaderCircle size={13} className="animate-spin" /> Loading diff…
      </p>
    );
  }
  if (rows.length === 0) return <p className="px-4 py-2 text-[12px] text-fg-subtle">No textual changes.</p>;
  const shown = rows.slice(0, limit);
  return (
    <div data-testid="review-diff" className="border-t border-line bg-term/40">
      <div className="aa-scroll overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[11.5px] leading-[18px]">
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className={ROW_CLS[r.kind]} data-kind={r.kind}>
                <td className="w-10 border-r border-line/60 px-1.5 text-right text-fg-subtle/70 select-none">
                  {r.oldNo ?? ''}
                </td>
                <td className="w-10 border-r border-line/60 px-1.5 text-right text-fg-subtle/70 select-none">
                  {r.newNo ?? ''}
                </td>
                <td className="w-4 pl-1.5 select-none">
                  {r.kind === 'add' ? (
                    <span className="text-project-green">+</span>
                  ) : r.kind === 'del' ? (
                    <span className="text-error">−</span>
                  ) : (
                    ''
                  )}
                </td>
                <td className="pr-4 whitespace-pre text-fg">{r.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button
          type="button"
          data-testid="review-diff-more"
          onClick={() => setLimit((n) => n + PAGE_LINES)}
          className="w-full border-t border-line py-1.5 text-[12px] font-medium text-accent hover:bg-hover"
        >
          Load {Math.min(PAGE_LINES, rows.length - limit)} more lines ({rows.length - limit} hidden)
        </button>
      )}
      {truncated && rows.length <= limit && (
        <p className="border-t border-line px-4 py-1.5 text-[11.5px] text-fg-subtle">
          Diff cut at 4 MB. Open the folder to see the rest.
        </p>
      )}
    </div>
  );
}

function FileRow({ id, file, scope }: { id: string; file: GitFileChange; scope: Scope }) {
  const [open, setOpen] = useState(false);
  const status = STATUS_LABEL[file.status] ?? STATUS_LABEL.M;
  return (
    <div data-testid="review-file" data-file={file.path} data-scope={scope} className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
      >
        <ChevronRight size={13} className={`shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`grid size-[18px] shrink-0 place-items-center rounded font-mono text-[10.5px] font-bold ${status.cls}`}>
          {status.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={file.path}>
          {file.path}
        </span>
        <Counts added={file.added} removed={file.removed} />
      </button>
      {open && <DiffView id={id} file={file.path} scope={scope} />}
    </div>
  );
}

function Section({
  title,
  testId,
  files,
  id,
  scope,
  empty,
}: {
  title: string;
  testId: string;
  files: GitFileChange[];
  id: string;
  scope: Scope;
  empty: string;
}) {
  return (
    <section data-testid={testId} className="mb-3">
      <h3 className="aa-label mb-1.5 flex items-center gap-2 px-1 text-fg-subtle">
        {title}
        <span className="rounded-full bg-hover px-1.5 font-normal tabular-nums normal-case">{files.length}</span>
      </h3>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {files.length === 0 ? (
          <p className="px-3 py-2.5 text-[12px] text-fg-subtle">{empty}</p>
        ) : (
          files.map((f) => <FileRow key={`${scope}:${f.path}`} id={id} file={f} scope={scope} />)
        )}
      </div>
    </section>
  );
}

function ReviewPanel({ console: c }: { console: ConsoleInfo }) {
  const git = c.git!;
  const id = c.id;
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'commit' | 'merge' | 'discard'>(null);
  const [error, setError] = useState<{ message: string; conflicts: string[] } | null>(null);
  const [message, setMessage] = useState(() => defaultCommitMessage(c, Object.values(useBoard.getState().jobs)));
  const [version, setVersion] = useState(0); // remounts file rows (fresh diffs) after an action

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await gitApi.summary(id));
      setVersion((v) => v + 1);
    } catch (e) {
      setError({ message: (e as Error).message, conflicts: [] });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (kind: 'commit' | 'merge', fn: () => Promise<GitSummary>, done: string) => {
    setBusy(kind);
    setError(null);
    try {
      setSummary(await fn());
      setVersion((v) => v + 1);
      useBoard.getState().toast(done);
    } catch (e) {
      const err = e as GitApiError;
      setError({ message: err.message, conflicts: err.conflicts ?? [] });
    } finally {
      setBusy(null);
    }
  };

  const askDiscard = () =>
    useBoard.getState().askConfirm({
      title: `Discard ${git.branch}?`,
      message: `This stops ${c.name}, deletes the worktree folder ${git.worktree} with any uncommitted changes, and deletes the branch. Commits that were not merged are lost.`,
      confirmLabel: 'Discard branch',
      danger: true,
      onConfirm: async () => {
        setBusy('discard');
        try {
          await gitApi.discard(id);
          useBoard.getState().toast(`Discarded ${git.branch}`);
          closeReview();
        } catch (e) {
          setError({ message: (e as Error).message, conflicts: [] });
        } finally {
          setBusy(null);
        }
      },
    });

  const copyPath = () => {
    void navigator.clipboard
      ?.writeText(git.worktree)
      .then(() => useBoard.getState().toast('Worktree path copied'))
      .catch(() => useBoard.getState().toast(git.worktree));
  };

  const dirty = (summary?.uncommitted.length ?? 0) > 0;
  const mergeBlock = useMemo(() => {
    if (!summary) return 'Loading…';
    if (summary.missing) return 'The worktree folder is gone';
    if (dirty) return 'Commit the uncommitted changes first';
    if (summary.ahead === 0) return 'No new commits to merge';
    if (summary.mainBranch !== git.baseRef) return `The main checkout is on ${summary.mainBranch ?? 'a detached HEAD'}, not ${git.baseRef}`;
    if (summary.mainDirty) return 'The main checkout has uncommitted changes';
    return null;
  }, [summary, dirty, git.baseRef]);

  const stats = summary?.stats ?? c.gitStats;

  return (
    <Modal title={`Review ${c.name}`} onClose={closeReview} width="max-w-5xl" testId="review-panel">
      <div className="aa-card-glow flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <GitBranch size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">Review {c.name}'s work</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-muted">
            <span data-testid="review-branch" className="rounded-md bg-accent/12 px-1.5 py-[1px] font-mono text-[11.5px] text-accent">
              {git.branch}
            </span>
            <span className="text-fg-subtle">vs</span>
            <span className="rounded-md bg-hover px-1.5 py-[1px] font-mono text-[11.5px] text-fg">{git.baseRef}</span>
            {summary && (
              <>
                <span data-testid="review-ahead" className="inline-flex items-center gap-0.5 tabular-nums" title="Commits on the branch, not on base">
                  <ArrowUp size={12} className="text-project-green" />
                  {summary.ahead} ahead
                </span>
                <span className="inline-flex items-center gap-0.5 tabular-nums" title="Commits on base, not on the branch">
                  <ArrowDown size={12} className="text-project-amber" />
                  {summary.behind} behind
                </span>
              </>
            )}
            {stats && (
              <span data-testid="review-totals" className="ml-1">
                <Counts added={stats.added} removed={stats.removed} />
                <span className="ml-1 text-fg-subtle">in {stats.files} {stats.files === 1 ? 'file' : 'files'}</span>
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh"
          data-testid="review-refresh"
          onClick={() => void refresh()}
          className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          aria-label="Close review"
          onClick={closeReview}
          className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={15} />
        </button>
      </div>

      <div className="aa-scroll max-h-[56vh] min-h-40 overflow-y-auto px-5 pt-3 pb-1">
        {!summary && loading && (
          <p className="flex items-center justify-center gap-2 py-12 text-fg-subtle">
            <LoaderCircle size={15} className="animate-spin" /> Reading the branch…
          </p>
        )}
        {summary?.missing && (
          <p className="mb-3 flex items-center gap-2 rounded-lg border border-needs/40 bg-needs/10 px-3 py-2 text-[12px] text-needs">
            <TriangleAlert size={14} /> The worktree folder {git.worktree} no longer exists.
          </p>
        )}
        {summary && (
          <div key={version}>
            <Section
              title="Uncommitted changes"
              testId="review-uncommitted"
              files={summary.uncommitted}
              id={id}
              scope="uncommitted"
              empty="The worktree is clean. Nothing waiting to be committed."
            />
            <Section
              title={`Committed on ${git.branch}`}
              testId="review-committed"
              files={summary.committed}
              id={id}
              scope="committed"
              empty="No commits on this branch yet."
            />
          </div>
        )}
      </div>

      {error && (
        <div data-testid="review-error" className="border-t border-error/30 bg-error/10 px-5 py-2 text-[12px] text-error">
          <p className="font-medium whitespace-pre-wrap">{error.message}</p>
          {error.conflicts.length > 0 && (
            <ul data-testid="review-conflicts" className="mt-1 list-disc pl-5 font-mono text-[11.5px]">
              {error.conflicts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dirty && (
        <form
          className="flex items-center gap-2 border-t border-line px-5 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim() && !busy) void run('commit', () => gitApi.commit(id, message.trim()), 'Committed all changes');
          }}
        >
          <GitCommitHorizontal size={15} className="shrink-0 text-fg-subtle" />
          <input
            data-testid="review-commit-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12.5px] text-fg outline-none placeholder:text-fg-subtle
                       focus:border-accent"
          />
          <button
            type="submit"
            data-testid="review-commit"
            disabled={!message.trim() || !!busy}
            className="aa-btn-primary inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold disabled:opacity-50"
          >
            {busy === 'commit' ? <LoaderCircle size={13} className="animate-spin" /> : <GitCommitHorizontal size={13} />}
            Commit all
          </button>
        </form>
      )}

      <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
        <button
          type="button"
          data-testid="review-open-folder"
          onClick={copyPath}
          title={`Copy ${git.worktree}`}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] text-fg-subtle
                     hover:bg-hover hover:text-fg"
        >
          <Copy size={12} className="shrink-0" />
          <span className="truncate">{git.worktree}</span>
        </button>
        <span className="ml-auto" />
        <button
          type="button"
          data-testid="review-discard"
          disabled={!!busy}
          onClick={askDiscard}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-[12.5px] font-semibold text-error disabled:opacity-50
                     hover:bg-error/10"
        >
          {busy === 'discard' ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}
          Discard branch
        </button>
        <button
          type="button"
          data-testid="review-merge"
          disabled={!!mergeBlock || !!busy}
          title={mergeBlock ?? `git merge --no-ff ${git.branch} in ${git.repoRoot}`}
          onClick={() => void run('merge', () => gitApi.merge(id), `Merged ${git.branch} into ${git.baseRef}`)}
          className="aa-btn-primary inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold disabled:opacity-50"
        >
          {busy === 'merge' ? <LoaderCircle size={13} className="animate-spin" /> : <GitMerge size={13} />}
          Merge into {git.baseRef}
        </button>
      </div>
      {mergeBlock && summary && (
        <p data-testid="review-merge-hint" className="bg-surface-2 px-5 pb-2.5 -mt-1.5 text-right text-[11.5px] text-fg-subtle">
          {mergeBlock}
        </p>
      )}
    </Modal>
  );
}

// Mounted once in App; renders the panel for the console picked with openReview(id)
export function ReviewHost() {
  const id = useReview((s) => s.id);
  const c = useBoard((s) => (id ? s.consoles[id] : undefined));
  useEffect(() => {
    // The console was removed (or lost its branch) while the panel was open
    if (id && !c?.git) closeReview();
  }, [id, c?.git]);
  if (!id || !c?.git) return null;
  return <ReviewPanel key={id} console={c} />;
}

// Console header chip: branch name + "+N −M"; opens the Review panel
export function BranchChip({ console: c }: { console: ConsoleInfo }) {
  if (!c.git) return null;
  const s = c.gitStats;
  const short = c.git.branch.replace(/^agentarmy\//, '');
  const changed = !!s && (s.added > 0 || s.removed > 0);
  return (
    <button
      type="button"
      data-testid="console-review"
      title={`Review ${c.git.branch} vs ${c.git.baseRef}${s?.dirty ? ' (uncommitted changes)' : ''}`}
      aria-label={`Review branch ${c.git.branch}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => openReview(c.id)}
      className="nodrag inline-flex h-5 max-w-[45%] min-w-0 shrink items-center gap-1 rounded-full border border-line px-1.5 text-[10.5px] text-fg-muted
                 hover:border-accent/60 hover:text-fg"
    >
      <GitBranch size={11} className="shrink-0 text-accent" />
      <span className="truncate font-mono">{short}</span>
      {changed && (
        <span data-testid="console-review-stats" className="shrink-0 font-mono tabular-nums">
          <span className="text-project-green">+{s.added}</span> <span className="text-error">−{s.removed}</span>
        </span>
      )}
      {s?.dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-needs" />}
    </button>
  );
}
