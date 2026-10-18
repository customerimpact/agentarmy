import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  useStoreApi,
  type Node,
  type NodeChange,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import type { BrowserTile, ConsoleInfo, Job, Project } from '../../shared/protocol';
import { FRAME_PAD, FRAME_TITLE } from '../lib/arrange';
import {
  MAX_ZOOM,
  MIN_SIZE,
  MIN_ZOOM,
  isHiddenConsole,
  persistItemLayout,
  persistViewport,
  setFlowInstance,
} from '../lib/board-actions';
import { projectColor, useBoardUi } from '../lib/board-ui';
import { getPrefs, usePrefs } from '../lib/prefs';
import { snapMove, snapResize, unionRect, type Rect } from '../lib/snap';
import { STATUS_META } from '../lib/status';
import { consoleList, isLayoutLocked, lockLayout, unlockLayout, useBoard, useClock } from '../lib/store';
import { AlignmentGuides } from './AlignmentGuides';
import { BrowserNode } from './BrowserNode';
import { FlowLines, type FlowLine, type FlowStatus } from './FlowEdge';
import { ProjectFrame } from './ProjectFrame';
import { SelectionBar } from './SelectionBar';
import { TerminalNode } from './TerminalNode';

type BoardNode = Node<Record<string, unknown>>;

const nodeTypes: NodeTypes = { terminal: TerminalNode, browser: BrowserNode, frame: ProjectFrame };

const FRAME_PREFIX = 'frame:';
// Flow lines are drawn by FlowLines, not as React Flow edges (those need <Handle>s)
const NO_EDGES: never[] = [];
// Must be a stable object: React Flow copies this prop into its store whenever its identity
// changes, which replaced the options of a pending flow.fitView({ nodes }) call (zoom-out bug)
const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.1 };
const ARRANGE_TRANSITION =
  'transform 260ms cubic-bezier(0.22, 1, 0.36, 1), width 260ms cubic-bezier(0.22, 1, 0.36, 1), height 260ms cubic-bezier(0.22, 1, 0.36, 1)';
// Lines stay on the board this long after their last job update
const JOB_LINE_TTL = 30 * 60_000;

const frameId = (projectId: string) => `${FRAME_PREFIX}${projectId}`;
const isFrame = (node: { type?: string }) => node.type === 'frame';

function rectOfNode(node: BoardNode): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? node.measured?.width ?? 0,
    height: node.height ?? node.measured?.height ?? 0,
  };
}

function sameStyle(a: BoardNode['style'], b: BoardNode['style']): boolean {
  return (a?.transition ?? '') === (b?.transition ?? '');
}

// Frames are derived from their members' current node rects (never persisted)
function withFrames(nodes: BoardNode[], projects: Record<string, Project>, animating: boolean): BoardNode[] {
  const items = nodes.filter((n) => !isFrame(n));
  const prevFrames = new Map(nodes.filter(isFrame).map((n) => [n.id, n]));
  const byId = new Map(items.map((n) => [n.id, n]));
  const frames: BoardNode[] = [];
  const open = Object.values(projects)
    .filter((p) => p.open)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const p of open) {
    const box = unionRect(
      p.consoleIds.map((id) => byId.get(id)).filter((n): n is BoardNode => !!n).map(rectOfNode),
    );
    if (!box) continue;
    const id = frameId(p.id);
    const position = { x: box.x - FRAME_PAD, y: box.y - FRAME_PAD - FRAME_TITLE };
    const width = box.width + FRAME_PAD * 2;
    const height = box.height + FRAME_PAD * 2 + FRAME_TITLE;
    const style = { pointerEvents: 'none' as const, ...(animating ? { transition: ARRANGE_TRANSITION } : {}) };
    const prev = prevFrames.get(id);
    if (
      prev &&
      prev.position.x === position.x &&
      prev.position.y === position.y &&
      prev.width === width &&
      prev.height === height &&
      sameStyle(prev.style, style)
    ) {
      frames.push(prev);
      continue;
    }
    frames.push({
      ...prev,
      id,
      type: 'frame',
      position,
      width,
      height,
      zIndex: -2, // behind the flow lines layer (-1) and the terminals (0)
      selectable: false,
      focusable: false,
      dragHandle: '.aa-frame-handle',
      style,
      data: { projectId: p.id },
    });
  }
  // Frames first so they render behind everything
  return [...frames, ...items];
}

