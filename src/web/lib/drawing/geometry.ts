import type { Shape, ShapeAnchor, StrokeWidth } from '../../../shared/drawings';

// Pure geometry for the drawing layer: bounds, hit tests, moves, resizes and arrow anchoring.
// Everything is in flow (board) coordinates.

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Live rect of a board node (console, browser tile, item) by id; undefined = not on the board
export type RectOf = (nodeId: string) => NodeRect | undefined;
export const NO_RECTS: RectOf = () => undefined;

export const STROKE_PX: Record<StrokeWidth, number> = { S: 2, M: 4, L: 8 };
export const TEXT_PX: Record<StrokeWidth, number> = { S: 16, M: 24, L: 40 };
export const TEXT_LINE = 1.25;
// Gap between an anchored arrow end and the node border
export const ANCHOR_GAP = 6;

export const isPointShape = (s: Pick<Shape, 'kind'>) => s.kind === 'pen' || s.kind === 'line' || s.kind === 'arrow';
export const isLinkShape = (s: Pick<Shape, 'kind'>) => s.kind === 'line' || s.kind === 'arrow';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function boxFromPoints(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function boundsOfPoints(points: readonly (readonly [number, number])[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBoxes(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bottom - y };
}

// ---------- anchors ----------

export function anchorPoint(rect: NodeRect, anchor: ShapeAnchor): Pt {
  return { x: rect.x + anchor.fx * rect.width, y: rect.y + anchor.fy * rect.height };
}

// The topmost node under (or within `tolerance` of) a point; rects are ordered topmost first
export function anchorAt(point: Pt, rects: { id: string; rect: NodeRect }[], tolerance = 0): ShapeAnchor | null {
  for (const { id, rect } of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const inside =
      point.x >= rect.x - tolerance &&
      point.x <= rect.x + rect.width + tolerance &&
      point.y >= rect.y - tolerance &&
      point.y <= rect.y + rect.height + tolerance;
    if (!inside) continue;
    return { nodeId: id, fx: clamp01((point.x - rect.x) / rect.width), fy: clamp01((point.y - rect.y) / rect.height) };
  }
  return null;
}

const inRect = (p: Pt, r: NodeRect) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;

// Where the segment from `outside` to `inside` crosses the rect border (inflated by gap), or null
export function clipToRect(outside: Pt, inside: Pt, rect: NodeRect, gap = 0): Pt | null {
  const r = { x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 };
  if (inRect(outside, r)) return null;
  const dx = inside.x - outside.x;
  const dy = inside.y - outside.y;
  let best: number | null = null;
  const consider = (t: number, x: number, y: number) => {
    if (t < 0 || t > 1) return;
    if (x < r.x - 1e-6 || x > r.x + r.width + 1e-6 || y < r.y - 1e-6 || y > r.y + r.height + 1e-6) return;
    if (best === null || t < best) best = t;
  };
  if (dx !== 0) {
    for (const ex of [r.x, r.x + r.width]) {
      const t = (ex - outside.x) / dx;
      consider(t, ex, outside.y + t * dy);
    }
  }
  if (dy !== 0) {
    for (const ey of [r.y, r.y + r.height]) {
      const t = (ey - outside.y) / dy;
      consider(t, outside.x + t * dx, ey);
    }
  }
  if (best === null) return null;
  const t: number = best;
  return { x: outside.x + t * dx, y: outside.y + t * dy };
}

// The two raw ends of a line / arrow: anchored ends follow their node, loose ends use points
export function rawEnds(shape: Shape, rectOf: RectOf): [Pt, Pt] {
  const pts = shape.points ?? [[shape.x, shape.y], [shape.x + shape.w, shape.y + shape.h]];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const startRect = shape.start ? rectOf(shape.start.nodeId) : undefined;
  const endRect = shape.end ? rectOf(shape.end.nodeId) : undefined;
  const a = startRect && shape.start ? anchorPoint(startRect, shape.start) : { x: first[0], y: first[1] };
  const b = endRect && shape.end ? anchorPoint(endRect, shape.end) : { x: last[0], y: last[1] };
  return [a, b];
}

// The ends as drawn: an anchored end stops at its node's border so the arrowhead stays visible
export function linkEnds(shape: Shape, rectOf: RectOf): [Pt, Pt] {
  let [a, b] = rawEnds(shape, rectOf);
  const startRect = shape.start ? rectOf(shape.start.nodeId) : undefined;
  const endRect = shape.end ? rectOf(shape.end.nodeId) : undefined;
  if (startRect && shape.start?.nodeId !== shape.end?.nodeId) {
    const clipped = clipToRect(b, a, startRect, ANCHOR_GAP);
    if (clipped) a = clipped;
  }
  if (endRect && shape.start?.nodeId !== shape.end?.nodeId) {
    const clipped = clipToRect(a, b, endRect, ANCHOR_GAP);
    if (clipped) b = clipped;
  }
  return [a, b];
}

// ---------- bounds + hit tests ----------

export function shapeBounds(shape: Shape, rectOf: RectOf = NO_RECTS): Box {
  if (isLinkShape(shape)) {
    const [a, b] = linkEnds(shape, rectOf);
    return boxFromPoints(a, b);
  }
  if (shape.kind === 'pen' && shape.points) return boundsOfPoints(shape.points);
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function hitTest(shape: Shape, p: Pt, tolerance: number, rectOf: RectOf = NO_RECTS): boolean {
  const half = STROKE_PX[shape.style.width] / 2;
  const tol = tolerance + half;
  switch (shape.kind) {
    case 'line':
    case 'arrow': {
      const [a, b] = linkEnds(shape, rectOf);
      return distToSegment(p, a, b) <= tol;
    }
    case 'pen': {
      const pts = shape.points ?? [];
      if (pts.length === 1) return dist(p, { x: pts[0][0], y: pts[0][1] }) <= tol;
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(p, { x: pts[i - 1][0], y: pts[i - 1][1] }, { x: pts[i][0], y: pts[i][1] }) <= tol) return true;
      }
      return false;
    }
    case 'rect': {
      const { x, y, w, h } = shape;
      const inside = p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol;
      if (!inside) return false;
      if (shape.style.fill === 'soft') return true;
      const nearEdge = Math.min(Math.abs(p.x - x), Math.abs(p.x - x - w), Math.abs(p.y - y), Math.abs(p.y - y - h));
      return nearEdge <= tol;
    }
    case 'ellipse': {
      const rx = shape.w / 2;
      const ry = shape.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const cx = shape.x + rx;
      const cy = shape.y + ry;
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry); // 1 = on the outline
      if (shape.style.fill === 'soft' && d <= 1) return true;
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
    }
    case 'text':
    case 'image':
      return p.x >= shape.x - tolerance && p.x <= shape.x + shape.w + tolerance && p.y >= shape.y - tolerance && p.y <= shape.y + shape.h + tolerance;
  }
}

