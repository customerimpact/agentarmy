import { useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Terminal } from '@xterm/xterm';
import { Eye, LoaderCircle, MousePointer2 } from 'lucide-react';
import type { ShareConsole, ShareCursor } from '../../shared/share-crypto';
import type { ConsoleStatus } from '../../shared/protocol';
import { FRAME_PADDING, FRAME_TITLE_HEIGHT } from '../../shared/templates';
import { BrandIcon, type BrandAgent } from '../components/brand-icons';
import { STATUS_META, projectColorVar } from '../lib/status';
import { terminalTheme } from '../lib/theme';
import { shareId, takeKey, useViewer, viewerLink } from './viewer-link';

const BRANDS = new Set(['claude', 'codex', 'gemini', 'opencode', 'grok']);

function Screen({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center">{<div className="max-w-sm space-y-3">{children}</div>}</div>;
}

export function ViewerApp() {
  const phase = useViewer((s) => s.phase);
  const message = useViewer((s) => s.message);
  const owner = useViewer((s) => s.owner);

  useEffect(() => {
    const key = takeKey();
    if (!shareId || !key) {
      useViewer.getState().set({ phase: 'no-key' });
      return;
    }
    void (async () => {
      const info = await fetch(`/api/shares/info?id=${shareId}`).then((r) => r.json().then((d) => ({ ok: r.ok, d })));
      if (!info.ok) return useViewer.getState().set({ phase: 'expired', message: info.d.error });
      useViewer.getState().set({ title: info.d.title, owner: info.d.owner });
      document.title = `${info.d.title} · shared by ${info.d.owner} · GridHive`;
      const session = await fetch('/api/auth/session', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ user: null }));
      if (!session.user) return useViewer.getState().set({ phase: 'signin' });
      await viewerLink.start(key);
    })().catch((e: Error) => useViewer.getState().set({ phase: 'error', message: e.message }));
  }, []);

  if (phase === 'live') {
    return (
      <ReactFlowProvider>
        <LiveBoard />
      </ReactFlowProvider>
    );
  }
  const next = encodeURIComponent(`/s/${shareId}`);
  return (
    <Screen>
      <img src="/assets/icon.svg" alt="" className="mx-auto size-12" />
      {phase === 'signin' && (
        <>
          <h1 className="text-[20px] font-semibold text-fg">{owner ? `${owner} shared a board with you` : 'A shared GridHive board'}</h1>
          <p className="text-fg-muted">Sign in to watch it live. You only need a free GridHive account; nothing to install.</p>
          <div className="grid gap-2 pt-2">
            <a className="aa-btn-primary rounded-xl py-2.5 font-semibold" href={`/api/auth/signin/github?next=${next}`}>Continue with GitHub</a>
            <a className="rounded-xl border border-line-strong py-2.5 font-semibold text-fg" href={`/api/auth/signin/google?next=${next}`}>Continue with Google</a>
          </div>
        </>
      )}
      {(phase === 'loading' || phase === 'connecting') && (
        <p className="inline-flex items-center gap-2 text-fg-muted">
          <LoaderCircle size={16} className="animate-spin" /> Connecting to the board…
        </p>
      )}
      {phase === 'waiting-owner' && (
        <p className="text-fg-muted">Waiting for {owner || 'the owner'}'s computer. It needs to be on with GridHive running; this page connects by itself.</p>
      )}
      {phase === 'no-key' && <p className="text-fg-muted">This link is incomplete. Ask for the full share link (it ends with "#k=…").</p>}
      {(phase === 'expired' || phase === 'ended' || phase === 'error') && <p className="text-fg-muted">{message || 'This share is no longer available.'}</p>}
    </Screen>
  );
}

type ConsoleFlowNode = Node<{ c: ShareConsole }, 'console'>;
type FrameFlowNode = Node<{ name: string; color?: string; count: number; working: number }, 'frame'>;

function ConsoleNode({ data }: NodeProps<ConsoleFlowNode>) {
  const c = data.c;
  const meta = STATUS_META[c.status as ConsoleStatus] ?? STATUS_META.idle;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-line bg-surface" data-testid="viewer-console">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-2.5 text-[12px]">
        {c.agent && BRANDS.has(c.agent) ? <BrandIcon agent={c.agent as BrandAgent} size={13} /> : <BrandIcon agent="claude" size={13} />}
        <span className="font-semibold text-fg">{c.name}</span>
        {c.role && <span className="text-fg-subtle">{c.role}</span>}
        {c.model && <span className="font-mono text-[11px] text-fg-subtle">{c.model}</span>}
        <span className={`ml-auto rounded-full px-2 py-[1px] text-[11px] ${meta.pill}`}>{meta.label}</span>
      </div>
      <ViewerTerminal id={c.id} />
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-2.5 font-mono text-[10.5px] text-fg-subtle">
        <span>{c.folder}</span>
        {c.activity && <span className="truncate">{c.activity}</span>}
      </div>
    </div>
  );
}

function ViewerTerminal({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace', fontSize: 11, disableStdin: true, cursorBlink: false, theme: terminalTheme('midnight'), scrollback: 2000 });
    term.open(host.current);
    const off = viewerLink.attach(id, (kind, data, size) => {
      if (kind === 'replay') {
        term.reset();
        if (size) term.resize(size.cols, Math.min(size.rows, 60));
      }
      term.write(data);
    });
    return () => {
      off();
      term.dispose();
    };
  }, [id]);
  return <div className="nodrag nowheel min-h-0 flex-1 overflow-hidden bg-canvas p-1" ref={host} />;
}