interface BuildInput {
  consoles: Record<string, ConsoleInfo>;
  browsers: Record<string, BrowserTile>;
  projects: Record<string, Project>;
  selectedIds: string[];
  selectedId: string | null;
  animating: boolean;
}

function buildNodes(prev: BoardNode[], input: BuildInput): BoardNode[] {
  const { consoles, browsers, projects, selectedIds, selectedId, animating } = input;
  const prevById = new Map(prev.map((n) => [n.id, n]));
  const selected = new Set(selectedIds);
  const style = animating ? { transition: ARRANGE_TRANSITION } : undefined;

  const make = (id: string, type: 'terminal' | 'browser', layout: Rect): BoardNode => {
    const existing = prevById.get(id);
    const zIndex = id === selectedId ? 10 : 0;
    const isSelected = selected.has(id);
    if (existing && isLayoutLocked(id)) {
      return existing.zIndex === zIndex && !!existing.selected === isSelected
        ? existing
        : { ...existing, zIndex, selected: isSelected };
    }
    const { x, y, width, height } = layout;
    if (
      existing &&
      existing.position.x === x &&
      existing.position.y === y &&
      existing.width === width &&
      existing.height === height &&
      existing.zIndex === zIndex &&
      !!existing.selected === isSelected &&
      sameStyle(existing.style, style)
    ) {
      return existing;
    }
    return {
      ...existing,
      id,
      type,
      dragHandle: '.aa-drag-handle',
      position: { x, y },
      width,
      height,
      zIndex,
      selected: isSelected,
      style,
      data: existing?.data ?? {},
    };
  };

  const items: BoardNode[] = [];
  for (const c of consoleList(consoles)) {
    if (!isHiddenConsole(c, projects)) items.push(make(c.id, 'terminal', c.layout));
  }
  for (const b of Object.values(browsers)) items.push(make(b.id, 'browser', b.layout));
  return withFrames([...prev.filter(isFrame), ...items], projects, animating);
}

// ---------- flow lines from jobs ----------

function buildEdges(
  jobs: Record<string, Job>,
  consoles: Record<string, ConsoleInfo>,
  projects: Record<string, Project>,
  now: number,
): FlowLine[] {
  const visible = (id: string) => !!consoles[id] && !isHiddenConsole(consoles[id], projects);
  const pairs = new Map<string, Job[]>();
  for (const job of Object.values(jobs)) {
    if (!job.fromId || job.fromId === job.toId) continue;
    const open = job.status === 'sent' || job.status === 'working';
    if (!open && now - job.updatedAt > JOB_LINE_TTL) continue;
    if (!visible(job.fromId) || !visible(job.toId)) continue;
    const key = `${job.fromId}\u0000${job.toId}`;
    pairs.set(key, [...(pairs.get(key) ?? []), job]);
  }
  const edges: FlowLine[] = [];
  const sending = new Set<string>();
  for (const list of pairs.values()) {
    list.sort((a, b) => b.createdAt - a.createdAt);
    const { fromId, toId } = list[0];
    sending.add(fromId!);
    const status: FlowStatus = list.some((j) => j.status === 'sent' || j.status === 'working')
      ? 'active'
      : list[0].status === 'failed'
        ? 'failed'
        : 'done';
    edges.push({ id: `flow:${fromId}:${toId}`, source: fromId!, target: toId, status, jobs: list });
  }
  // Orchestrators without jobs yet: faint standby curves to the projects working in their folder
  for (const c of Object.values(consoles)) {
    if (c.role?.toLowerCase() !== 'orchestrator' || !visible(c.id) || sending.has(c.id)) continue;
    for (const p of Object.values(projects)) {
      if (!p.open || p.id === c.projectId || p.consoleIds.includes(c.id)) continue;
      const members = p.consoleIds.filter(visible);
      if (!members.some((id) => consoles[id].cwd === c.cwd)) continue;
      edges.push({
        id: `flow:${c.id}:${frameId(p.id)}`,
        source: c.id,
        target: frameId(p.id),
        status: 'standby',
        jobs: [],
      });
    }
  }
  return edges;
}

// Keep edge objects stable when nothing about them changed, so lines don't re-render per status tick
function edgeSignature(data: FlowLine): string {
  return `${data.status}|${data.jobs.map((j) => `${j.id}:${j.status}:${j.updatedAt}`).join(',')}`;
}

// ---------- drag / resize sessions ----------

