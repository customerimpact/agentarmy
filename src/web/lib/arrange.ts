// Pure layout math for the Arrange menu: grid, row, column, cascade stack, tidy by project and
// "same size". Input rects are board coordinates; output is a map of id -> new rect.
import { GRID, snapToGrid, unionRect, type Rect } from './snap';

export type ArrangeMode = 'grid' | 'row' | 'column' | 'stack' | 'project';
export type ColumnsSetting = 2 | 3 | 4 | 'auto';
export type SizePreset = 'S' | 'M' | 'L';

export const SIZE_PRESETS: Record<SizePreset, { width: number; height: number }> = {
  S: { width: 560, height: 380 },
  M: { width: 760, height: 520 },
  L: { width: 960, height: 640 },
};
export const GAP_OPTIONS = [24, 40, 64] as const;
export const STACK_OFFSET = 32;
// Project frame chrome around its consoles (must match ProjectFrame)
export const FRAME_PAD = 16;
export const FRAME_TITLE = 36;

export interface ArrangeItem {
  id: string;
  rect: Rect;
}

export interface ArrangeOptions {
  columns?: ColumnsSetting;
  gap?: number;
}

export type Layouts = Map<string, Rect>;

// Reading order: rows (by top edge, banded), then left to right
export function readingOrder(items: ArrangeItem[], band = 200): ArrangeItem[] {
  return [...items].sort((a, b) => {
    const rowA = Math.round(a.rect.y / band);
    const rowB = Math.round(b.rect.y / band);
    return rowA - rowB || a.rect.x - b.rect.x || a.id.localeCompare(b.id);
  });
}

export function autoColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return Math.ceil(Math.sqrt(count));
}

function originOf(items: ArrangeItem[]): { x: number; y: number } {
  const box = unionRect(items.map((i) => i.rect));
  return box ? { x: snapToGrid(box.x, GRID), y: snapToGrid(box.y, GRID) } : { x: 0, y: 0 };
}

// Grid with per-column widths and per-row heights, so mixed sizes never overlap
export function gridLayout(
  items: ArrangeItem[],
  columns: number,
  gap: number,
  origin: { x: number; y: number },
): Layouts {
  const out: Layouts = new Map();
  if (!items.length) return out;
  const cols = Math.max(1, Math.min(columns, items.length));
  const colWidths: number[] = new Array(cols).fill(0);
  const rowHeights: number[] = [];
  items.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    colWidths[col] = Math.max(colWidths[col], item.rect.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, item.rect.height);
  });
  const colX: number[] = [];
  let x = origin.x;
  for (const w of colWidths) {
    colX.push(x);
    x += w + gap;
  }
  const rowY: number[] = [];
  let y = origin.y;
  for (const h of rowHeights) {
    rowY.push(y);
    y += h + gap;
  }
  items.forEach((item, i) => {
    out.set(item.id, {
      x: colX[i % cols],
      y: rowY[Math.floor(i / cols)],
      width: item.rect.width,
      height: item.rect.height,
    });
  });
  return out;
}

export function arrange(items: ArrangeItem[], mode: Exclude<ArrangeMode, 'project'>, options: ArrangeOptions = {}): Layouts {
  const gap = options.gap ?? 40;
  const ordered = readingOrder(items);
  const origin = originOf(items);
  switch (mode) {
    case 'grid': {
      const cols = options.columns === 'auto' || !options.columns ? autoColumns(items.length) : options.columns;
      return gridLayout(ordered, cols, gap, origin);
    }
    case 'row':
      return gridLayout(ordered, ordered.length, gap, origin);
    case 'column':
      return gridLayout(ordered, 1, gap, origin);
    case 'stack': {
      const out: Layouts = new Map();
      ordered.forEach((item, i) => {
        out.set(item.id, {
          x: origin.x + i * STACK_OFFSET,
          y: origin.y + i * STACK_OFFSET,
          width: item.rect.width,
          height: item.rect.height,
        });
      });
      return out;
    }
  }
}

export interface ProjectGroup {
  key: string | null; // project id, or null for consoles without a project (no frame)
  items: ArrangeItem[]; // in project order
}

// Each project's consoles packed in a 2-column grid inside its frame; frames side by side,
// wrapping into rows so the whole board stays roughly as wide as it is tall.
export function tidyByProject(groups: ProjectGroup[], options: ArrangeOptions = {}): Layouts {
  const gap = options.gap ?? 40;
  const all = groups.flatMap((g) => g.items);
  const out: Layouts = new Map();
  if (!all.length) return out;
  const origin = originOf(all);

  // Lay each group out at (0,0) first to learn its outer size (frame chrome included)
  const blocks = groups
    .filter((g) => g.items.length)
    .map((g) => {
      const framed = g.key !== null;
      const inset = framed ? { x: FRAME_PAD, y: FRAME_PAD + FRAME_TITLE } : { x: 0, y: 0 };
      const cols = g.items.length === 1 ? 1 : 2;
      const inner = gridLayout(g.items, cols, gap, inset);
      const box = unionRect([...inner.values()])!;
      const pad = framed ? FRAME_PAD : 0;
      return { inner, width: box.x + box.width + pad, height: box.y + box.height + pad };
    });

  const totalArea = blocks.reduce((sum, b) => sum + (b.width + gap) * (b.height + gap), 0);
  const maxRowWidth = Math.max(Math.sqrt(totalArea) * 1.6, ...blocks.map((b) => b.width));
  // Frames sit outside the consoles, so leave room for the frame chrome between blocks
  const blockGap = gap + FRAME_PAD;

  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > maxRowWidth) {
      x = 0;
      y += rowHeight + blockGap;
      rowHeight = 0;
    }
    for (const [id, r] of block.inner) {
      out.set(id, { ...r, x: origin.x + x + r.x, y: origin.y + y + r.y });
    }
    x += block.width + blockGap;
    rowHeight = Math.max(rowHeight, block.height);
  }
  return out;
}

// The most common (width, height) pair; ties go to the larger area
export function mostCommonSize(rects: Rect[]): { width: number; height: number } | null {
  if (!rects.length) return null;
  const counts = new Map<string, { width: number; height: number; n: number }>();
  for (const r of rects) {
    const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
    const entry = counts.get(key) ?? { width: Math.round(r.width), height: Math.round(r.height), n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  let best: { width: number; height: number; n: number } | null = null;
  for (const e of counts.values()) {
    if (!best || e.n > best.n || (e.n === best.n && e.width * e.height > best.width * best.height))
      best = e;
  }
  return best && { width: best.width, height: best.height };
}

// Resize every item to one size, keeping each top-left corner
export function sameSize(items: ArrangeItem[], size?: { width: number; height: number }): Layouts {
  const target = size ?? mostCommonSize(items.map((i) => i.rect));
  const out: Layouts = new Map();
  if (!target) return out;
  for (const item of items) out.set(item.id, { ...item.rect, ...target });
  return out;
}
