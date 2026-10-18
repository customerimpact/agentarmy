// Pure snapping math for dragging and resizing nodes on the board ("clip" into place).
// Positions are board (flow) coordinates; the magnet distance is in screen pixels, so it is
// divided by the zoom to feel the same at every zoom level.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A thin guide line drawn while something snaps (board coordinates)
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'align' | 'gap' | 'size';
}

export const GRID = 20;
export const GAP = 40;
export const MAGNET_PX = 12;

const GUIDE_OVERHANG = 12;

export const snapToGrid = (value: number, grid = GRID): number => Math.round(value / grid) * grid;

export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// Do two ranges overlap (or nearly, within slack)?
const rangesTouch = (a1: number, a2: number, b1: number, b2: number, slack: number) =>
  a1 < b2 + slack && a2 > b1 - slack;

type Axis = 'x' | 'y';
type Kind = 'start' | 'end' | 'center' | 'gap-after' | 'gap-before';

interface Candidate {
  value: number; // new rect start on this axis
  dist: number;
  other: Rect;
  kind: Kind;
}

const start = (r: Rect, axis: Axis) => (axis === 'x' ? r.x : r.y);
const size = (r: Rect, axis: Axis) => (axis === 'x' ? r.width : r.height);
const cross: Record<Axis, Axis> = { x: 'y', y: 'x' };

function bestCandidate(rect: Rect, others: Rect[], axis: Axis, threshold: number, gap: number) {
  const s = start(rect, axis);
  const len = size(rect, axis);
  const c = cross[axis];
  let best: Candidate | null = null;
  const consider = (value: number, other: Rect, kind: Kind) => {
    const dist = Math.abs(value - s);
    if (dist <= threshold && (!best || dist < best.dist)) best = { value, dist, other, kind };
  };
  for (const o of others) {
    const os = start(o, axis);
    const ol = size(o, axis);
    // Only magnet to neighbours that are reasonably close on the other axis
    const near = rangesTouch(
      start(rect, c),
      start(rect, c) + size(rect, c),
      start(o, c),
      start(o, c) + size(o, c),
      Math.max(size(rect, c), size(o, c)) * 1.5,
    );
    if (!near) continue;
    consider(os, o, 'start');
    consider(os + ol - len, o, 'end');
    consider(os + ol / 2 - len / 2, o, 'center');
    // Consistent spacing only makes sense side by side (overlapping on the other axis)
    const sideBySide = rangesTouch(
      start(rect, c),
      start(rect, c) + size(rect, c),
      start(o, c),
      start(o, c) + size(o, c),
      0,
    );
    if (sideBySide) {
      consider(os + ol + gap, o, 'gap-after');
      consider(os - gap - len, o, 'gap-before');
    }
  }
  return best as Candidate | null;
}

function guidesFor(rect: Rect, axis: Axis, cand: Candidate, others: Rect[], gap: number): Guide[] {
  const c = cross[axis];
  const line = (pos: number, from: number, to: number, kind: Guide['kind']): Guide =>
    axis === 'x'
      ? { x1: pos, y1: from, x2: pos, y2: to, kind }
      : { x1: from, y1: pos, x2: to, y2: pos, kind };

  if (cand.kind === 'gap-after' || cand.kind === 'gap-before') {
    const o = cand.other;
    const lo = Math.max(start(rect, c), start(o, c));
    const hi = Math.min(start(rect, c) + size(rect, c), start(o, c) + size(o, c));
    const mid = (lo + hi) / 2;
    const a = cand.kind === 'gap-after' ? start(o, axis) + size(o, axis) : start(rect, axis) + size(rect, axis);
    const seg = { a, b: a + gap };
    return axis === 'x'
      ? [{ x1: seg.a, y1: mid, x2: seg.b, y2: mid, kind: 'gap' }]
      : [{ x1: mid, y1: seg.a, x2: mid, y2: seg.b, kind: 'gap' }];
  }

  const pos =
    cand.kind === 'start'
      ? start(rect, axis)
      : cand.kind === 'end'
        ? start(rect, axis) + size(rect, axis)
        : start(rect, axis) + size(rect, axis) / 2;
  // Extend the line over every rect that shares this edge, not only the one that won
  const sharing = others.filter((o) => {
    const edges = [start(o, axis), start(o, axis) + size(o, axis), start(o, axis) + size(o, axis) / 2];
    return edges.some((e) => Math.abs(e - pos) < 0.5);
  });
  const spans = [rect, ...sharing];
  const from = Math.min(...spans.map((r) => start(r, c))) - GUIDE_OVERHANG;
  const to = Math.max(...spans.map((r) => start(r, c) + size(r, c))) + GUIDE_OVERHANG;
  return [line(pos, from, to, 'align')];
}

