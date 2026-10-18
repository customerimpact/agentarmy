import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ChevronRight,
  Clock,
  CornerDownRight,
  CornerLeftUp,
  Folder,
  GitBranch,
  HardDrive,
  LoaderCircle,
  Search,
} from 'lucide-react';
import type { FsListResponse } from '../../shared/protocol';
import { api } from '../lib/api';
import { getRecentFolders } from '../lib/recent-folders';
import { basename } from '../lib/status';

interface Crumb {
  label: string;
  path: string;
}

function breadcrumbs(path: string): Crumb[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (!path.includes('\\') && path.startsWith('/')) {
    const crumbs: Crumb[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  // Windows: first part is the drive ("C:"), whose root needs the trailing backslash
  const crumbs: Crumb[] = [];
  let acc = '';
  parts.forEach((part, index) => {
    acc = index === 0 ? `${part}\\` : acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`;
    crumbs.push({ label: part, path: acc });
  });
  return crumbs;
}

// https://github.com/owner/repo(.git), github.com/owner/repo, git@github.com:owner/repo.git
const GIT_URL = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+|git@[\w.-]+:[\w.-]+\/[\w.-]+|https?:\/\/\S+\.git)\/?\S*$/i;

export function isGitUrl(text: string): boolean {
  return GIT_URL.test(text.trim());
}

// 'https://github.com/acme/web-app.git' -> 'web-app'; 'acme/web-app' -> 'web-app'
export function repoNameFromUrl(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const match = /(?:^|[/:])([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
  if (match) return match[2];
  return null;
}

export function joinPath(parent: string, child: string): string {
  const sep = parent.includes('\\') ? '\\' : '/';
  return parent.endsWith(sep) ? parent + child : parent + sep + child;
}

interface FolderPickerProps {
  // Folder to open first; falls back to the home dir if it no longer exists. Omitted = home.
  startPath?: string;
  // Called with the folder the action button would use (highlighted entry, else the open folder)
  onTargetChange: (path: string | null) => void;
  // A GitHub/git URL typed or pasted into the filter box
  onGitUrl?: (url: string) => void;
  heightClass?: string;
  autoFocus?: boolean;
}

// Server-backed folder browser: drives, breadcrumbs, recent folders and type-to-filter
export function FolderPicker({
  startPath,
  onTargetChange,
  onGitUrl,
  heightClass = 'h-80',
  autoFocus = true,
}: FolderPickerProps) {
  const [listing, setListing] = useState<FsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [recent] = useState(getRecentFolders);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const filterAtNavigation = useRef('');
  const filterValue = useRef('');
  filterValue.current = filter;
  const startRef = useRef(startPath);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoFocusRef = useRef(autoFocus);
  const onGitUrlRef = useRef(onGitUrl);
  onGitUrlRef.current = onGitUrl;

  // Resolves 'stale' when a newer navigation superseded this one, so callers don't treat it as a failure
  const navigate = useCallback(async (path?: string): Promise<'ok' | 'error' | 'stale'> => {
    const seq = ++requestSeq.current;
    // Remember what the filter held when navigation started; anything typed while the
    // listing loads is type-ahead for the next folder and must survive the reset
    filterAtNavigation.current = filterValue.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.listDir(path);
      if (seq !== requestSeq.current) return 'stale';
      setListing(result);
      setHighlighted(null);
      const before = filterAtNavigation.current;
      setFilter((current) =>
        current.startsWith(before) && current !== before ? current.slice(before.length) : '',
      );
      listRef.current?.scrollTo({ top: 0 });
      // Clicking a crumb or root moves focus to that button; keep typing-to-filter working
      // (but don't steal focus from fields outside the picker, e.g. the clone URL input)
      if (autoFocusRef.current || rootRef.current?.contains(document.activeElement)) {
        filterRef.current?.focus();
      }
      return 'ok';
    } catch (e) {
      if (seq !== requestSeq.current) return 'stale';
      setError((e as Error).message);
      return 'error';
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const start = startRef.current;
    void navigate(start).then((result) => {
      if (result === 'error' && start) void navigate();
    });
  }, [navigate]);

  // A pasted or typed absolute path (C:\..., C:/..., /..., ~/...) jumps straight there
  const pathLike = /^([a-zA-Z]:[\\/]|\/|~([\\/]|$))/.test(filter.trim());
  const gitLike = !!onGitUrl && isGitUrl(filter);

  const dirs = useMemo(() => {
    const all = listing?.dirs ?? [];
    const q = filter.trim().toLowerCase();
    if (pathLike || gitLike) return [];
    return q ? all.filter((d) => d.name.toLowerCase().includes(q)) : all;
  }, [listing, filter, pathLike, gitLike]);

  // Filtering highlights the first match so Enter opens it without an extra Down press
  useEffect(() => {
    setHighlighted(filter.trim() && dirs.length ? dirs[0].path : null);
  }, [filter, dirs]);

  const target = highlighted ?? listing?.path ?? null;
  useEffect(() => onTargetChange(target), [target, onTargetChange]);

  const goToTypedPath = async () => {
    let path = filter.trim();
    if (path.startsWith('~')) {
      try {
        const home = (await api.listDir()).path;
        const sep = home.includes('\\') ? '\\' : '/';
        path = home + (path.length > 1 ? sep + path.slice(2) : '');
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    void navigate(path);
  };

  const cloneTypedUrl = () => {
    const url = filter.trim();
    setFilter('');
    onGitUrlRef.current?.(url);
  };

  const onListKey = (e: KeyboardEvent) => {
    // A stale highlight from the previous folder would open the wrong place
    if (loading && e.key === 'Enter') {
      e.preventDefault();
      return;
    }
    if (gitLike && e.key === 'Enter') {
      e.preventDefault();
      cloneTypedUrl();
      return;
    }
    if (pathLike && e.key === 'Enter') {
      e.preventDefault();
      void goToTypedPath();
      return;
    }
    if (!dirs.length) return;
    const index = dirs.findIndex((d) => d.path === highlighted);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        e.key === 'ArrowDown' ? Math.min(dirs.length - 1, index + 1) : Math.max(0, index - 1);
      setHighlighted(dirs[next].path);
      listRef.current?.querySelectorAll('[data-dir]')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && highlighted) {
      e.preventDefault();
      void navigate(highlighted);
    } else if (e.key === 'Backspace' && !filter && listing?.parent) {
      e.preventDefault();
      void navigate(listing.parent);
    }
  };

  return (
    <div ref={rootRef}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-2 px-5 py-2">
        {listing?.roots.map((root) => (
          <button
            key={root}
            type="button"
            onClick={() => void navigate(root)}
            className={`inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-fg-muted
                        hover:border-accent/50 hover:text-fg
                        ${listing.path.toLowerCase().startsWith(root.toLowerCase()) ? 'border-line-strong text-fg' : ''}`}
          >
            <HardDrive size={11} />
            {root}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-[12px]">
          {listing &&
            breadcrumbs(listing.path).map((crumb, index, all) => (
              <span key={crumb.path} className="inline-flex items-center">
                {index > 0 && <ChevronRight size={12} className="text-fg-subtle" />}
                <button
                  type="button"
                  onClick={() => void navigate(crumb.path)}
                  className={`rounded px-1 py-0.5
                              hover:bg-hover hover:text-fg
                              ${index === all.length - 1 ? 'text-fg' : 'text-fg-muted'}`}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
        </div>
      </div>

      <div className={`flex ${heightClass}`}>
        {recent.length > 0 && (
          <div className="aa-scroll w-48 shrink-0 overflow-y-auto border-r border-line p-2">
            <div className="aa-label flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-fg-subtle">
              <Clock size={11} />
              Recent
            </div>
            {recent.map((path) => (
              <button
                key={path}
                type="button"
                title={path}
                onClick={() => void navigate(path)}
                className="block w-full truncate rounded-md px-2 py-1 text-left text-fg-muted
                           hover:bg-hover hover:text-fg"
              >
                {basename(path)}
              </button>
            ))}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <Search size={13} className="text-fg-subtle" />
            <input
              ref={filterRef}
              data-autofocus={autoFocus || undefined}
              data-testid="folder-picker-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onListKey}
              placeholder={
                onGitUrl
                  ? 'Filter, type a path, or paste a GitHub URL to clone it'
                  : 'Filter folders  (arrows to move, Enter to open, Backspace to go up)'
              }
              className="min-w-0 flex-1 bg-transparent py-1 text-fg outline-none placeholder:text-fg-subtle"
            />
            {loading && <LoaderCircle size={14} className="animate-spin text-fg-subtle" />}
          </div>
          <div ref={listRef} className="aa-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
            {gitLike && (
              <button
                type="button"
                data-testid="folder-picker-clone"
                onClick={cloneTypedUrl}
                className="flex w-full items-center gap-2 rounded-md bg-accent/15 px-2 py-1 text-left text-fg"
              >
                <GitBranch size={14} className="text-accent" />
                <span className="truncate">
                  Clone <span className="font-mono text-[12px]">{filter.trim()}</span>
                </span>
                <kbd className="ml-auto font-mono text-[10px] text-fg-subtle">Enter</kbd>
              </button>
            )}
            {pathLike && !gitLike && (
              <button
                type="button"
                data-testid="folder-picker-goto"
                onClick={() => void goToTypedPath()}
                className="flex w-full items-center gap-2 rounded-md bg-accent/15 px-2 py-1 text-left text-fg"
              >
                <CornerDownRight size={14} className="text-accent" />
                <span className="truncate">
                  Go to <span className="font-mono text-[12px]">{filter.trim()}</span>
                </span>
                <kbd className="ml-auto font-mono text-[10px] text-fg-subtle">Enter</kbd>
              </button>
            )}
            {!pathLike && !gitLike && listing?.parent && (
              <button
                type="button"
                onClick={() => void navigate(listing.parent!)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-fg-subtle
                           hover:bg-hover hover:text-fg"
              >
                <CornerLeftUp size={14} />
                ..
              </button>
            )}
            {dirs.map((dir) => (
              <button
                key={dir.path}
                data-dir
                data-testid="folder-picker-entry"
                data-path={dir.path}
                type="button"
                onClick={() => setHighlighted(dir.path === highlighted ? null : dir.path)}
                onDoubleClick={() => void navigate(dir.path)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left
                            ${dir.path === highlighted ? 'bg-accent/15 text-fg ring-1 ring-accent/30' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
              >
                <Folder
                  size={14}
                  className={dir.path === highlighted ? 'text-accent' : 'text-fg-subtle'}
                />
                <span className="truncate">{dir.name}</span>
              </button>
            ))}
            {!loading && listing && !pathLike && !gitLike && dirs.length === 0 && (
              <p className="px-2 py-6 text-center text-fg-subtle">
                {filter ? 'No matching folders.' : 'No subfolders here.'}
              </p>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="border-t border-error/30 bg-error/10 px-5 py-2 text-[12px] text-error">
          {error}
        </div>
      )}
    </div>
  );
}
