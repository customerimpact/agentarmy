import { describe, expect, it } from 'vitest';
import { containRect, modifierBits, toLocalPoint, toPagePoint } from './browser-geometry';

describe('browser tile coordinate mapping', () => {
  it('maps 1:1 when the box matches the page', () => {
    const size = { width: 960, height: 600 };
    expect(toPagePoint({ x: 100, y: 50 }, size, size)).toEqual({ x: 100, y: 50 });
  });

  it('accounts for letterboxing and scale', () => {
    // 1280x800 page drawn into a 640x600 box: scale 0.5, 200px bars top and bottom (100 each)
    const box = { width: 640, height: 600 };
    const page = { width: 1280, height: 800 };
    expect(containRect(box, page)).toMatchObject({ x: 0, y: 100, scale: 0.5 });
    expect(toPagePoint({ x: 320, y: 300 }, box, page)).toEqual({ x: 640, y: 400 });
    expect(toPagePoint({ x: 10, y: 50 }, box, page)).toBeNull(); // in the bar
    expect(toLocalPoint({ x: 640, y: 400 }, box, page)).toEqual({ x: 320, y: 300 });
  });

  it('builds CDP modifier bits', () => {
    expect(modifierBits({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(11);
  });
});
