import type { ConsoleLayout } from '../shared/protocol.js';

export const DEFAULT_SIZE = { width: 760, height: 520 };
const GAP = 40;
const PER_ROW = 3;

function intersects(a: ConsoleLayout, b: ConsoleLayout): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// First grid slot (left to right, top to bottom) that overlaps no existing console
export function findFreeSlot(existing: ConsoleLayout[], size = DEFAULT_SIZE): ConsoleLayout {
  for (let i = 0; ; i++) {
    const slot = {
      x: (i % PER_ROW) * (DEFAULT_SIZE.width + GAP),
      y: Math.floor(i / PER_ROW) * (DEFAULT_SIZE.height + GAP),
      ...size,
    };
    if (!existing.some((layout) => intersects(slot, layout))) return slot;
  }
}
