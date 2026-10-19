import { useEffect, useState } from 'react';
import { FileCode, SquareArrowOutUpRight } from 'lucide-react';
import type { CodeFileResponse, FileItemData } from '../../../shared/repo';
import { codeApi, openCodeViewer } from '../../lib/repo';
import { useBoard } from '../../lib/store';
import { CodeLines, useHighlighted } from '../CodeViewer';
import { DeleteItemButton, IconBtn } from './common';
import { registerItemRenderer, type ItemRendererProps } from './registry';

// Pinned code card (board item kind 'file'): file name, ~40 highlighted lines (from the pinned line,
// if any), scrollable. Click opens the full viewer there. Re-fetches when the file changes on disk
// (cheap stat poll every few seconds; the full read only happens when size or mtime moved).

const PREVIEW_LINES = 40;
const POLL_MS = 3000;
const LINES_BEFORE = 4;

function FileItem({ item, zoom, remove }: ItemRendererProps<FileItemData>) {
  const { path, consoleId, line } = item.data;
  const owner = useBoard((s) => s.consoles[consoleId]);
  const [file, setFile] = useState<CodeFileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lines = useHighlighted(file);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const hasOwner = !!owner;

  useEffect(() => {
    if (!hasOwner) return;
    let cancelled = false;
    let stamp = '';
    const load = () =>
      codeApi.file(consoleId, path).then(
        (f) => {
          if (cancelled) return;
          stamp = `${f.size}:${f.mtimeMs}`;
          setFile(f);
          setError(null);
        },
        (e: Error) => !cancelled && setError(e.message),
      );
    void load();
    const timer = setInterval(() => {
      if (document.hidden) return;
      codeApi.stat(consoleId, path).then(
        (s) => {
          if (!cancelled && `${s.size}:${s.mtimeMs}` !== stamp) void load();
        },
        (e: Error) => !cancelled && setError(e.message),
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [consoleId, path, hasOwner]);

  const start = line ? Math.max(1, line - LINES_BEFORE) : 1;
  const shown = lines?.slice(start - 1, start - 1 + PREVIEW_LINES) ?? null;
  const open = (at?: number) => owner && openCodeViewer(consoleId, path, at ?? line ?? null);

  return (
    <div
      data-testid="file-card"
      data-path={path}
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/40"
    >
      <header className="aa-drag-handle flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-line bg-surface-2 pr-1 pl-2.5 active:cursor-grabbing">
        <FileCode size={13} className="shrink-0 text-accent" />
        <span className="truncate text-[12.5px] font-semibold text-fg" title={path}>
          {name}
        </span>
        {line && <span className="shrink-0 font-mono text-[11px] text-fg-subtle">:{line}</span>}
        {dir && zoom > 0.5 && <span className="min-w-0 truncate font-mono text-[11px] text-fg-subtle">{dir}</span>}
        <span className="ml-auto" />
        <IconBtn label="Open in the code viewer" testId="file-card-open" onClick={() => open()}>
          <SquareArrowOutUpRight size={13} />
        </IconBtn>
        <DeleteItemButton remove={remove} />
      </header>
      <div
        data-testid="file-card-body"
        onClick={(e) => {
          const row = (e.target as HTMLElement).closest('tr[data-line]');
          open(row ? Number(row.getAttribute('data-line')) : undefined);
        }}
        className="nodrag nowheel aa-scroll min-h-0 flex-1 cursor-pointer overflow-auto bg-term"
      >
        {!owner && <p className="px-3 py-2 text-[12px] text-fg-subtle">The agent this file belonged to is gone.</p>}
        {owner && error && <p className="px-3 py-2 text-[12px] text-error">{error}</p>}
        {owner && !error && file && file.kind !== 'text' && (
          <p className="px-3 py-2 text-[12px] text-fg-muted">{file.kind === 'binary' ? 'Binary file' : 'Too large to preview (over 1 MB)'}</p>
        )}
        {owner && !error && !file && <p className="px-3 py-2 text-[12px] text-fg-subtle">Loading…</p>}
        {shown && <CodeLines testId="file-card-lines" lines={shown} start={start} highlight={line ?? null} />}
        {lines && lines.length > start - 1 + PREVIEW_LINES && (
          <p className="border-t border-line/60 px-3 py-1 text-[11px] text-fg-subtle">
            {lines.length - (start - 1 + PREVIEW_LINES)} more lines. Click to open.
          </p>
        )}
      </div>
    </div>
  );
}

registerItemRenderer<FileItemData>('file', FileItem, { label: 'File', minWidth: 300, minHeight: 160, frameless: true });
