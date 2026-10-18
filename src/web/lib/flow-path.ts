// Geometry for the organic "flow" lines between nodes: connect the nearest sides of two rects
// with a smooth cubic bezier that sags a little, so a fan of lines feels drawn, not routed.
import type { Rect } from './snap';

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Point {
  x: number;
  y: number;
}

export interface FlowPath {
  d: string; // source -> target
  reverse: string; // target -> source (for particles flowing back)
  source: Point;
  target: Point;
  c1: Point;
  c2: Point;
  mid: Point; // point on the curve at t = 0.5 (label position)
  sourceSide: Side;
  targetSide: Side;
}

const NORMAL: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

function anchor(r: Rect, side: Side, toward: Point): Point {
  // Slide the anchor along the side toward the other node, but stay away from the corners
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (side === 'top' || side === 'bottom') {
    const inset = Math.min(48, r.width / 4);
    const x = clamp(r.x + r.width / 2 + (toward.x - (r.x + r.width / 2)) * 0.25, r.x + inset, r.x + r.width - inset);
    return { x, y: side === 'top' ? r.y : r.y + r.height };
  }
  const inset = Math.min(48, r.height / 4);
  const y = clamp(r.y + r.height / 2 + (toward.y - (r.y + r.height / 2)) * 0.25, r.y + inset, r.y + r.height - inset);
  return { x: side === 'left' ? r.x : r.x + r.width, y };
}

export function nearestSides(a: Rect, b: Rect): [Side, Side] {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  // Prefer vertical connections (top/bottom) unless the nodes are clearly side by side
  const vertical =
    gapY > 0
      ? gapY >= gapX * 0.6
      : gapX <= 0 && Math.abs(bc.y - ac.y) >= Math.abs(bc.x - ac.x);
  if (vertical) {
    return bc.y >= ac.y ? ['bottom', 'top'] : ['top', 'bottom'];
  }
  return bc.x >= ac.x ? ['right', 'left'] : ['left', 'right'];
}

const fmt = (n: number) => Math.round(n * 10) / 10;

export function flowPath(a: Rect, b: Rect, sag = 0.12): FlowPath {
  const [sourceSide, targetSide] = nearestSides(a, b);
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const source = anchor(a, sourceSide, bc);
  const target = anchor(b, targetSide, ac);
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.hypot(dx, dy) || 1;
  const reach = Math.max(60, Math.min(dist * 0.45, 420));
  // Perpendicular sag, always bending the same way relative to the travel direction
  const perp = { x: -dy / dist, y: dx / dist };
  const bend = dist * sag;
  const n1 = NORMAL[sourceSide];
  const n2 = NORMAL[targetSide];
  const c1 = {
    x: source.x + n1.x * reach + perp.x * bend * 0.6,
    y: source.y + n1.y * reach + perp.y * bend * 0.6,
  };
  const c2 = {
    x: target.x + n2.x * reach + perp.x * bend,
    y: target.y + n2.y * reach + perp.y * bend,
  };
  const mid = {
    x: (source.x + 3 * c1.x + 3 * c2.x + target.x) / 8,
    y: (source.y + 3 * c1.y + 3 * c2.y + target.y) / 8,
  };
  const p = (pt: Point) => `${fmt(pt.x)},${fmt(pt.y)}`;
  return {
    d: `M${p(source)} C${p(c1)} ${p(c2)} ${p(target)}`,
    reverse: `M${p(target)} C${p(c2)} ${p(c1)} ${p(source)}`,
    source,
    target,
    c1,
    c2,
    mid,
    sourceSide,
    targetSide,
  };
}

export function pointAt(p: Pick<FlowPath, 'source' | 'c1' | 'c2' | 'target'>, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p.source.x + b * p.c1.x + c * p.c2.x + d * p.target.x,
    y: a * p.source.y + b * p.c1.y + c * p.c2.y + d * p.target.y,
  };
}

const LABEL_TS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73, 0.2, 0.8];

// Where to put a label on the curve: as close to the middle as possible without sitting on a node
export function labelPoint(
  p: Pick<FlowPath, 'source' | 'c1' | 'c2' | 'target'>,
  obstacles: Rect[],
  size: { width: number; height: number },
): Point {
  for (const t of LABEL_TS) {
    const pt = pointAt(p, t);
    const box = { x: pt.x - size.width / 2, y: pt.y - size.height / 2, ...size };
    const hit = obstacles.some(
      (o) => box.x < o.x + o.width && box.x + box.width > o.x && box.y < o.y + o.height && box.y + box.height > o.y,
    );
    if (!hit) return pt;
  }
  return pointAt(p, 0.5);
}