export interface SnapOptions {
  zoom?: number;
  grid?: number;
  gap?: number;
  magnetPx?: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: Guide[];
}

// Snap a moving rect: magnet to neighbour edges/centers/consistent gaps, else to the grid
export function snapMove(rect: Rect, others: Rect[], options: SnapOptions = {}): SnapResult {
  const { zoom = 1, grid = GRID, gap = GAP, magnetPx = MAGNET_PX } = options;
  const threshold = magnetPx / Math.max(zoom, 0.05);
  const bx = bestCandidate(rect, others, 'x', threshold, gap);
  const by = bestCandidate(rect, others, 'y', threshold, gap);
  const x = bx ? bx.value : snapToGrid(rect.x, grid);
  const y = by ? by.value : snapToGrid(rect.y, grid);
  const snapped = { ...rect, x, y };
  const guides: Guide[] = [];
  if (bx) guides.push(...guidesFor(snapped, 'x', bx, others, gap));
  if (by) guides.push(...guidesFor(snapped, 'y', by, others, gap));
  return { x, y, guides };
}

export interface ResizeOptions extends SnapOptions {
  minWidth?: number;
  minHeight?: number;
  // Which edges the user is pulling (the opposite edge stays put)
  fromLeft?: boolean;
  fromTop?: boolean;
}

export interface ResizeResult {
  rect: Rect;
  guides: Guide[];
}

function snapLength(
  len: number,
  edgeStart: number,
  fromStart: boolean,
  others: Rect[],
  axis: Axis,
  threshold: number,
  grid: number,
  min: number,
): { len: number; kind: Guide['kind'] | null; other?: Rect } {
  // 1. Same size as a neighbour, so they "all stay the same size"
  let best: { len: number; dist: number; other: Rect } | null = null;
  for (const o of others) {
    const ol = size(o, axis);
    const dist = Math.abs(ol - len);
    if (dist <= threshold && (!best || dist < best.dist)) best = { len: ol, dist, other: o };
  }
  if (best && best.len >= min) return { len: best.len, kind: 'size', other: best.other };
  // 2. Moving edge lines up with a neighbour edge
  const fixed = fromStart ? edgeStart + len : edgeStart; // the edge that does not move
  let edge: { len: number; dist: number; other: Rect } | null = null;
  for (const o of others) {
    for (const e of [start(o, axis), start(o, axis) + size(o, axis)]) {
      const nextLen = fromStart ? fixed - e : e - fixed;
      const dist = Math.abs(nextLen - len);
      if (nextLen >= min && dist <= threshold && (!edge || dist < edge.dist))
        edge = { len: nextLen, dist, other: o };
    }
  }
  if (edge) return { len: edge.len, kind: 'align', other: edge.other };
  return { len: Math.max(min, snapToGrid(len, grid)), kind: null };
}

// Snap a rect being resized: width/height match neighbours, then edges, then the grid
export function snapResize(rect: Rect, others: Rect[], options: ResizeOptions = {}): ResizeResult {
  const {
    zoom = 1,
    grid = GRID,
    magnetPx = MAGNET_PX,
    minWidth = 0,
    minHeight = 0,
    fromLeft = false,
    fromTop = false,
  } = options;
  const threshold = magnetPx / Math.max(zoom, 0.05);
  const w = snapLength(rect.width, rect.x, fromLeft, others, 'x', threshold, grid, minWidth);
  const h = snapLength(rect.height, rect.y, fromTop, others, 'y', threshold, grid, minHeight);
  const x = fromLeft ? rect.x + rect.width - w.len : rect.x;
  const y = fromTop ? rect.y + rect.height - h.len : rect.y;
  const next = { x, y, width: w.len, height: h.len };
  const guides: Guide[] = [];
  if (w.kind) {
    const edgeX = fromLeft ? next.x : next.x + next.width;
    guides.push({
      x1: edgeX,
      y1: next.y - GUIDE_OVERHANG,
      x2: edgeX,
      y2: next.y + next.height + GUIDE_OVERHANG,
      kind: w.kind,
    });
  }
  if (h.kind) {
    const edgeY = fromTop ? next.y : next.y + next.height;
    guides.push({
      x1: next.x - GUIDE_OVERHANG,
      y1: edgeY,
      x2: next.x + next.width + GUIDE_OVERHANG,
      y2: edgeY,
      kind: h.kind,
    });
  }
  return { rect: next, guides };
}
