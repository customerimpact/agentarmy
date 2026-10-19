import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ViewportPortal, useNodes, useReactFlow, useStore } from '@xyflow/react';
import { MAX_POINTS, type Shape, type ShapeAnchor } from '../../../shared/drawings';
import {
  anchorAt,
  boundsOfPoints,
  boxFromPoints,
  HANDLES,
  handlePoint,
  isLinkShape,
  linkEnds,
  moveShape,
  NO_RECTS,
  resizeBox,
  resizeShape,
  setLinkEnd,
  shapeAt,
  shapeBounds,
  simplifyStroke,
  snapAngle,
  sortByZ,
  TEXT_LINE,
  TEXT_PX,
  unionBoxes,
  type Box,
  type Handle,
  type NodeRect,
  type Pt,
  type RectOf,
} from '../../lib/drawing/geometry';
import { fitImage, imageFromTransfer, imageSize, uploadImage } from '../../lib/drawing/images';
import {
  activeWorkspaceId,
  loadDrawings,
  newShapeId,
  nextZ,
  useDrawings,
  type DrawTool,
} from '../../lib/drawing/store';
import { useDrawVoicePrefs } from '../../lib/draw-voice-prefs';
import { useItems, workspaceOf } from '../../lib/items';
import { useBoard } from '../../lib/store';
import { DrawRail } from './DrawRail';
import { colorVar, ShapeSvg, TEXT_FONT } from './ShapeSvg';

// The drawing / annotation layer of the board. Shapes live in flow coordinates inside a
// ViewportPortal so they pan and zoom with the consoles. Outside draw mode they sit under the
// consoles (z -1: above project frames, level with flow lines) and terminals stay fully
// interactive; in draw mode the layer comes to the front so you can see and edit what you draw.

