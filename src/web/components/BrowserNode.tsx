import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NodeResizer, useStore, type Node, type NodeProps } from '@xyflow/react';
import { ArrowLeft, ArrowRight, Globe, Link2, RotateCw, X } from 'lucide-react';
import type { BrowserTile } from '../../shared/protocol';
import { api } from '../lib/api';
import { COMPACT_ZOOM, MIN_SIZE, flyTo, zoomAt } from '../lib/board-actions';
import {
  buttonName,
  localPoint,
  modifierBits,
  persistBrowserLayout,
  sendBrowserInput,
  toLocalPoint,
  toPagePoint,
  type Size,
} from '../lib/browser-input';
import { socket } from '../lib/socket';
import { lockLayout, unlockLayout, useBoard } from '../lib/store';

export type BrowserFlowNode = Node<Record<string, never>, 'browser'>;

const CURSOR_VISIBLE_MS = 6000;
const AGENT_COLOR = 'var(--aa-accent)';
const agentTint = (percent: number) => `color-mix(in srgb, ${AGENT_COLOR} ${percent}%, transparent)`;

function ChromeButton({
  label,
  onClick,
  children,
  danger,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={`nodrag grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors
                  hover:bg-hover ${danger ? 'hover:text-error' : 'hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url;
}

// The agent's pointer: an arrow with the driving console's name, gliding between updates
function AgentCursor({ tile, box, page, name }: { tile: BrowserTile; box: Size; page: Size; name: string }) {
  const rippleRef = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const cursor = tile.cursor;

  useEffect(() => {
    if (!cursor) return;
    setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), CURSOR_VISIBLE_MS + 50);
    return () => window.clearTimeout(timer);
  }, [cursor]);

  useEffect(() => {
    if (!cursor?.click || !rippleRef.current) return;
    rippleRef.current.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.2)', opacity: 0.9 },
        { transform: 'translate(-50%, -50%) scale(1.6)', opacity: 0 },
      ],
      { duration: 650, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );
  }, [cursor?.click, cursor?.t]);

  if (!cursor || !page.width || now - cursor.t > CURSOR_VISIBLE_MS) return null;
  const pt = toLocalPoint(cursor, box, page);
  return (
    <div
      data-testid="browser-agent-cursor"
      className="pointer-events-none absolute top-0 left-0 z-10"
      style={{
        transform: `translate(${pt.x}px, ${pt.y}px)`,
        transition: 'transform 70ms linear',
      }}
    >
      <span
        ref={rippleRef}
        className="absolute top-0 left-0 size-10 rounded-full opacity-0"
        style={{ border: `2px solid ${AGENT_COLOR}`, background: agentTint(20) }}
      />
      <svg width="22" height="22" viewBox="0 0 24 24" className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
        <path
          d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.3 L18 13.3 Z"
          style={{ fill: AGENT_COLOR }}
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute top-5 left-4 rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-accent-fg shadow"
        style={{ background: AGENT_COLOR }}
      >
        {name}
      </span>
    </div>
  );
}

function BrowserNodeImpl({ id }: NodeProps<BrowserFlowNode>) {
  const tile = useBoard((s) => s.browsers[id]);
  const linkedName = useBoard((s) =>
    tile?.linkedConsoleId ? (s.consoles[tile.linkedConsoleId]?.name ?? null) : null,
  );
  const selected = useBoard((s) => s.selectedId === id || s.selectedIds.includes(id));
  const live = useStore((s) => s.transform[2] >= COMPACT_ZOOM);

  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const [page, setPage] = useState<Size>({ width: 0, height: 0 });
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [focused, setFocused] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  // Stream frames while readable; below the compact zoom the last frame stays as a still
  useEffect(() => {
    if (!live) return;
    let decoding = false;
    let next: { data: string; width: number; height: number } | null = null;
    let disposed = false;
    const draw = async () => {
      if (decoding || !next) return;
      decoding = true;
      const frame = next;
      next = null;
      try {
        const bitmap = await createImageBitmap(new Blob([decodeBase64(frame.data)], { type: 'image/jpeg' }));
        const canvas = canvasRef.current;
        if (canvas && !disposed) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          setPage((p) => (p.width === frame.width && p.height === frame.height ? p : { width: frame.width, height: frame.height }));
          setHasFrame(true);
        }
        bitmap.close();
      } catch {
        // a corrupt frame; the next one replaces it
      }
      decoding = false;
      if (next) void draw();
    };
    const unsubscribe = socket.subscribeFrames(id, (frame) => {
      next = frame;
      void draw();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [id, live]);

  // Size of the page area in board pixels; the page viewport follows it (debounced)
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let timer: number | undefined;
    const measure = () => {
      const size = { width: body.offsetWidth, height: body.offsetHeight };
      setBox((b) => (b.width === size.width && b.height === size.height ? b : size));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (size.width > 0 && size.height > 0) {
          sendBrowserInput(id, { kind: 'viewport', width: size.width, height: size.height });
        }
      }, 200);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    // The socket may connect after mount; resend the viewport once it is open
    const retry = window.setTimeout(measure, 1200);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(retry);
    };
  }, [id]);

  // Wheel: ctrl/cmd zooms the board (like terminals), plain wheel scrolls the page
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !live) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
        const pinchBoost = Math.abs(e.deltaY) < 20 ? 8 : 1;
        zoomAt(e.clientX, e.clientY, 2 ** (-e.deltaY * unit * pinchBoost));
        return;
      }
      const pt = pagePoint(e.clientX, e.clientY);
      if (!pt) return;
      const lineScale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 600 : 1;
      sendBrowserInput(id, {
        kind: 'mouse',
        action: 'wheel',
        x: pt.x,
        y: pt.y,
        deltaX: e.deltaX * lineScale,
        deltaY: e.deltaY * lineScale,
      });
    };
    body.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => body.removeEventListener('wheel', onWheel, { capture: true });
  });

  const pagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const body = bodyRef.current;
      if (!body || !page.width) return null;
      const local = localPoint(body, clientX, clientY);
      return toPagePoint(local, { width: body.offsetWidth, height: body.offsetHeight }, page);
    },
    [page],
  );

  if (!tile) return null;

  const mouse = (action: 'move' | 'down' | 'up', e: React.PointerEvent) => {
    const pt = pagePoint(e.clientX, e.clientY);
    if (!pt) return;
    sendBrowserInput(id, {
      kind: 'mouse',
      action,
      x: pt.x,
      y: pt.y,
      button: buttonName(e.button),
      clickCount: action === 'move' ? undefined : Math.max(1, e.detail || 1),
    });
  };

  const onKey = (action: 'down' | 'up', e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Dead') return;
    const commandKey = e.ctrlKey || e.metaKey;
    // Let the browser fire a paste event so the clipboard text can be forwarded
    if (commandKey && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    e.stopPropagation();
    sendBrowserInput(id, {
      kind: 'key',
      action,
      key: e.key,
      code: e.code,
      modifiers: modifierBits(e),
      ...(action === 'down' && e.key.length === 1 && !commandKey ? { text: e.key } : {}),
    });
  };

  const navigate = (url: string) => {
    if (!url.trim()) return;
    sendBrowserInput(id, { kind: 'navigate', url: url.trim() });
    setUrlDraft(null);
    keysRef.current?.focus();
  };

  const ringClass = focused
    ? 'ring-2 ring-accent'
    : selected
      ? 'ring-2 ring-accent/70'
      : 'ring-1 ring-line';
  const blank = tile.url === 'about:blank';

  return (
    <>
      <div
        data-testid="browser-node"
        data-browser-id={id}
        className={`aa-node flex h-full w-full flex-col overflow-hidden rounded-xl bg-surface shadow-2xl shadow-black/40 ${ringClass}`}
      >
        <header
          onPointerDown={() => useBoard.getState().select(id)}
          className="aa-drag-handle flex h-10 shrink-0 cursor-grab items-center gap-1 border-b border-line bg-surface-2 px-1.5 select-none
                     active:cursor-grabbing"
        >
          <ChromeButton label="Back" testId="browser-back" onClick={() => sendBrowserInput(id, { kind: 'history', action: 'back' })}>
            <ArrowLeft size={14} />
          </ChromeButton>
          <ChromeButton label="Forward" testId="browser-forward" onClick={() => sendBrowserInput(id, { kind: 'history', action: 'forward' })}>
            <ArrowRight size={14} />
          </ChromeButton>
          <ChromeButton label="Reload" testId="browser-reload" onClick={() => sendBrowserInput(id, { kind: 'history', action: 'reload' })}>
            <RotateCw size={13} />
          </ChromeButton>
          <form
            className="nodrag mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5
                       focus-within:border-line-strong"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(urlDraft ?? tile.url);
            }}
          >
            <Globe size={12} className="shrink-0 text-fg-subtle" />
            <input
              data-testid="browser-url"
              value={urlDraft ?? displayUrl(tile.url)}
              placeholder="Search or type a URL"
              spellCheck={false}
              title={tile.title || tile.url}
              onChange={(e) => setUrlDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => setUrlDraft(null)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  setUrlDraft(null);
                  e.currentTarget.blur();
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg outline-none placeholder:text-fg-subtle"
            />
          </form>
          {tile.title && tile.layout.width >= 720 && (
            <span className="max-w-[28%] truncate text-[12px] text-fg-muted" title={tile.title}>
              {tile.title}
            </span>
          )}
          {tile.linkedConsoleId && (
            <button
              type="button"
              data-testid="browser-driver"
              title={`Driven by ${linkedName ?? 'an agent'}: click to fly to its console`}
              onClick={() => tile.linkedConsoleId && void flyTo(tile.linkedConsoleId)}
              className="nodrag inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold
                         hover:brightness-125"
              style={{ background: agentTint(13), color: AGENT_COLOR }}
            >
              <Link2 size={12} />
              {linkedName ?? 'agent'}
            </button>
          )}
          <ChromeButton label="Close browser" testId="browser-close" danger onClick={() => void api.deleteBrowser(id).catch(() => undefined)}>
            <X size={15} />
          </ChromeButton>
        </header>
        <div
          ref={bodyRef}
          data-testid="browser-body"
          className={`relative min-h-0 flex-1 overflow-hidden bg-white ${live ? 'nodrag nowheel nopan' : ''}`}
          onPointerDown={(e) => {
            useBoard.getState().select(id);
            if (!live) return;
            e.preventDefault();
            keysRef.current?.focus({ preventScroll: true });
            e.currentTarget.setPointerCapture(e.pointerId);
            mouse('down', e);
          }}
          onPointerMove={(e) => live && mouse('move', e)}
          onPointerUp={(e) => live && mouse('up', e)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <canvas
            ref={canvasRef}
            data-testid="browser-canvas"
            className="block h-full w-full"
            style={{ objectFit: 'contain' }}
          />
          <textarea
            ref={keysRef}
            aria-label="Browser keyboard input"
            data-testid="browser-keys"
            className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => onKey('down', e)}
            onKeyUp={(e) => onKey('up', e)}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData('text');
              if (text) sendBrowserInput(id, { kind: 'text', text });
            }}
            onCompositionEnd={(e) => {
              if (e.data) sendBrowserInput(id, { kind: 'text', text: e.data });
              e.currentTarget.value = '';
            }}
            onChange={(e) => {
              e.currentTarget.value = '';
            }}
          />
          {tile.cursor && (
            <AgentCursor tile={tile} box={box} page={page} name={linkedName ?? 'agent'} />
          )}
          {tile.error ? (
            <div className="absolute inset-0 grid place-items-center bg-surface p-6 text-center">
              <p className="max-w-sm text-[13px] text-error">{tile.error}</p>
            </div>
          ) : blank ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-surface text-center">
              <div>
                <Globe size={28} className="mx-auto text-fg-subtle" />
                <p className="mt-3 font-semibold text-fg">Empty browser</p>
                <p className="mt-1 max-w-xs text-[12px] text-fg-muted">
                  Type a URL above, or ask an agent to open a page. Agents use the browser_open tool and you see their pointer here.
                </p>
              </div>
            </div>
          ) : (
            !hasFrame && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-surface text-[12px] text-fg-muted">
                {live ? 'Starting browser...' : 'Zoom in to load the page'}
              </div>
            )
          )}
        </div>
      </div>
      <NodeResizer
        minWidth={MIN_SIZE.width}
        minHeight={MIN_SIZE.height}
        onResizeStart={() => lockLayout(id)}
        onResizeEnd={(_, params) => {
          unlockLayout(id);
          persistBrowserLayout(id, params);
        }}
      />
    </>
  );
}

export const BrowserNode = memo(BrowserNodeImpl);
