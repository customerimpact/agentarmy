import { describe, expect, it } from 'vitest';
import { DEFAULT_SHAPE_STYLE, type Shape } from '../../../shared/drawings';
import {
  anchorAt,
  clipToRect,
  hitTest,
  linkEnds,
  moveShape,
  penPath,
  rawEnds,
  resizeBox,
  resizeShape,
  setLinkEnd,
  shapeAt,
  shapeBounds,
  simplifyStroke,
  snapAngle,
  sortByZ,
  type NodeRect,
} from './geometry';

const style = { ...DEFAULT_SHAPE_STYLE, width: 'S' as const };

function shape(kind: Shape['kind'], extra: Partial<Shape> = {}): Shape {
  return { id: `s-${kind}`, kind, workspaceId: 'main', x: 0, y: 0, w: 100, h: 50, style, z: 1, createdAt: 1, updatedAt: 1, ...extra };
}

describe('arrow anchoring', () => {
  const consoleRect: NodeRect = { x: 200, y: 100, width: 400, height: 200 };
  const rects = new Map<string, NodeRect>([['c1', consoleRect]]);
  const rectOf = (id: string) => rects.get(id);

  it('anchors to the topmost node under the point, as fractions of its rect', () => {
    const under = { id: 'under', rect: { x: 0, y: 0, width: 1000, height: 1000 } };
    const top = { id: 'c1', rect: consoleRect };
    expect(anchorAt({ x: 300, y: 150 }, [top, under])).toEqual({ nodeId: 'c1', fx: 0.25, fy: 0.25 });
    expect(anchorAt({ x: 50, y: 50 }, [top])).toBeNull();
    // within the tolerance just outside the border: clamped onto the edge
    expect(anchorAt({ x: 195, y: 150 }, [top], 8)).toEqual({ nodeId: 'c1', fx: 0, fy: 0.25 });
  });

  it('follows the node when it moves or resizes', () => {
    const arrow = shape('arrow', { points: [[0, 0], [300, 150]], end: { nodeId: 'c1', fx: 0.5, fy: 0.5 } });
    expect(rawEnds(arrow, rectOf)[1]).toEqual({ x: 400, y: 200 });
    rects.set('c1', { x: 1000, y: 500, width: 200, height: 100 });
    expect(rawEnds(arrow, rectOf)[1]).toEqual({ x: 1100, y: 550 });
    rects.set('c1', consoleRect);
  });

  it('falls back to the stored point when the node is gone', () => {
    const arrow = shape('arrow', { points: [[0, 0], [300, 150]], end: { nodeId: 'gone', fx: 0.5, fy: 0.5 } });
    expect(rawEnds(arrow, rectOf)[1]).toEqual({ x: 300, y: 150 });
  });

  it('stops an anchored end at the node border (plus a gap)', () => {
    const arrow = shape('arrow', { points: [[0, 200], [0, 0]], end: { nodeId: 'c1', fx: 0.5, fy: 0.5 } });
    const [, b] = linkEnds(arrow, rectOf);
    expect(b.x).toBeCloseTo(194);
    expect(b.y).toBeCloseTo(200);
  });

  it('clips segments to rect borders', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(clipToRect({ x: -100, y: 50 }, { x: 50, y: 50 }, rect)).toEqual({ x: 0, y: 50 });
    expect(clipToRect({ x: 50, y: -50 }, { x: 50, y: 50 }, rect, 10)).toEqual({ x: 50, y: -10 });
    expect(clipToRect({ x: 20, y: 20 }, { x: 50, y: 50 }, rect)).toBeNull(); // both inside
  });

  it('moving an anchored arrow detaches it at its current position', () => {
    const arrow = shape('arrow', { points: [[0, 0], [10, 10]], end: { nodeId: 'c1', fx: 0, fy: 0 } });
    const moved = moveShape(arrow, 5, 5, rectOf, 99);
    expect(moved.end).toBeNull();
    expect(moved.points).toEqual([[5, 5], [205, 105]]);
    expect(moved.updatedAt).toBe(99);
  });

  it('sets an end with or without an anchor', () => {
    const line = shape('line', { points: [[0, 0], [10, 10]] });
    const glued = setLinkEnd(line, 'end', { x: 400, y: 200 }, { nodeId: 'c1', fx: 0.5, fy: 0.5 }, rectOf);
    expect(glued.end).toEqual({ nodeId: 'c1', fx: 0.5, fy: 0.5 });
    expect(glued.points).toEqual([[0, 0], [400, 200]]);
    expect(glued.start).toBeUndefined();
  });
});