const LAYER_Z_BEHIND = -1;
const LAYER_Z_FRONT = 1500; // above consoles (selected nodes go up to ~1010)
const HANDLES_Z = 2100;
const EDITOR_Z = 2200;
const OVERLAY_CLASS = 'aa-draw-overlay';
const TOOL_KEYS: Record<string, DrawTool> = {
  v: 'select', '1': 'select',
  p: 'pen', '2': 'pen',
  l: 'line', '3': 'line',
  a: 'arrow', '4': 'arrow',
  r: 'rect', '5': 'rect',
  o: 'ellipse', '6': 'ellipse',
  t: 'text', '7': 'text',
  e: 'eraser', '8': 'eraser',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function measureText(text: string, size: number): { w: number; h: number } {
  const lines = text.split('\n');
  measureCtx ??= document.createElement('canvas').getContext('2d');
  let w = 0;
  for (const line of lines) {
    let lw = line.length * size * 0.56;
    if (measureCtx) {
      measureCtx.font = `500 ${size}px ${TEXT_FONT}`;
      lw = measureCtx.measureText(line).width;
    }
    w = Math.max(w, lw);
  }
  return { w: Math.ceil(w) + 4, h: Math.ceil(lines.length * size * TEXT_LINE) };
}

interface TextDraft {
  id: string;
  x: number;
  y: number;
  existing: Shape | null;
}

interface Gesture {
  pointerId: number;
  onMove: (p: Pt, e: PointerEvent) => void;
  onUp: (p: Pt, e: PointerEvent) => void;
  onCancel: () => void;
}

export function DrawingLayer() {
  const flow = useReactFlow();
  const nodes = useNodes();
  const zoom = useStore((s) => s.transform[2]);
  const domNode = useStore((s) => s.domNode);
  const shapes = useDrawings((s) => s.shapes);
  const selected = useDrawings((s) => s.selected);
  const active = useDrawings((s) => s.active);
  const tool = useDrawings((s) => s.tool);
  const editingTextId = useDrawings((s) => s.editingTextId);
  const show = useDrawVoicePrefs((s) => s.prefs.showDrawings);
  const workspaceId = useItems((s) => s.activeWorkspaceId);
  const workspaces = useItems((s) => s.workspaces);
  const socketState = useBoard((s) => s.socketState);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [erasing, setErasing] = useState<ReadonlySet<string>>(new Set());
  const [snapTarget, setSnapTarget] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const spaceHeld = useRef(false);
  const minZoom = useStore((s) => s.minZoom);
  const maxZoom = useStore((s) => s.maxZoom);
  const zoomLimits = useRef({ min: minZoom, max: maxZoom });
  zoomLimits.current = { min: minZoom, max: maxZoom };

  // Node rects for anchoring arrows: consoles, browser tiles, items (project frames are derived, skip)
  const rects = useMemo(() => {
    const map = new Map<string, NodeRect>();
    const list: { id: string; rect: NodeRect; z: number; i: number }[] = [];
    nodes.forEach((n, i) => {
      if (n.id.startsWith('frame:') || n.hidden) return;
      const rect = {
        x: n.position.x,
        y: n.position.y,
        width: n.width ?? n.measured?.width ?? 0,
        height: n.height ?? n.measured?.height ?? 0,
      };
      map.set(n.id, rect);
      list.push({ id: n.id, rect, z: n.zIndex ?? 0, i });
    });
    list.sort((a, b) => b.z - a.z || b.i - a.i); // topmost first
    return { map, list };
  }, [nodes]);
  const rectOf = useCallback<RectOf>((id) => rects.map.get(id), [rects]);
  const live = useRef({ rects, rectOf, zoom });
  live.current = { rects, rectOf, zoom };

  // Shapes of a deleted workspace show on the first one (like consoles, see items.ts)
  const onWorkspace = useCallback(
    (s: Shape) => {
      const ws = workspaceOf(s);
      return ws === workspaceId || (!workspaces.some((w) => w.id === ws) && workspaceId === workspaces[0]?.id);
    },
    [workspaceId, workspaces],
  );
  const visible = useMemo(() => sortByZ(Object.values(shapes).filter(onWorkspace)), [shapes, onWorkspace]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Initial load + reload after a reconnect (other tabs may have drawn meanwhile)
  useEffect(() => {
    if (socketState === 'open' || socketState === 'connecting') void loadDrawings();
  }, [socketState]);

  // Leaving the workspace or hiding drawings ends any edit
  useEffect(() => {
    useDrawings.getState().select([]);
    setTextDraft(null);
  }, [workspaceId, show]);

  const toFlow = useCallback((e: { clientX: number; clientY: number }): Pt => flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), [flow]);

  const startGesture = useCallback(
    (e: React.PointerEvent | PointerEvent, g: Omit<Gesture, 'pointerId'>) => {
      gesture.current?.onCancel();
      const pointerId = e.pointerId;
      const session: Gesture = { ...g, pointerId };
      gesture.current = session;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || gesture.current !== session) return;
        session.onMove(toFlow(ev), ev);
      };
      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
        if (gesture.current !== session) return;
        gesture.current = null;
        if (ev.type === 'pointercancel') session.onCancel();
        else session.onUp(toFlow(ev), ev);
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    },
    [toFlow],
  );

  const baseShape = useCallback((kind: Shape['kind'], box: Box, extra: Partial<Shape> = {}): Shape => {
    const now = Date.now();
    return {
      id: newShapeId(),
      kind,
      workspaceId: activeWorkspaceId(),
      ...box,
      style: { ...useDrawings.getState().style },
      z: nextZ(),
      createdAt: now,
      updatedAt: now,
      ...extra,
    };
  }, []);

  const anchorFor = (p: Pt, free: boolean): ShapeAnchor | null =>
    free ? null : anchorAt(p, live.current.rects.list, 10 / live.current.zoom);

  // ---------- shape interaction (select tool, or outside draw mode) ----------

  const onShapePointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, shape: Shape) => {
      if (e.button !== 0) return;
      const st = useDrawings.getState();
      if (st.active && st.tool !== 'select') return; // the overlay handles drawing tools
      const isSelected = st.selected.includes(shape.id);
      const start = toFlow(e);
      if (!st.active && !isSelected) {
        // Outside draw mode a drag on an unselected shape pans the board; a click selects it
        const sx = e.clientX;
        const sy = e.clientY;
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointerup', up, true);
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) useDrawings.getState().select(e.shiftKey ? [...st.selected, shape.id] : [shape.id]);
        };
        window.addEventListener('pointerup', up, true);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      const ids = e.shiftKey
        ? isSelected
          ? st.selected.filter((id) => id !== shape.id)
          : [...st.selected, shape.id]
        : isSelected
          ? st.selected
          : [shape.id];
      st.select(ids);
      if (e.shiftKey && isSelected) return;
      const snapshot = ids.map((id) => st.shapes[id]).filter(Boolean);
      let moved = false;
      startGesture(e, {
        onMove: (p) => {
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          if (!moved && Math.hypot(dx, dy) * live.current.zoom < 3) return;
          moved = true;
          useDrawings.getState().preview(snapshot.map((s) => moveShape(s, dx, dy, live.current.rectOf)));
        },
        onUp: (p) => {
          if (!moved) return;
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          useDrawings.getState().commit(snapshot.map((s) => ({ id: s.id, before: s, after: moveShape(s, dx, dy, live.current.rectOf) })));
        },
        onCancel: () => useDrawings.getState().preview(snapshot),
      });
    },
    [startGesture, toFlow],
  );

  const onShapeDoubleClick = useCallback((e: React.MouseEvent<SVGGElement>, shape: Shape) => {
    if (shape.kind !== 'text') return;
    e.stopPropagation();
    useDrawings.getState().setEditingText(shape.id);
    setTextDraft({ id: shape.id, x: shape.x, y: shape.y, existing: shape });
  }, []);

  const onHandlePointerDown = (e: React.PointerEvent, shape: Shape, handle: Handle | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const orig = shape;
    if (handle === 'start' || handle === 'end') {
      startGesture(e, {
        onMove: (p, ev) => {
          const anchor = anchorFor(p, ev.altKey);
          setSnapTarget(anchor?.nodeId ?? null);
          useDrawings.getState().preview([setLinkEnd(orig, handle, p, anchor, live.current.rectOf)]);
        },
        onUp: (p, ev) => {
          setSnapTarget(null);
          const after = setLinkEnd(orig, handle, p, anchorFor(p, ev.altKey), live.current.rectOf);
          useDrawings.getState().commit([{ id: orig.id, before: orig, after }]);
        },
        onCancel: () => {
          setSnapTarget(null);
          useDrawings.getState().preview([orig]);
        },
      });
      return;
    }
    const startBox = shapeBounds(orig);
    const keep = (ev: PointerEvent) => (orig.kind === 'image' ? !ev.shiftKey : ev.shiftKey);
    startGesture(e, {
      onMove: (p, ev) => useDrawings.getState().preview([resizeShape(orig, startBox, resizeBox(startBox, handle, p, keep(ev)))]),
      onUp: (p, ev) => {
        const after = resizeShape(orig, startBox, resizeBox(startBox, handle, p, keep(ev)));
        useDrawings.getState().commit([{ id: orig.id, before: orig, after }]);
      },
      onCancel: () => useDrawings.getState().preview([orig]),
    });
  };

  // ---------- drawing tools (capture overlay) ----------

  const onOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = useDrawings.getState();
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      // Middle button / Space + drag pans in draw mode
      e.preventDefault();
      const vp = flow.getViewport();
      const sx = e.clientX;
      const sy = e.clientY;
      const onMove = (ev: PointerEvent) => void flow.setViewport({ x: vp.x + ev.clientX - sx, y: vp.y + ev.clientY - sy, zoom: vp.zoom });
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const start = toFlow(e);
    const z = live.current.zoom;
    switch (st.tool) {
      case 'pen': {
        const points: [number, number][] = [[start.x, start.y]];
        const shape = baseShape('pen', { x: start.x, y: start.y, w: 0, h: 0 }, { points });
        setDraft(shape);
        let frame = 0;
        startGesture(e, {
          onMove: (p) => {
            const last = points[points.length - 1];
            if (Math.hypot(p.x - last[0], p.y - last[1]) * live.current.zoom < 1.5) return;
            points.push([p.x, p.y]);
            if (!frame) frame = requestAnimationFrame(() => {
              frame = 0;
              setDraft({ ...shape, points: [...points] });
            });
          },
          onUp: () => {
            cancelAnimationFrame(frame);
            setDraft(null);
            let pts = simplifyStroke(points, 1 / z);
            for (let step = 2; pts.length > MAX_POINTS; step *= 2) pts = simplifyStroke(points, step / z);
            const bounds = boundsOfPoints(pts);
            const after = { ...shape, ...bounds, points: pts, updatedAt: Date.now() };
            useDrawings.getState().commit([{ id: after.id, before: null, after }]);
          },
          onCancel: () => setDraft(null),
        });
        return;
      }
      case 'line':
      case 'arrow': {
        const startAnchor = anchorFor(start, e.altKey);
        const kind = st.tool;
        const make = (p: Pt, ev: { shiftKey: boolean; altKey: boolean }) => {
          const end = ev.shiftKey ? snapAngle(start, p) : p;
          const endAnchor = anchorFor(end, ev.altKey);
          const points: [number, number][] = [[start.x, start.y], [end.x, end.y]];
          return { shape: { ...base, points, ...boxFromPoints(start, end), start: startAnchor, end: endAnchor }, endAnchor };
        };
        const base = baseShape(kind, { x: start.x, y: start.y, w: 0, h: 0 }, { points: [[start.x, start.y], [start.x, start.y]], start: startAnchor, end: null });
        setDraft(base);
        setSnapTarget(startAnchor?.nodeId ?? null);
        startGesture(e, {
          onMove: (p, ev) => {
            const { shape, endAnchor } = make(p, ev);
            setSnapTarget(endAnchor?.nodeId ?? startAnchor?.nodeId ?? null);
            setDraft(shape);
          },
          onUp: (p, ev) => {
            setDraft(null);
            setSnapTarget(null);
            const { shape } = make(p, ev);
            const [a, b] = linkEnds(shape, live.current.rectOf);
            const tooShort = Math.hypot(p.x - start.x, p.y - start.y) * live.current.zoom < 6 || Math.hypot(b.x - a.x, b.y - a.y) < 2;
            if (tooShort) return;
            useDrawings.getState().commit([{ id: shape.id, before: null, after: shape }]);
          },
          onCancel: () => {
            setDraft(null);
            setSnapTarget(null);
          },
        });
        return;
      }
      case 'rect':
      case 'ellipse': {
        const kind = st.tool;
        const base = baseShape(kind, { x: start.x, y: start.y, w: 0, h: 0 });
        const box = (p: Pt, square: boolean): Box => {
          if (!square) return boxFromPoints(start, p);
          const size = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
          return boxFromPoints(start, { x: start.x + Math.sign(p.x - start.x || 1) * size, y: start.y + Math.sign(p.y - start.y || 1) * size });
        };
        setDraft(base);
        startGesture(e, {
          onMove: (p, ev) => setDraft({ ...base, ...box(p, ev.shiftKey) }),
          onUp: (p, ev) => {
            setDraft(null);
            const b = box(p, ev.shiftKey);
            if (b.w * live.current.zoom < 4 && b.h * live.current.zoom < 4) return;
            const after = { ...base, ...b };
            useDrawings.getState().commit([{ id: after.id, before: null, after }]);
          },
          onCancel: () => setDraft(null),
        });
        return;
      }
      case 'text': {
        // Clicking an existing text edits it
        const hit = shapeAt(visibleRef.current, start, 4 / z, live.current.rectOf);
        if (hit?.kind === 'text') {
          st.setEditingText(hit.id);
          setTextDraft({ id: hit.id, x: hit.x, y: hit.y, existing: hit });
          return;
        }
        const size = TEXT_PX[st.style.width];
        const id = newShapeId();
        st.setEditingText(id);
        setTextDraft({ id, x: start.x, y: start.y - size * 0.6, existing: null });
        return;
      }
      case 'eraser': {
        const hits = new Set<string>();
        const eraseAt = (p: Pt) => {
          const tol = 8 / live.current.zoom;
          for (const s of visibleRef.current) {
            if (!hits.has(s.id) && shapeAt([s], p, tol, live.current.rectOf)) hits.add(s.id);
          }
          setErasing(new Set(hits));
        };
        eraseAt(start);
        startGesture(e, {
          onMove: (p) => eraseAt(p),
          onUp: () => {
            setErasing(new Set());
            const cur = useDrawings.getState().shapes;
            const changes = [...hits].filter((id) => cur[id]).map((id) => ({ id, before: cur[id], after: null }));
            useDrawings.getState().commit(changes);
          },
          onCancel: () => setErasing(new Set()),
        });
        return;
      }
      default:
        return;
    }
  };

  const onOverlayWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // The overlay sits above React Flow's zoom pane, so zoom the board around the pointer ourselves
    const vp = flow.getViewport();
    const rect = (domNode ?? e.currentTarget).getBoundingClientRect();
    const factor = Math.pow(2, -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * (e.ctrlKey ? 10 : 1));
    const nextZoom = Math.min(zoomLimits.current.max, Math.max(zoomLimits.current.min, vp.zoom * factor));
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const k = nextZoom / vp.zoom;
    void flow.setViewport({ x: sx - (sx - vp.x) * k, y: sy - (sy - vp.y) * k, zoom: nextZoom });
  };

  // ---------- keyboard, paste, drop, outside clicks ----------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const board = useBoard.getState();
      if (board.newAgentOpen || board.confirm !== null || board.settingsOpen) return;
      const st = useDrawings.getState();
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const engaged = st.active || st.selected.length > 0;
      if (mod && !e.altKey && engaged && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key.toLowerCase() === 'y' || e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected.length) {
        e.preventDefault();
        e.stopPropagation();
        st.removeSelected();
        return;
      }
      if (e.key === 'Escape' && (st.selected.length || st.active)) {
        e.stopPropagation();
        if (st.selected.length) st.select([]);
        else st.setActive(false);
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        if (e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        if (!st.active && !useDrawVoicePrefs.getState().prefs.showDrawings) useDrawVoicePrefs.getState().setPrefs({ showDrawings: true });
        st.setActive(!st.active);
        return;
      }
      if (e.key === ' ' && st.active) {
        spaceHeld.current = true;
        return;
      }
      const toolKey = TOOL_KEYS[e.key.toLowerCase()];
      if (st.active && toolKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        st.setTool(toolKey);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceHeld.current = false;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  const placeImage = useCallback(
    async (file: File, at: Pt | null) => {
      try {
        const [uploaded, size] = await Promise.all([uploadImage(file), imageSize(file)]);
        const { w, h } = fitImage(size);
        let center = at;
        if (!center) {
          const r = (domNode ?? document.body).getBoundingClientRect();
          center = flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }
        const shape = baseShape('image', { x: center.x - w / 2, y: center.y - h / 2, w, h }, { imageId: uploaded.id });
        // Images go to the bottom of the stack so existing annotations stay on top of them
        const minZ = Math.min(0, ...Object.values(useDrawings.getState().shapes).map((s) => s.z));
        shape.z = minZ - 1;
        if (!useDrawVoicePrefs.getState().prefs.showDrawings) useDrawVoicePrefs.getState().setPrefs({ showDrawings: true });
        useDrawings.getState().commit([{ id: shape.id, before: null, after: shape }]);
        useDrawings.getState().select([shape.id]);
      } catch (error) {
        useBoard.getState().toast((error as Error).message);
      }
    },
    [baseShape, domNode, flow],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(document.activeElement) || isTypingTarget(e.target)) return;
      const file = imageFromTransfer(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      void placeImage(file, null);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [placeImage]);

  useEffect(() => {
    if (!domNode) return;
    const hasImage = (e: DragEvent) => Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    const onDragOver = (e: DragEvent) => {
      if (!hasImage(e) || (e.target as Element | null)?.closest?.('.xterm')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      const file = imageFromTransfer(e.dataTransfer);
      if (!file || (e.target as Element | null)?.closest?.('.xterm')) return;
      e.preventDefault();
      void placeImage(file, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    };
    domNode.addEventListener('dragover', onDragOver);
    domNode.addEventListener('drop', onDrop);
    return () => {
      domNode.removeEventListener('dragover', onDragOver);
      domNode.removeEventListener('drop', onDrop);
    };
  }, [domNode, flow, placeImage]);

  // Clicking anywhere that is not a shape or drawing UI clears the shape selection
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!useDrawings.getState().selected.length) return;
      if (target?.closest?.('[data-shape-id], [data-draw-ui]')) return;
      useDrawings.getState().select([]);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  // ---------- text editing ----------

  const finishText = useCallback((text: string) => {
    const draftText = textDraftRef.current;
    setTextDraft(null);
    useDrawings.getState().setEditingText(null);
    if (!draftText) return;
    const st = useDrawings.getState();
    const trimmed = text.replace(/\s+$/, '');
    const existing = draftText.existing ? st.shapes[draftText.existing.id] ?? draftText.existing : null;
    if (!trimmed) {
      if (existing) st.commit([{ id: existing.id, before: existing, after: null }]);
      return;
    }
    const style = existing?.style ?? st.style;
    const size = TEXT_PX[style.width];
    const { w, h } = measureText(trimmed, size);
    if (existing) {
      if (existing.text === trimmed) return;
      st.commit([{ id: existing.id, before: existing, after: { ...existing, text: trimmed, w, h, updatedAt: Date.now() } }]);
      return;
    }
    const shape = { ...baseShape('text', { x: draftText.x, y: draftText.y, w, h }, { text: trimmed }), id: draftText.id };
    st.commit([{ id: shape.id, before: null, after: shape }]);
  }, [baseShape]);
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;

  // ---------- render ----------

  const drawing = active && tool !== 'select';
  const interactive = show && (!active || tool === 'select');
  const front = active;
  const selectedShapes = selected.map((id) => shapes[id]).filter((s): s is Shape => !!s && onWorkspace(s));
  const editingId = textDraft?.id ?? editingTextId;
  const anchorRect = snapTarget ? rects.map.get(snapTarget) : undefined;

  return (
    <>
      {show && (
        <ViewportPortal>
          <div data-testid="drawing-layer" data-draw-front={front || undefined} style={{ position: 'absolute', left: 0, top: 0, zIndex: front ? LAYER_Z_FRONT : LAYER_Z_BEHIND }}>
            <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
              {visible.map((shape) =>
                shape.id === editingId ? null : (
                  <ShapeSvg
                    key={shape.id}
                    shape={shape}
                    rectOf={isLinkShape(shape) ? rectOf : NO_RECTS}
                    interactive={interactive}
                    nopan={active || selected.includes(shape.id)}
                    faded={erasing.has(shape.id)}
                    zoom={zoom}
                    onPointerDown={onShapePointerDown}
                    onDoubleClick={onShapeDoubleClick}
                  />
                ),
              )}
            </svg>
          </div>
        </ViewportPortal>
      )}

      <ViewportPortal>
        <div data-draw-ui style={{ position: 'absolute', left: 0, top: 0, zIndex: HANDLES_Z, pointerEvents: 'none' }}>
          <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
            {draft && <ShapeSvg shape={draft} rectOf={rectOf} interactive={false} nopan={false} zoom={zoom} />}
            {anchorRect && (
              <rect
                data-testid="draw-snap-target"
                x={anchorRect.x - 4}
                y={anchorRect.y - 4}
                width={anchorRect.width + 8}
                height={anchorRect.height + 8}
                rx={12}
                fill="none"
                stroke="var(--aa-accent)"
                strokeWidth={2 / zoom}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              />
            )}
            {show && selectedShapes.length > 0 && !editingId && (
              <SelectionHandles shapes={selectedShapes} rectOf={rectOf} zoom={zoom} onHandleDown={onHandlePointerDown} />
            )}
          </svg>
        </div>
      </ViewportPortal>

      {textDraft && (
        <ViewportPortal>
          <TextEditor key={textDraft.id} draft={textDraft} onDone={finishText} />
        </ViewportPortal>
      )}

      {drawing && (
        <div
          data-draw-ui
          data-testid="draw-overlay"
          className={`${OVERLAY_CLASS} nopan nodrag nowheel`}
          onPointerDown={onOverlayPointerDown}
          onWheel={onOverlayWheel}
          onContextMenu={(e) => e.preventDefault()}
          style={{ position: 'absolute', inset: 0, zIndex: 5, cursor: tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair', touchAction: 'none' }}
        />
      )}

      <DrawRail />
    </>
  );
}

// ---------- selection outline + handles ----------

function SelectionHandles({
  shapes,
  rectOf,
  zoom,
  onHandleDown,
}: {
  shapes: Shape[];
  rectOf: RectOf;
  zoom: number;
  onHandleDown: (e: React.PointerEvent, shape: Shape, handle: Handle | 'start' | 'end') => void;
}) {
  const k = 1 / Math.max(zoom, 0.05);
  const single = shapes.length === 1 ? shapes[0] : null;
  const handleStyle = { pointerEvents: 'all' as const };
  if (single && isLinkShape(single)) {
    const [a, b] = linkEnds(single, rectOf);
    return (
      <g data-testid="draw-selection">
        {(
          [
            ['start', a],
            ['end', b],
          ] as const
        ).map(([which, p]) => (
          <circle
            key={which}
            data-testid={`draw-handle-${which}`}
            className="nopan nodrag"
            cx={p.x}
            cy={p.y}
            r={6 * k}
            fill="var(--aa-elevated)"
            stroke="var(--aa-accent)"
            strokeWidth={2 * k}
            style={{ ...handleStyle, cursor: 'crosshair' }}
            onPointerDown={(e) => onHandleDown(e, single, which)}
          />
        ))}
      </g>
    );
  }
  const box = unionBoxes(shapes.map((s) => shapeBounds(s, rectOf)));
  if (!box) return null;
  const pad = 6 * k;
  const outer = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
  const resizable = single && single.kind !== 'text';
  const cursor: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
  const size = 9 * k;
  return (
    <g data-testid="draw-selection">
      <rect x={outer.x} y={outer.y} width={outer.w} height={outer.h} fill="none" stroke="var(--aa-accent)" strokeWidth={1.5 * k} strokeDasharray={`${5 * k} ${4 * k}`} />
      {resizable &&
        HANDLES.map((h) => {
          const p = handlePoint(box, h);
          return (
            <rect
              key={h}
              data-testid={`draw-handle-${h}`}
              className="nopan nodrag"
              x={p.x - size / 2}
              y={p.y - size / 2}
              width={size}
              height={size}
              rx={2 * k}
              fill="var(--aa-elevated)"
              stroke="var(--aa-accent)"
              strokeWidth={1.5 * k}
              style={{ ...handleStyle, cursor: cursor[h] }}
              onPointerDown={(e) => onHandleDown(e, single, h)}
            />
          );
        })}
    </g>
  );
}

// ---------- text editor (an HTML textarea in flow coordinates, so it zooms with the board) ----------

function TextEditor({ draft, onDone }: { draft: TextDraft; onDone: (text: string) => void }) {
  const style = draft.existing?.style ?? useDrawings.getState().style;
  const size = TEXT_PX[style.width];
  const [value, setValue] = useState(draft.existing?.text ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(ref.current?.value ?? value);
  };
  useEffect(() => {
    // Focus after the pointerup that opened it, or the click would blur it again
    const t = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  const lines = value.split('\n');
  const { w } = measureText(value || 'M', size);
  return (
    <textarea
      ref={ref}
      data-draw-ui
      data-testid="draw-text-editor"
      className="nopan nodrag nowheel"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          finish();
        }
      }}
      style={{
        position: 'absolute',
        left: draft.x - 4,
        top: draft.y - 4,
        zIndex: EDITOR_Z,
        width: Math.max(80, w + size),
        height: lines.length * size * TEXT_LINE + 8,
        padding: 3,
        margin: 0,
        border: '1px dashed var(--aa-accent)',
        borderRadius: 4,
        background: 'color-mix(in srgb, var(--aa-elevated) 70%, transparent)',
        color: colorVar(style.color),
        font: `500 ${size}px/${TEXT_LINE} ${TEXT_FONT}`,
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre',
        pointerEvents: 'all',
      }}
    />
  );
}

