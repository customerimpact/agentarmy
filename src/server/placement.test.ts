import { describe, expect, it } from 'vitest';
import { findFreeSlot } from './placement.js';

const at = (x: number, y: number) => ({ x, y, width: 760, height: 520 });

describe('findFreeSlot', () => {
  it('starts at the origin on an empty board', () => {
    expect(findFreeSlot([])).toEqual(at(0, 0));
  });

  it('fills a row of three, then wraps', () => {
    expect(findFreeSlot([at(0, 0)])).toEqual(at(800, 0));
    expect(findFreeSlot([at(0, 0), at(800, 0), at(1600, 0)])).toEqual(at(0, 560));
  });

  it('reuses a gap left by a closed console', () => {
    expect(findFreeSlot([at(0, 0), at(1600, 0)])).toEqual(at(800, 0));
  });

  it('skips slots that a moved console partly covers', () => {
    expect(findFreeSlot([{ x: 500, y: 100, width: 400, height: 300 }])).toEqual(at(1600, 0));
  });

  it('keeps a custom size', () => {
    expect(findFreeSlot([], { width: 600, height: 400 })).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });
  });
});
