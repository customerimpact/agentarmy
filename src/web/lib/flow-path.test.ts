import { describe, expect, it } from 'vitest';
import { flowPath, labelPoint, nearestSides } from './flow-path';

const r = (x: number, y: number, width = 400, height = 300) => ({ x, y, width, height });

describe('nearestSides', () => {
  it('connects bottom to top when the target is below', () => {
    expect(nearestSides(r(0, 0), r(100, 800))).toEqual(['bottom', 'top']);
    expect(nearestSides(r(100, 800), r(0, 0))).toEqual(['top', 'bottom']);
  });

  it('connects right to left when side by side', () => {
    expect(nearestSides(r(0, 0), r(1000, 50))).toEqual(['right', 'left']);
    expect(nearestSides(r(1000, 50), r(0, 0))).toEqual(['left', 'right']);
  });
});

describe('flowPath', () => {
  it('starts and ends on the facing sides', () => {
    const p = flowPath(r(0, 0), r(0, 800));
    expect(p.source.y).toBe(300);
    expect(p.target.y).toBe(800);
    expect(p.d.startsWith('M')).toBe(true);
    expect(p.d).toContain(' C');
  });

  it('bends (organic sag) instead of a straight line', () => {
    const p = flowPath(r(0, 0), r(0, 800));
    // Straight down would keep x constant; the sag pushes the control points sideways
    expect(p.c2.x).not.toBe(p.target.x);
    expect(Math.abs(p.mid.x - p.source.x)).toBeGreaterThan(5);
  });

  it('reverse path runs from target to source', () => {
    const p = flowPath(r(0, 0), r(1000, 0));
    expect(p.reverse.startsWith(`M${p.target.x},${p.target.y}`)).toBe(true);
    expect(p.reverse.endsWith(`${p.source.x},${p.source.y}`)).toBe(true);
  });
});

describe('labelPoint', () => {
  it('uses the middle when it is free', () => {
    const p = flowPath(r(0, 0), r(0, 1000));
    expect(labelPoint(p, [], { width: 100, height: 20 })).toEqual(p.mid);
  });

  it('slides along the curve away from a node covering the middle', () => {
    const p = flowPath(r(0, 0), r(0, 1000));
    const blocker = { x: p.mid.x - 300, y: p.mid.y - 100, width: 600, height: 200 };
    const pt = labelPoint(p, [blocker], { width: 100, height: 20 });
    expect(pt).not.toEqual(p.mid);
    expect(pt.y < blocker.y - 10 || pt.y > blocker.y + blocker.height + 10).toBe(true);
  });
});