describe('hit tests and bounds', () => {
  it('hits an unfilled rect only near its border, a filled one inside', () => {
    const r = shape('rect');
    expect(hitTest(r, { x: 50, y: 25 }, 4)).toBe(false);
    expect(hitTest(r, { x: 50, y: 1 }, 4)).toBe(true);
    expect(hitTest({ ...r, style: { ...style, fill: 'soft' } }, { x: 50, y: 25 }, 4)).toBe(true);
    expect(hitTest(r, { x: 500, y: 500 }, 4)).toBe(false);
  });

  it('hits ellipses on the outline', () => {
    const e = shape('ellipse');
    expect(hitTest(e, { x: 100, y: 25 }, 3)).toBe(true);
    expect(hitTest(e, { x: 50, y: 25 }, 3)).toBe(false);
  });

  it('hits pen strokes and lines near their segments', () => {
    const pen = shape('pen', { points: [[0, 0], [100, 0], [100, 100]] });
    expect(hitTest(pen, { x: 50, y: 3 }, 3)).toBe(true);
    expect(hitTest(pen, { x: 50, y: 50 }, 3)).toBe(false);
    expect(shapeBounds(pen)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    const line = shape('line', { points: [[0, 0], [100, 100]] });
    expect(hitTest(line, { x: 50, y: 52 }, 3)).toBe(true);
  });

  it('picks the topmost shape', () => {
    const a = shape('rect', { id: 'a', z: 1, style: { ...style, fill: 'soft' } });
    const b = shape('rect', { id: 'b', z: 2, style: { ...style, fill: 'soft' } });
    expect(shapeAt(sortByZ([b, a]), { x: 10, y: 10 }, 2)?.id).toBe('b');
  });
});

describe('resizing', () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };

  it('drags a corner and flips past the opposite side', () => {
    expect(resizeBox(box, 'se', { x: 200, y: 100 })).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(resizeBox(box, 'e', { x: -50, y: 999 })).toEqual({ x: -50, y: 0, w: 50, h: 50 });
    expect(resizeBox(box, 'nw', { x: 100, y: 50 })).toEqual({ x: 100, y: 50, w: 4, h: 4 }); // min size
  });

  it('keeps the aspect ratio on request', () => {
    const r = resizeBox(box, 'se', { x: 300, y: 60 }, true);
    expect(r.w / r.h).toBeCloseTo(2);
    expect(r.w).toBe(300);
  });

  it('scales pen strokes into the new box', () => {
    const pen = shape('pen', { points: [[0, 0], [100, 50]] });
    const out = resizeShape(pen, box, { x: 10, y: 10, w: 200, h: 100 });
    expect(out.points).toEqual([[10, 10], [210, 110]]);
    expect(out).toMatchObject({ x: 10, y: 10, w: 200, h: 100 });
  });
});

describe('strokes', () => {
  it('smooths with quadratic curves', () => {
    expect(penPath([[0, 0], [10, 0], [20, 10]])).toBe('M0 0Q10 0 15 5L20 10');
    expect(penPath([[1, 1]])).toMatch(/^M1 1L/);
  });

  it('drops pointer noise but keeps both ends', () => {
    const out = simplifyStroke([[0, 0], [0.2, 0], [0.4, 0], [5, 0], [5.1, 0]], 1);
    expect(out).toEqual([[0, 0], [5, 0], [5.1, 0]]);
  });

  it('snaps angles to 15° steps', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 3 });
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(100.04, 1);
  });
});
