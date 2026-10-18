import { describe, expect, it } from 'vitest';
import { GAP, GRID, snapMove, snapResize, snapToGrid, unionRect, type Rect } from './snap';

const r = (x: number, y: number, width = 400, height = 300): Rect => ({ x, y, width, height });

describe('snapToGrid / unionRect', () => {
  it('rounds to the 20px grid', () => {
    expect(snapToGrid(29)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    expect(snapToGrid(-11)).toBe(-20);
  });

  it('bounds several rects', () => {
    expect(unionRect([r(0, 0, 10, 10), r(50, -20, 10, 10)])).toEqual({ x: 0, y: -20, width: 60, height: 30 });
    expect(unionRect([])).toBeNull();
  });
});

describe('snapMove', () => {
  it('falls back to the grid when nothing is near', () => {
    const res = snapMove(r(1013, 2027), []);
    expect(res).toEqual({ x: 1020, y: 2020, guides: [] });
  });

  it('aligns the left edge with a neighbour within the magnet distance', () => {
    const other = r(0, 0);
    const res = snapMove(r(7, 400), [other]);
    expect(res.x).toBe(0);
    expect(res.guides.some((g) => g.kind === 'align' && g.x1 === 0 && g.x2 === 0)).toBe(true);
  });

  it('keeps a consistent gap when side by side', () => {
    const other = r(0, 0);
    const res = snapMove(r(400 + GAP + 9, 3), [other]);
    expect(res.x).toBe(400 + GAP);
    expect(res.y).toBe(0); // top edges align too
    expect(res.guides.some((g) => g.kind === 'gap')).toBe(true);
  });

  it('scales the magnet distance with zoom', () => {
    const other = r(0, 0);
    // 20 board px away: too far at zoom 1 (12px), close enough at zoom 0.5 (24 board px)
    expect(snapMove(r(25, 500), [other], { zoom: 1 }).x).toBe(snapToGrid(25, GRID));
    expect(snapMove(r(20, 500), [other], { zoom: 0.5 }).x).toBe(0);
  });

  it('ignores far-away rects on the other axis', () => {
    const other = r(0, 0, 400, 300);
    const res = snapMove(r(5, 5000), [other]);
    expect(res.x).toBe(0); // grid snap, not a magnet
    expect(res.guides).toEqual([]);
  });

  it('picks the closest candidate', () => {
    const a = r(0, 0);
    const b = r(3, 400);
    const res = snapMove(r(4, 800), [a, b]);
    expect(res.x).toBe(3);
  });
});

describe('snapResize', () => {
  it('matches the size of a neighbour', () => {
    const other = r(0, 0, 760, 520);
    const res = snapResize(r(900, 0, 753, 529), [other]);
    expect(res.rect).toEqual({ x: 900, y: 0, width: 760, height: 520 });
    expect(res.guides.filter((g) => g.kind === 'size')).toHaveLength(2);
  });

  it('snaps to the grid when no neighbour size is close', () => {
    const res = snapResize(r(0, 0, 611, 433), []);
    expect(res.rect.width).toBe(620);
    expect(res.rect.height).toBe(440);
  });

  it('keeps the right edge fixed when resizing from the left', () => {
    const other = r(2000, 0, 600, 400);
    const res = snapResize(r(105, 0, 595, 400), [other], { fromLeft: true });
    expect(res.rect.width).toBe(600);
    expect(res.rect.x + res.rect.width).toBe(700);
  });

  it('respects the minimum size', () => {
    const res = snapResize(r(0, 0, 351, 211), [], { minWidth: 360, minHeight: 220 });
    expect(res.rect.width).toBe(360);
    expect(res.rect.height).toBe(220);
  });
});