interface DragSession {
  anchor: string; // a dragged node id whose start position defines the delta
  start: Map<string, { x: number; y: number }>; // dragged nodes (incl. frames) at drag start
  moving: Map<string, { x: number; y: number }>; // consoles/tiles that actually move
  box: Rect; // union of the dragged rects at drag start
  others: Rect[];
  delta: { x: number; y: number };
  free: boolean; // Alt held: no snapping
}

interface ResizeSession {
  start: Rect;
  last: Rect;
  others: Rect[];
}

export function Board() {
  const consoles = useBoard((s) => s.consoles);
  const browsers = useBoard((s) => s.browsers);
  const projects = useBoard((s) => s.projects);
  const jobs = useBoard((s) => s.jobs);
  const selectedIds = useBoard((s) => s.selectedIds);
  const selectedId = useBoard((s) => s.selectedId);
  const animating = useBoardUi((s) => s.animating);
  const showMinimap = usePrefs((s) => s.prefs.showMinimap);
  // Minute resolution is enough for expiring old lines
  const minute = useClock((s) => Math.floor(s.now / 60_000));
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const flow = useReactFlow();
  const storeApi = useStoreApi();
  const drag = useRef<DragSession | null>(null);
  const resizes = useRef(new Map<string, ResizeSession>());
  const edgeCache = useRef(new Map<string, { sig: string; edge: FlowLine }>());
  // Captured once: after mount the canvas owns the viewport and only reports it back
  const initialViewport = useRef(useBoard.getState().viewport);

  useEffect(() => {
    setFlowInstance(flow);
    return () => setFlowInstance(null);
  }, [flow]);

  // Mirror the store into React Flow nodes, keeping node objects stable when nothing changed
  useEffect(() => {
    setNodes((prev) =>
      buildNodes(prev, { consoles, browsers, projects, selectedIds, selectedId, animating }),
    );
  }, [consoles, browsers, projects, selectedIds, selectedId, animating]);

  const edges = useMemo(() => {
    const next = buildEdges(jobs, consoles, projects, Date.now());
    const cache = edgeCache.current;
    const out = next.map((edge) => {
      const sig = edgeSignature(edge);
      const hit = cache.get(edge.id);
      if (hit && hit.sig === sig) return hit.edge;
      cache.set(edge.id, { sig, edge });
      return edge;
    });
    const live = new Set(out.map((e) => e.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    return out;
  }, [jobs, consoles, projects, minute]);

  // Geometry for the flow lines: every node rect, plus where their labels should not go
  const lineSpace = useMemo(() => {
    const rects = new Map<string, Rect>();
    const obstacles: Rect[] = [];
    if (!edges.length) return { rects, obstacles };
    for (const n of nodes) {
      const r = rectOfNode(n);
      rects.set(n.id, r);
      // Frame titles grow upward when zoomed out (see ProjectFrame), so keep a tall margin
      obstacles.push(isFrame(n) ? { ...r, y: r.y - FRAME_TITLE * 1.5, height: FRAME_TITLE * 2.5 } : r);
    }
    return { rects, obstacles };
  }, [edges.length, nodes]);

  const zoom = () => storeApi.getState().transform[2];

  // Snap targets: everything visible that is not moving. Frames only matter when a frame moves.
  const snapTargets = useCallback((exclude: Set<string>, includeFrames: boolean): Rect[] => {
    return nodesRef.current
      .filter((n) => !exclude.has(n.id) && (includeFrames ? true : !isFrame(n)))
      .map(rectOfNode)
      .filter((r) => r.width > 0 && r.height > 0);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      const board = useBoard.getState();
      const { prefs, setGuides } = useBoardUi.getState();
      const rest: NodeChange<BoardNode>[] = [];
      let selection: Set<string> | null = null;
      let dragChange: { id: string; position: { x: number; y: number }; dragging: boolean } | null = null;

      for (const change of changes) {
        if (change.type === 'select') {
          if (change.id.startsWith(FRAME_PREFIX)) continue;
          selection ??= new Set(board.selectedIds);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
          continue;
        }
        if (change.type === 'position' && change.dragging !== undefined && change.position) {
          if (drag.current?.start.has(change.id))
            dragChange ??= { id: change.id, position: change.position, dragging: change.dragging };
          else rest.push(change);
          continue;
        }
        if (change.type === 'dimensions' && change.resizing !== undefined && change.dimensions) {
          const node = nodesRef.current.find((n) => n.id === change.id);
          if (!node || isFrame(node)) {
            rest.push(change);
            continue;
          }
          let session = resizes.current.get(change.id);
          if (!session) {
            const startRect = rectOfNode(node);
            session = {
              start: startRect,
              last: startRect,
              others: snapTargets(new Set([node.id]), false),
            };
            resizes.current.set(change.id, session);
          }
          const posChange = changes.find(
            (c): c is Extract<NodeChange<BoardNode>, { type: 'position' }> =>
              c.type === 'position' && c.id === change.id && c.dragging === undefined,
          );
          const raw: Rect = {
            x: posChange?.position?.x ?? node.position.x,
            y: posChange?.position?.y ?? node.position.y,
            width: change.dimensions.width,
            height: change.dimensions.height,
          };
          if (!change.resizing) {
            // End of the resize: persist the snapped rect (after the node's own raw save)
            const final = session.last;
            resizes.current.delete(change.id);
            setGuides([]);
            rest.push({ ...change, dimensions: { width: final.width, height: final.height } });
            persistItemLayout(change.id, final);
            continue;
          }
          const fromLeft = Math.abs(raw.x - session.start.x) > 0.5;
          const fromTop = Math.abs(raw.y - session.start.y) > 0.5;
          const result = prefs.snap
            ? snapResize(raw, session.others, {
                zoom: zoom(),
                grid: getPrefs().gridSize,
                minWidth: MIN_SIZE.width,
                minHeight: MIN_SIZE.height,
                fromLeft,
                fromTop,
              })
            : { rect: raw, guides: [] };
          session.last = result.rect;
          setGuides(result.guides);
          rest.push({ ...change, dimensions: { width: result.rect.width, height: result.rect.height } });
          if (posChange) posChange.position = { x: result.rect.x, y: result.rect.y };
          continue;
        }
        rest.push(change);
      }

      if (selection) board.setSelectedIds([...selection]);

      const session = drag.current;
      if (dragChange && session) {
        const startPos = session.start.get(dragChange.id)!;
        let delta = { x: dragChange.position.x - startPos.x, y: dragChange.position.y - startPos.y };
        if (prefs.snap && !session.free) {
          const moved = { ...session.box, x: session.box.x + delta.x, y: session.box.y + delta.y };
          const snapped = snapMove(moved, session.others, { zoom: zoom(), grid: getPrefs().gridSize });
          delta = { x: snapped.x - session.box.x, y: snapped.y - session.box.y };
          setGuides(snapped.guides);
        } else {
          setGuides([]);
        }
        session.delta = delta;
      }

      if (!rest.length && !dragChange) return;
      setNodes((prev) => {
        let next = rest.length ? applyNodeChanges(rest, prev) : prev;
        if (dragChange && session) {
          const { delta } = session;
          next = next.map((n) => {
            const start = session.moving.get(n.id);
            if (!start) return n;
            return { ...n, position: { x: start.x + delta.x, y: start.y + delta.y } };
          });
          next = withFrames(next, useBoard.getState().projects, false);
        } else if (rest.some((c) => c.type === 'dimensions' || c.type === 'position')) {
          next = withFrames(next, useBoard.getState().projects, useBoardUi.getState().animating);
        }
        return next;
      });
    },
    [snapTargets, storeApi],
  );

  const onNodeDragStart = useCallback(
    (event: MouseEvent | TouchEvent, node: BoardNode, dragged: BoardNode[]) => {
      const board = useBoard.getState();
      const current = new Map(nodesRef.current.map((n) => [n.id, n]));
      const list = dragged.length ? dragged : [node];
      const start = new Map<string, { x: number; y: number }>();
      const moving = new Map<string, { x: number; y: number }>();
      const exclude = new Set<string>();
      let movesFrame = false;
      for (const n of list) {
        const live = current.get(n.id) ?? n;
        start.set(n.id, { ...live.position });
        exclude.add(n.id);
        if (isFrame(n)) {
          movesFrame = true;
          const project = board.projects[(n.data as { projectId: string }).projectId];
          for (const id of project?.consoleIds ?? []) {
            const member = current.get(id);
            if (member) moving.set(id, { ...member.position });
          }
        } else {
          moving.set(n.id, { ...live.position });
        }
      }
      for (const id of moving.keys()) exclude.add(id);
      // Frames around anything that moves would only pull it back toward itself
      for (const p of Object.values(board.projects)) {
        if (p.consoleIds.some((id) => moving.has(id))) exclude.add(frameId(p.id));
      }
      const box = unionRect(list.map((n) => rectOfNode(current.get(n.id) ?? n)))!;
      drag.current = {
        anchor: node.id,
        start,
        moving,
        box,
        others: snapTargets(exclude, movesFrame),
        delta: { x: 0, y: 0 },
        free: event.altKey,
      };
      for (const id of moving.keys()) lockLayout(id);
      // Dragging something outside the selection makes it the selection
      if (!isFrame(node) && !board.selectedIds.includes(node.id)) {
        board.setSelectedIds([node.id]);
        if (board.consoles[node.id]) board.select(node.id);
      }
    },
    [snapTargets],
  );

  const onNodeDrag = useCallback((event: MouseEvent | TouchEvent) => {
    if (drag.current) drag.current.free = event.altKey;
  }, []);

  const onNodeDragStop = useCallback(() => {
    const session = drag.current;
    drag.current = null;
    useBoardUi.getState().setGuides([]);
    if (!session) return;
    for (const [id, start] of session.moving) {
      unlockLayout(id);
      persistItemLayout(id, { x: start.x + session.delta.x, y: start.y + session.delta.y });
    }
  }, []);

  const onNodeClick = useCallback((event: ReactMouseEvent, node: BoardNode) => {
    const board = useBoard.getState();
    const target = event.target as Element;
    if (isFrame(node)) {
      if (target.closest?.('button, input')) return;
      // Clicking a frame title selects its consoles
      const project = board.projects[(node.data as { projectId: string }).projectId];
      if (!project) return;
      const members = project.consoleIds.filter((id) => board.consoles[id]);
      board.setSelectedIds(
        event.ctrlKey || event.metaKey ? [...new Set([...board.selectedIds, ...members])] : members,
      );
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      // React Flow already toggled it through the multi-selection key; keep the primary in sync
      if (board.consoles[node.id] && !board.selectedIds.includes(node.id)) board.select(node.id);
      return;
    }
    if (event.shiftKey) return;
    board.setSelectedIds([node.id]);
    if (board.consoles[node.id]) board.select(node.id);
  }, []);

  const onSelectionEnd = useCallback(() => {
    // React Flow draws a draggable rectangle over a box selection; it would swallow terminal clicks
    window.setTimeout(() => storeApi.setState({ nodesSelectionActive: false }), 0);
  }, [storeApi]);

  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => persistViewport(viewport), []);

  return (
    <ReactFlow<BoardNode>
      data-testid="board"
      nodes={nodes}
      edges={NO_EDGES}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onSelectionEnd={onSelectionEnd}
      onPaneClick={() => {
        const board = useBoard.getState();
        board.select(null);
        board.setSelectedIds([]);
        (document.activeElement as HTMLElement | null)?.blur?.();
      }}
      onMoveEnd={onMoveEnd}
      defaultViewport={initialViewport.current ?? { x: 0, y: 0, zoom: 1 }}
      fitView={!initialViewport.current}
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      colorMode="system"
      elementsSelectable
      selectNodesOnDrag={false}
      selectionKeyCode="Shift"
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode={['Control', 'Meta']}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      disableKeyboardA11y
      deleteKeyCode={null}
      zoomOnDoubleClick={false}
      // MIT-licensed, so the corner badge is optional; it sat under the command bar
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="var(--aa-dots)" />
      <FlowLines lines={edges} rects={lineSpace.rects} obstacles={lineSpace.obstacles} />
      <AlignmentGuides />
      <Panel position="top-center">
        <SelectionBar />
      </Panel>
      {showMinimap && (
        <MiniMap<BoardNode>
          pannable
          zoomable
          nodeBorderRadius={6}
          nodeColor={(node) => {
            if (node.type === 'frame') return 'transparent';
            if (node.type === 'browser') return 'var(--aa-line-strong)';
            const status = consoles[node.id]?.status;
            return status ? STATUS_META[status].cssVar : 'var(--aa-idle)';
          }}
          nodeStrokeColor={(node) =>
            node.type === 'frame'
              ? projectColor(projects[(node.data as { projectId: string }).projectId]?.color)
              : 'transparent'
          }
          nodeStrokeWidth={6}
        />
      )}
      <Controls position="top-left" showInteractive={false} />
    </ReactFlow>
  );
}