// Topmost shape under a point (shapes in paint order, lowest z first)
export function shapeAt(shapes: Shape[], p: Pt, tolerance: number, rectOf: RectOf = NO_RECTS): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) if (hitTest(shapes[i], p, tolerance, rectOf)) return shapes[i];
  return null;
}

export function sortByZ(shapes: Shape[]): Shape[] {
  return [...shapes].sort((a, b) => a.z - b.z || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

// ---------- edits (return new objects, never mutate) ----------

const stamp = <T extends Shape>(s: T, now: number): T => ({ ...s, updatedAt: now });

// Moving a line / arrow detaches anchored ends (they would otherwise stay on their nodes)
export function moveShape(shape: Shape, dx: number, dy: number, rectOf: RectOf = NO_RECTS, now = Date.now()): Shape {
  if (isLinkShape(shape)) {
    const [a, b] = rawEnds(shape, rectOf);
    const points: [number, number][] = [
      [a.x + dx, a.y + dy],
      [b.x + dx, b.y + dy],
    ];
    const bounds = boundsOfPoints(points);
    return stamp({ ...shape, ...bounds, points, start: null, end: null }, now);
  }
  if (shape.kind === 'pen' && shape.points) {
    const points = shape.points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
    return stamp({ ...shape, points, x: shape.x + dx, y: shape.y + dy }, now);
  }
  return stamp({ ...shape, x: shape.x + dx, y: shape.y + dy }, now);
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(box: Box, handle: Handle): Pt {
  const x = handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2;
  const y = handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}

// New box when dragging `handle` of `start` to `pointer`. Dragging past the opposite side flips.
export function resizeBox(start: Box, handle: Handle, pointer: Pt, keepAspect = false, min = 4): Box {
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (handle.includes('w')) x0 = pointer.x;
  if (handle.includes('e')) x1 = pointer.x;
  if (handle.includes('n')) y0 = pointer.y;
  if (handle.includes('s')) y1 = pointer.y;
  let box: Box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  if (keepAspect && start.w > 0 && start.h > 0 && handle.length === 2) {
    const ratio = start.w / start.h;
    const w = Math.max(box.w, box.h * ratio);
    const h = w / ratio;
    // Keep the corner opposite to the handle fixed
    const fixedX = handle.includes('w') ? start.x + start.w : start.x;
    const fixedY = handle.includes('n') ? start.y + start.h : start.y;
    box = {
      x: pointer.x < fixedX ? fixedX - w : fixedX,
      y: pointer.y < fixedY ? fixedY - h : fixedY,
      w,
      h,
    };
  }
  return { ...box, w: Math.max(min, box.w), h: Math.max(min, box.h) };
}

// Fit a shape into a new box (pen strokes are scaled point by point)
export function resizeShape(shape: Shape, from: Box, to: Box, now = Date.now()): Shape {
  if (shape.kind === 'pen' && shape.points) {
    const sx = from.w > 0 ? to.w / from.w : 1;
    const sy = from.h > 0 ? to.h / from.h : 1;
    const points = shape.points.map(([x, y]) => [to.x + (x - from.x) * sx, to.y + (y - from.y) * sy] as [number, number]);
    return stamp({ ...shape, points, ...boundsOfPoints(points) }, now);
  }
  if (isLinkShape(shape)) return shape;
  return stamp({ ...shape, x: to.x, y: to.y, w: to.w, h: to.h }, now);
}

// Move one end of a line / arrow, optionally gluing it to a node
export function setLinkEnd(shape: Shape, which: 'start' | 'end', point: Pt, anchor: ShapeAnchor | null, rectOf: RectOf = NO_RECTS, now = Date.now()): Shape {
  const [a, b] = rawEnds(shape, rectOf);
  const next: [Pt, Pt] = which === 'start' ? [point, b] : [a, point];
  const points: [number, number][] = next.map((p) => [p.x, p.y] as [number, number]);
  return stamp({ ...shape, points, ...boundsOfPoints(points), [which]: anchor }, now);
}

// Snap a direction to 15° steps (Shift while drawing lines)
export function snapAngle(from: Pt, to: Pt, stepDeg = 15): Pt {
  const len = dist(from, to);
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
}

// ---------- rendering helpers ----------

// Smooth freehand path: quadratic curves through the midpoints of the captured points
export function penPath(points: readonly (readonly [number, number])[]): string {
  if (!points.length) return '';
  const f = (n: number) => Math.round(n * 100) / 100;
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${f(x)} ${f(y)}L${f(x + 0.01)} ${f(y)}`;
  }
  if (points.length === 2) return `M${f(points[0][0])} ${f(points[0][1])}L${f(points[1][0])} ${f(points[1][1])}`;
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  return `${d}L${f(last[0])} ${f(last[1])}`;
}

// Drops points closer than minDist to the previous kept one (pointer noise while drawing)
export function simplifyStroke(points: [number, number][], minDist: number): [number, number][] {
  if (points.length <= 2) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(points[i][0] - prev[0], points[i][1] - prev[1]) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// The two wings of an arrowhead at b, pointing away from a
export function arrowHead(a: Pt, b: Pt, strokePx: number): string {
  const len = Math.max(12, strokePx * 3.5);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = (28 * Math.PI) / 180;
  const p1 = { x: b.x - len * Math.cos(angle - spread), y: b.y - len * Math.sin(angle - spread) };
  const p2 = { x: b.x - len * Math.cos(angle + spread), y: b.y - len * Math.sin(angle + spread) };
  const f = (n: number) => Math.round(n * 100) / 100;
  return `M${f(p1.x)} ${f(p1.y)}L${f(b.x)} ${f(b.y)}L${f(p2.x)} ${f(p2.y)}`;
}
