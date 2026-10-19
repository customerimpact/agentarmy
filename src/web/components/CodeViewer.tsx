import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Copy,
  File,
  FileCode,
  Folder,
  FolderOpen,
  LoaderCircle,
  Pin,
  Search,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ConsoleInfo } from '../../shared/protocol';
import type { CodeFileResponse, CodeTreeEntry, FileItemData } from '../../shared/repo';
import { highlightLines } from '../lib/highlight';
import { itemsApi, useItems, workspaceOf } from '../lib/items';
import { closeCodeViewer, codeApi, openCodeViewer, useCodeViewer, vscodeUrl } from '../lib/repo';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';

// Read-only code viewer for a console's folder (its repository when it is in one): lazy file tree
// that respects .gitignore, name search, highlighted file with line numbers, copy path, open in
// VS Code, jump to line, and Pin to board (a 'file' board item, see items/FileItem.tsx).

const PAGE_LINES = 5000;

function TreeRow({
  id,
  entry,
  depth,
  selected,
  onOpen,
}: {
  id: string;
  entry: CodeTreeEntry;
  depth: number;
  selected: string | null;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<CodeTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || children || !entry.dir) return;
    codeApi.tree(id, entry.path).then(
      (r) => setChildren(r.entries),
      (e: Error) => setError(e.message),
    );
  }, [open, children, id, entry]);

  const pad = { paddingLeft: 8 + depth * 14 };
  if (!entry.dir) {
    return (
      <li>
        <button
          type="button"
          data-testid="code-tree-file"
          data-path={entry.path}
          aria-current={selected === entry.path}
          onClick={() => onOpen(entry.path)}
          style={pad}
          className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left hover:bg-hover
                      ${selected === entry.path ? 'bg-accent/12 text-fg' : 'text-fg-muted'}`}
        >
          <span className="w-3 shrink-0" />
          <File size={13} className="shrink-0 text-fg-subtle" />
          <span className="truncate">{entry.name}</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        data-testid="code-tree-dir"
        data-path={entry.path}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={pad}
        className="flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-fg hover:bg-hover"
      >
        <ChevronRight size={12} className={`shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        {open ? <FolderOpen size={13} className="shrink-0 text-accent" /> : <Folder size={13} className="shrink-0 text-accent/80" />}
        <span className="truncate">{entry.name}</span>
      </button>
      {open && (
        <ul>
          {error && <li style={{ paddingLeft: 22 + depth * 14 }} className="py-1 text-error">{error}</li>}
          {!children && !error && (
            <li style={{ paddingLeft: 22 + depth * 14 }} className="py-1 text-fg-subtle">
              Loading…
            </li>
          )}
          {children?.length === 0 && (
            <li style={{ paddingLeft: 22 + depth * 14 }} className="py-1 text-fg-subtle">
              Empty
            </li>
          )}
          {children?.map((e) => (
            <TreeRow key={e.path} id={id} entry={e} depth={depth + 1} selected={selected} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

function FileTree({ id, selected, onOpen }: { id: string; selected: string | null; onOpen: (path: string) => void }) {
  const [top, setTop] = useState<{ entries: CodeTreeEntry[]; source: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ q: string; list: string[]; truncated: boolean } | null>(null);

  useEffect(() => {
    codeApi.tree(id).then(setTop, (e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches(null);
      return;
    }
    const timer = setTimeout(() => {
      codeApi.search(id, q).then(
        (r) => setMatches({ q, list: r.matches, truncated: r.truncated }),
        (e: Error) => setError(e.message),
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [id, query]);

  return (
    <div className="flex min-h-0 flex-col border-line md:border-r">
      <label className="m-2 flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-accent">
        <Search size={12} className="shrink-0 text-fg-subtle" />
        <input
          data-autofocus
          data-testid="code-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches?.list[0]) onOpen(matches.list[0]);
          }}
          placeholder="Search file names"
          className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-subtle"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-fg-subtle hover:text-fg">
            <X size={12} />
          </button>
        )}
      </label>
      <div className="aa-scroll min-h-0 flex-1 overflow-y-auto pb-2 text-[12.5px]" data-testid="code-tree">
        {error && <p className="px-3 py-2 text-[12px] text-error">{error}</p>}
        {matches ? (
          <ul data-testid="code-search-results">
            {matches.list.length === 0 && <li className="px-3 py-2 text-fg-subtle">No file names match “{matches.q}”.</li>}
            {matches.list.map((p) => {
              const slash = p.lastIndexOf('/');
              return (
                <li key={p}>
                  <button
                    type="button"
                    data-testid="code-search-result"
                    data-path={p}
                    onClick={() => onOpen(p)}
                    className={`flex w-full min-w-0 items-baseline gap-1.5 px-3 py-[3px] text-left hover:bg-hover ${selected === p ? 'bg-accent/12' : ''}`}
                  >
                    <span className="shrink-0 text-fg">{p.slice(slash + 1)}</span>
                    <span className="truncate text-[11px] text-fg-subtle">{slash > 0 ? p.slice(0, slash) : ''}</span>
                  </button>
                </li>
              );
            })}
            {matches.truncated && <li className="px-3 py-1 text-[11px] text-fg-subtle">More matches; refine the search.</li>}
          </ul>
        ) : (
          !top &&
          !error && (
            <p className="flex items-center gap-2 px-3 py-2 text-fg-subtle">
              <LoaderCircle size={12} className="animate-spin" /> Listing files…
            </p>
          )
        )}
        {top && (
          // Stays mounted (hidden) while searching, so expanded folders survive a search
          <ul hidden={!!matches}>
            {top.entries.length === 0 && <li className="px-3 py-2 text-fg-subtle">No files.</li>}
            {top.entries.map((e) => (
              <TreeRow key={e.path} id={id} entry={e} depth={0} selected={selected} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </div>
      {top && (
        <p className="border-t border-line px-3 py-1.5 text-[10.5px] text-fg-subtle">
          {top.source === 'git' ? 'Git files (.gitignore respected)' : 'Folder (node_modules, .git, dist hidden)'}
        </p>
      )}
    </div>
  );
}

// Highlighted lines for a file response (shared with the pinned card)
export function useHighlighted(file: { content?: string; language: string | null } | null): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    setLines(null);
    if (!file?.content && file?.content !== '') return;
    let cancelled = false;
    void highlightLines(file.content, file.language).then((l) => !cancelled && setLines(l));
    return () => {
      cancelled = true;
    };
  }, [file]);
  return lines;
}

export function CodeLines({
  lines,
  start = 1,
  highlight,
  limit,
  onLineClick,
  testId,
}: {
  lines: string[];
  start?: number;
  highlight?: number | null;
  limit?: number;
  onLineClick?: (line: number) => void;
  testId?: string;
}) {
  const shown = limit ? lines.slice(0, limit) : lines;
  return (
    <table data-testid={testId} className="w-full border-collapse font-mono text-[12px] leading-[19px]">
      <tbody>
        {shown.map((html, i) => {
          const n = start + i;
          return (
            <tr key={n} data-line={n} className={highlight === n ? 'bg-accent/15' : ''}>
              <td
                onClick={onLineClick ? () => onLineClick(n) : undefined}
                className={`sticky left-0 w-[1%] border-r border-line/60 bg-term px-2 text-right whitespace-nowrap text-fg-subtle/70 select-none
                            ${onLineClick ? 'cursor-pointer hover:text-fg' : ''}`}
              >
                {n}
              </td>
              {/* hljs output: text is escaped, only <span class> tags */}
              <td className="pr-4 pl-3 whitespace-pre text-term-fg" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FileView({ c, path, line, nonce }: { c: ConsoleInfo; path: string; line: number | null; nonce: number }) {
  const [file, setFile] = useState<CodeFileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_LINES);
  const [target, setTarget] = useState<number | null>(line);
  const [goto, setGoto] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const lines = useHighlighted(file);

  useEffect(() => {
    setFile(null);
    setError(null);
    setLimit(PAGE_LINES);
    codeApi.file(c.id, path).then(setFile, (e: Error) => setError(e.message));
  }, [c.id, path]);

  useEffect(() => setTarget(line), [line, nonce]);

  // Scroll the target line into view once it is rendered
  useEffect(() => {
    if (!lines || !target) return;
    if (target > limit) {
      setLimit(Math.ceil(target / PAGE_LINES) * PAGE_LINES);
      return;
    }
    const row = scroller.current?.querySelector<HTMLElement>(`tr[data-line="${target}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [lines, target, limit, nonce]);

  const copyPath = () => {
    const p = file?.absPath ?? path;
    void navigator.clipboard
      ?.writeText(p)
      .then(() => useBoard.getState().toast('Path copied'))
      .catch(() => useBoard.getState().toast(p));
  };

  const pin = async () => {
    const data: FileItemData = { path, consoleId: c.id, ...(target ? { line: target } : {}) };
    try {
      const item = await itemsApi.create({
        kind: 'file',
        data: { ...data },
        workspaceId: workspaceOf(c),
        layout: { x: c.layout.x + c.layout.width + 40, y: c.layout.y, width: 520, height: 420 },
      });
      useItems.getState().upsertItem(item);
      useBoard.getState().toast(`Pinned ${path.slice(path.lastIndexOf('/') + 1)} to the board`);
    } catch (e) {
      useBoard.getState().toast(`Could not pin: ${(e as Error).message}`);
    }
  };

  const name = path.slice(path.lastIndexOf('/') + 1);
  const lineCount = lines?.length ?? 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <FileCode size={14} className="shrink-0 text-accent" />
        <span data-testid="code-file-path" className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={file?.absPath ?? path}>
          {path}
        </span>
        {file?.kind === 'text' && (
          <form
            className="flex items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(goto);
              if (Number.isInteger(n) && n >= 1) setTarget(Math.min(n, lineCount || n));
            }}
          >
            <input
              data-testid="code-goto"
              value={goto}
              inputMode="numeric"
              onChange={(e) => setGoto(e.target.value.replace(/\D/g, ''))}
              placeholder="Line"
              aria-label="Go to line"
              className="h-6 w-16 rounded-md border border-line bg-surface px-1.5 text-[11.5px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
          </form>
        )}
        <button type="button" data-testid="code-copy-path" onClick={copyPath} title="Copy the full path" className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-fg-muted hover:bg-hover hover:text-fg">
          <Copy size={12} /> Copy path
        </button>
        {file && (
          <a
            data-testid="code-open-vscode"
            href={vscodeUrl(file.absPath, target)}
            title="Open in VS Code"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            <SquareArrowOutUpRight size={12} /> VS Code
          </a>
        )}
        <button type="button" data-testid="code-pin" onClick={() => void pin()} className="aa-btn-primary inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold">
          <Pin size={12} /> Pin to board
        </button>
      </div>
      <div ref={scroller} data-testid="code-view" className="aa-scroll min-h-0 flex-1 overflow-auto bg-term">
        {error && (
          <p className="flex items-center gap-2 px-4 py-3 text-[12px] text-error">
            <TriangleAlert size={14} /> {error}
          </p>
        )}
        {!file && !error && (
          <p className="flex items-center gap-2 px-4 py-3 text-[12px] text-fg-subtle">
            <LoaderCircle size={13} className="animate-spin" /> Opening {name}…
          </p>
        )}
        {file?.kind === 'too-large' && (
          <p data-testid="code-too-large" className="px-4 py-3 text-[12px] text-fg-muted">
            {name} is too large to show here ({(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 1 MB). Open it in VS Code.
          </p>
        )}
        {file?.kind === 'binary' && (
          <p data-testid="code-binary" className="px-4 py-3 text-[12px] text-fg-muted">
            {name} is a binary file ({file.size.toLocaleString()} bytes).
          </p>
        )}
        {file?.kind === 'text' && !lines && (
          <p className="flex items-center gap-2 px-4 py-3 text-[12px] text-fg-subtle">
            <LoaderCircle size={13} className="animate-spin" /> Highlighting…
          </p>
        )}
        {lines && <CodeLines testId="code-lines" lines={lines} highlight={target} limit={limit} onLineClick={setTarget} />}
        {lines && lines.length > limit && (
          <button type="button" onClick={() => setLimit((n) => n + PAGE_LINES)} className="w-full border-t border-line py-1.5 text-[12px] font-medium text-accent hover:bg-hover">
            Show {Math.min(PAGE_LINES, lines.length - limit)} more lines ({lines.length - limit} hidden)
          </button>
        )}
      </div>
    </div>
  );
}

function CodeViewer({ c, path, line, nonce }: { c: ConsoleInfo; path: string | null; line: number | null; nonce: number }) {
  const folder = useMemo(() => c.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? c.cwd, [c.cwd]);
  return (
    <Modal title={`Files of ${c.name}`} onClose={closeCodeViewer} width="max-w-6xl" testId="code-viewer">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <FileCode size={15} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">
          {folder} <span className="ml-1 text-[12px] font-normal text-fg-subtle">{c.name}</span>
        </h2>
        <button type="button" aria-label="Close files" onClick={closeCodeViewer} className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div className="grid h-[70vh] grid-cols-1 md:grid-cols-[17rem_minmax(0,1fr)]">
        <FileTree id={c.id} selected={path} onOpen={(p) => openCodeViewer(c.id, p)} />
        {path ? (
          <FileView key={path} c={c} path={path} line={line} nonce={nonce} />
        ) : (
          <div className="hidden place-items-center text-[12.5px] text-fg-subtle md:grid">Pick a file on the left.</div>
        )}
      </div>
    </Modal>
  );
}

// Mounted once in App; shows the viewer opened with openCodeViewer(consoleId, path?, line?)
export function CodeViewerHost() {
  const target = useCodeViewer((s) => s.target);
  const c = useBoard((s) => (target ? s.consoles[target.id] : undefined));
  useEffect(() => {
    if (target && !c) closeCodeViewer();
  }, [target, c]);
  if (!target || !c) return null;
  return <CodeViewer key={c.id} c={c} path={target.path} line={target.line} nonce={target.nonce} />;
}

// Console header button: browse the console's files
export function FilesButton({ id }: { id: string }) {
  return (
    <button
      type="button"
      title="Files"
      aria-label="Browse files"
      data-testid="console-files"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => openCodeViewer(id)}
      className="nodrag grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors
                 hover:bg-hover hover:text-accent"
    >
      <FileCode size={13} />
    </button>
  );
}
