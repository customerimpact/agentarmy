import { FRAME_PADDING, FRAME_TITLE_HEIGHT, TEMPLATE_GAP } from './templates.js';

// Composer grid, shared by the server launch (src/server/composer.ts) and the dialog's placement.

// Columns of the console grid inside the frame: 1, 2x2, 3x3, then 4 wide
export function composerColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

// Frame size (title bar + padding included) for count consoles of the given size
export function composerFrameSize(count: number, size: { width: number; height: number }): { cols: number; rows: number; width: number; height: number } {
  const n = Math.max(count, 1);
  const cols = composerColumns(n);
  const rows = Math.ceil(n / cols);
  return {
    cols,
    rows,
    width: cols * size.width + (cols - 1) * TEMPLATE_GAP + 2 * FRAME_PADDING,
    height: FRAME_TITLE_HEIGHT + rows * size.height + (rows - 1) * TEMPLATE_GAP + 2 * FRAME_PADDING,
  };
}
