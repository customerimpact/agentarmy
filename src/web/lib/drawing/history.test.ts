import { describe, expect, it } from 'vitest';
import { DEFAULT_SHAPE_STYLE, type Shape } from '../../../shared/drawings';
import { applyChanges, DrawingHistory, invert } from './history';

const s = (id: string, x = 0): Shape => ({ id, kind: 'rect', workspaceId: 'main', x, y: 0, w: 1, h: 1, style: DEFAULT_SHAPE_STYLE, z: 0, createdAt: 0, updatedAt: 0 });

describe('DrawingHistory', () => {
  it('undoes and redoes create, move and delete', () => {
    const h = new DrawingHistory();
    let shapes: Record<string, Shape> = {};
    const a0 = s('a');
    const a1 = s('a', 50);
    const steps = [
      [{ id: 'a', before: null, after: a0 }],
      [{ id: 'a', before: a0, after: a1 }],
      [{ id: 'a', before: a1, after: null }],
    ];
    for (const step of steps) {
      h.push(step);
      shapes = applyChanges(shapes, step);
    }
    expect(shapes).toEqual({});
    shapes = applyChanges(shapes, h.undo()!);
    expect(shapes.a.x).toBe(50);
    shapes = applyChanges(shapes, h.undo()!);
    expect(shapes.a.x).toBe(0);
    expect(h.canRedo).toBe(true);
    shapes = applyChanges(shapes, h.redo()!);
    expect(shapes.a.x).toBe(50);
    shapes = applyChanges(shapes, h.undo()!);
    shapes = applyChanges(shapes, h.undo()!);
    expect(shapes).toEqual({});
    expect(h.undo()).toBeNull();
    expect(h.canUndo).toBe(false);
  });

  it('a new action clears redo; no-op entries are ignored; the stack is capped', () => {
    const h = new DrawingHistory(3);
    const a = s('a');
    h.push([{ id: 'a', before: null, after: a }]);
    h.undo();
    h.push([{ id: 'b', before: null, after: s('b') }]);
    expect(h.canRedo).toBe(false);
    h.push([{ id: 'a', before: a, after: a }]); // nothing changed
    for (let i = 0; i < 5; i++) h.push([{ id: `c${i}`, before: null, after: s(`c${i}`) }]);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(3);
  });

  it('inverts multi-shape entries in reverse order', () => {
    const entry = [
      { id: 'a', before: null, after: s('a') },
      { id: 'b', before: s('b'), after: null },
    ];
    expect(invert(entry).map((c) => [c.id, !!c.before, !!c.after])).toEqual([
      ['b', false, true],
      ['a', true, false],
    ]);
  });
});
