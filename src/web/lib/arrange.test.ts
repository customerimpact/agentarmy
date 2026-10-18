import { describe, expect, it } from 'vitest';
import {
  FRAME_PAD,
  FRAME_TITLE,
  STACK_OFFSET,
  arrange,
  autoColumns,
  mostCommonSize,
  readingOrder,
  sameSize,
  tidyByProject,
  type ArrangeItem,
} from './arrange';
import type { Rect } from './snap';

const item = (id: string, x: number, y: number, width = 400, height = 300): ArrangeItem => ({
  id,
  rect: { x, y, width, height },
});

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function noOverlaps(rects: Rect[]): boolean {
  return rects.every((a, i) => rects.every((b, j) => i === j || !overlaps(a, b)));
}

describe('readingOrder / autoColumns', () => {
  it('orders rows top to bottom, then left to right', () => {
    const order = readingOrder([item('c', 0, 900), item('b', 500, 10), item('a', 0, 0)]);
    expect(order.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('picks sensible column counts', () => {
    expect(autoColumns(1)).toBe(1);
    expect(autoColumns(4)).toBe(2);
    expect(autoColumns(6)).toBe(3);
    expect(autoColumns(10)).toBe(4);
  });
});

describe('arrange', () => {
  const items = [item('a', 0, 0), item('b', 1000, 30), item('c', 30, 800), item('d', 990, 790)];

  it('grids with the chosen gap from the top-left of the selection', () => {
    const out = arrange(items, 'grid', { columns: 2, gap: 40 });
    expect(out.get('a')).toMatchObject({ x: 0, y: 0 });
    expect(out.get('b')).toMatchObject({ x: 440, y: 0 });
    expect(out.get('c')).toMatchObject({ x: 0, y: 340 });
    expect(out.get('d')).toMatchObject({ x: 440, y: 340 });
  });

  it('never overlaps mixed sizes', () => {
    const mixed = [item('a', 0, 0, 900, 600), item('b', 10, 10, 300, 200), item('c', 20, 20, 500, 700)];
    for (const mode of ['grid', 'row', 'column'] as const) {
      expect(noOverlaps([...arrange(mixed, mode, { gap: 24 }).values()])).toBe(true);
    }
  });

  it('lays out a row and a column', () => {
    const row = arrange(items, 'row', { gap: 24 });
    expect(new Set([...row.values()].map((r) => r.y)).size).toBe(1);
    const column = arrange(items, 'column', { gap: 24 });
    expect(new Set([...column.values()].map((r) => r.x)).size).toBe(1);
  });

  it('cascades a stack', () => {
    const out = arrange(items, 'stack');
    expect(out.get('b')).toMatchObject({ x: STACK_OFFSET, y: STACK_OFFSET });
    expect(out.get('d')).toMatchObject({ x: 3 * STACK_OFFSET, y: 3 * STACK_OFFSET });
  });
});

describe('tidyByProject', () => {
  it('packs each project in two columns inside its frame without frames overlapping', () => {
    const groups = [
      { key: 'p1', items: [item('a', 0, 0), item('b', 0, 0), item('c', 0, 0)] },
      { key: 'p2', items: [item('d', 0, 0), item('e', 0, 0)] },
      { key: null, items: [item('f', 0, 0)] },
    ];
    const out = tidyByProject(groups, { gap: 40 });
    expect(out.size).toBe(6);
    // Two columns inside p1
    expect(out.get('b')!.x - out.get('a')!.x).toBe(440);
    expect(out.get('c')!.x).toBe(out.get('a')!.x);
    // Frame chrome above the first console
    expect(out.get('a')!.y).toBe(FRAME_PAD + FRAME_TITLE);
    const frame = (ids: string[]) => {
      const rs = ids.map((id) => out.get(id)!);
      const x = Math.min(...rs.map((r) => r.x)) - FRAME_PAD;
      const y = Math.min(...rs.map((r) => r.y)) - FRAME_PAD - FRAME_TITLE;
      const x2 = Math.max(...rs.map((r) => r.x + r.width)) + FRAME_PAD;
      const y2 = Math.max(...rs.map((r) => r.y + r.height)) + FRAME_PAD;
      return { x, y, width: x2 - x, height: y2 - y };
    };
    expect(noOverlaps([frame(['a', 'b', 'c']), frame(['d', 'e']), out.get('f')!])).toBe(true);
  });
});

describe('sizes', () => {
  it('finds the most common size, ties to the larger', () => {
    expect(
      mostCommonSize([
        { x: 0, y: 0, width: 400, height: 300 },
        { x: 0, y: 0, width: 760, height: 520 },
        { x: 0, y: 0, width: 760, height: 520 },
      ]),
    ).toEqual({ width: 760, height: 520 });
    expect(
      mostCommonSize([
        { x: 0, y: 0, width: 400, height: 300 },
        { x: 0, y: 0, width: 960, height: 640 },
      ]),
    ).toEqual({ width: 960, height: 640 });
  });

  it('gives everything one size keeping positions', () => {
    const out = sameSize([item('a', 5, 6, 100, 100), item('b', 50, 60, 200, 200)], { width: 560, height: 380 });
    expect(out.get('a')).toEqual({ x: 5, y: 6, width: 560, height: 380 });
    expect(out.get('b')).toEqual({ x: 50, y: 60, width: 560, height: 380 });
  });
});