function FrameNode({ data }: NodeProps<FrameFlowNode>) {
  const color = projectColorVar(data.color);
  return (
    <div className="h-full w-full rounded-xl border" style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 5%, transparent)` }}>
      <div className="flex h-9 items-center gap-2 px-3 font-mono text-[11px] tracking-wider uppercase" style={{ color }}>
        <span className="size-2 rounded-full" style={{ background: color }} />
        {data.name}
        <span className="text-fg-subtle normal-case">
          {data.working}/{data.count} working
        </span>
      </div>
    </div>
  );
}

const nodeTypes = { console: ConsoleNode, frame: FrameNode };

function LiveBoard() {
  const consoles = useViewer((s) => s.consoles);
  const projects = useViewer((s) => s.projects);
  const title = useViewer((s) => s.title);
  const owner = useViewer((s) => s.owner);
  const flow = useReactFlow();
  const fitted = useRef(false);

  const nodes = useMemo(() => {
    const list: Node[] = [];
    for (const p of Object.values(projects)) {
      const members = p.consoleIds.map((id) => consoles[id]).filter(Boolean);
      if (!members.length) continue;
      const minX = Math.min(...members.map((c) => c.layout.x)) - FRAME_PADDING;
      const minY = Math.min(...members.map((c) => c.layout.y)) - FRAME_PADDING - FRAME_TITLE_HEIGHT;
      const maxX = Math.max(...members.map((c) => c.layout.x + c.layout.width)) + FRAME_PADDING;
      const maxY = Math.max(...members.map((c) => c.layout.y + c.layout.height)) + FRAME_PADDING;
      list.push({
        id: `frame-${p.id}`,
        type: 'frame',
        position: { x: minX, y: minY },
        data: { name: p.name, color: p.color, count: members.length, working: members.filter((c) => c.status === 'working').length },
        style: { width: maxX - minX, height: maxY - minY },
        draggable: false,
        selectable: false,
        zIndex: -1,
      });
    }
    for (const c of Object.values(consoles)) {
      list.push({ id: c.id, type: 'console', position: { x: c.layout.x, y: c.layout.y }, data: { c }, style: { width: c.layout.width, height: c.layout.height }, draggable: false });
    }
    return list;
  }, [consoles, projects]);

  useEffect(() => {
    if (fitted.current || nodes.length === 0) return;
    fitted.current = true;
    window.setTimeout(() => void flow.fitView({ padding: 0.1, maxZoom: 1 }), 60);
  }, [nodes.length]);

  // Our pointer, at most ~16 times a second, with our viewport so others can follow us
  const last = useRef(0);
  const onMove = (event: React.MouseEvent) => {
    const now = performance.now();
    if (now - last.current < 60) return;
    last.current = now;
    const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const vp = flow.getViewport();
    void viewerLink.send({ t: 'cursor', c: { x: p.x, y: p.y, vx: vp.x, vy: vp.y, vz: vp.zoom } });
  };

  return (
    <div className="flex h-full flex-col" onMouseMove={onMove} onMouseLeave={() => void viewerLink.send({ t: 'cursor', c: null })}>
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <img src="/assets/icon.svg" alt="" className="size-6" />
        <span className="truncate text-[13px] font-semibold text-fg">{title}</span>
        <span className="text-[12px] text-fg-subtle">shared by {owner}</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-[1px] text-[11px] text-fg-muted">
          <Eye size={11} /> View only
        </span>
        <Peers />
      </header>
      <div className="relative min-h-0 flex-1">
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} minZoom={0.1} maxZoom={2} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--aa-line)" />
        </ReactFlow>
        <Cursors />
      </div>
    </div>
  );
}

function Peers() {
  const peers = useViewer((s) => s.peers);
  const you = useViewer((s) => s.you);
  const following = useViewer((s) => s.following);
  return (
    <div className="ml-auto flex items-center gap-1.5" data-testid="viewer-peers">
      {following && <span className="mr-1 text-[11.5px] text-fg-muted">Following {peers.find((p) => p.dev === following)?.name}</span>}
      {peers.map((p) => (
        <button
          key={p.dev}
          type="button"
          title={p.dev === you?.dev ? `${p.name} (you)` : `Follow ${p.name}`}
          disabled={p.dev === you?.dev}
          onClick={() => useViewer.getState().set({ following: following === p.dev ? null : p.dev })}
          className="grid size-7 place-items-center rounded-full text-[11px] font-bold text-black ring-2 transition"
          style={{ background: p.color, ['--tw-ring-color' as string]: following === p.dev ? '#fff' : 'transparent' }}
        >
          {p.name.charAt(0).toUpperCase()}
        </button>
      ))}
    </div>
  );
}

// Everyone else's pointer, in board coordinates; following someone moves our view with theirs
function Cursors() {
  const cursors = useViewer((s) => s.cursors);
  const peers = useViewer((s) => s.peers);
  const following = useViewer((s) => s.following);
  const vp = useViewport();
  const flow = useReactFlow();
  const followed: ShareCursor | undefined = following ? cursors[following] : undefined;
  useEffect(() => {
    if (followed?.vz) void flow.setViewport({ x: followed.vx!, y: followed.vy!, zoom: followed.vz }, { duration: 120 });
  }, [followed?.vx, followed?.vy, followed?.vz]);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {Object.entries(cursors).map(([dev, c]) => {
        const peer = peers.find((p) => p.dev === dev);
        if (!peer) return null;
        return (
          <div key={dev} className="absolute top-0 left-0 transition-transform duration-75" style={{ transform: `translate(${c.x * vp.zoom + vp.x}px, ${c.y * vp.zoom + vp.y}px)` }} data-testid="viewer-cursor">
            <MousePointer2 size={18} fill={peer.color} color="#000" strokeWidth={1.2} />
            <span className="ml-3 rounded-md px-1.5 py-[1px] text-[11px] font-semibold whitespace-nowrap text-black" style={{ background: peer.color }}>
              {peer.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
