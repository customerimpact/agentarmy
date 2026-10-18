import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { GitRepoInfo } from '../../shared/protocol';
import { gitApi } from '../lib/review';

// Asks the server whether `path` is inside a git repo (debounced; null while unknown)
export function useRepoInfo(path: string | null): GitRepoInfo | null {
  const [info, setInfo] = useState<GitRepoInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!path) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      gitApi
        .info(path)
        .then((res) => !cancelled && setInfo(res))
        .catch(() => !cancelled && setInfo({ repoRoot: null, branch: null }));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path]);
  return info;
}

const repoName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

// "Isolated branch (git worktree)" checkbox; only shown when the folder is inside a git repo
export function WorktreeToggle({
  path,
  checked,
  onChange,
  label = 'Isolated branch (git worktree)',
}: {
  path: string | null;
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  const info = useRepoInfo(path);
  const inRepo = !!info?.repoRoot;
  useEffect(() => {
    if (info && !inRepo && checked) onChange(false);
  }, [info, inRepo, checked, onChange]);
  if (!inRepo) return null;
  const name = repoName(info.repoRoot!);
  return (
    <label
      data-testid="worktree-toggle"
      className="mt-1.5 flex cursor-pointer items-start gap-2 text-[12px] text-fg-muted select-none"
      title={`git worktree add -b agentarmy/<name> ../${name}.worktrees/<name> ${info.branch ?? 'HEAD'}`}
    >
      <input
        type="checkbox"
        data-testid="worktree-toggle-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[2px] accent-[var(--aa-accent)]"
      />
      <span className="min-w-0">
        <span className="inline-flex items-center gap-1 font-medium text-fg">
          <GitBranch size={12} className="text-accent" />
          {label}
        </span>
        <span className="block truncate text-[11px] text-fg-subtle">
          New branch from {info.branch ?? 'HEAD'} in {name}.worktrees/ next to the repo, so parallel agents don't
          collide. Review and merge it from the board.
        </span>
      </span>
    </label>
  );
}
