// Pure helpers for mapping between the tile on the board and the page inside it

export interface Size {
  width: number;
  height: number;
}

// Where content of `content` size lands inside `box` with object-fit: contain
export function containRect(box: Size, content: Size): { x: number; y: number; width: number; height: number; scale: number } {
  if (!content.width || !content.height || !box.width || !box.height) {
    return { x: 0, y: 0, width: box.width, height: box.height, scale: 1 };
  }
  const scale = Math.min(box.width / content.width, box.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height, scale };
}

// Element-local CSS px (unscaled by board zoom) -> page px; null when outside the drawn page
export function toPagePoint(local: { x: number; y: number }, box: Size, page: Size): { x: number; y: number } | null {
  const r = containRect(box, page);
  const x = (local.x - r.x) / r.scale;
  const y = (local.y - r.y) / r.scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

// Page px -> element-local CSS px (for drawing the agent's pointer)
export function toLocalPoint(pagePt: { x: number; y: number }, box: Size, page: Size): { x: number; y: number } {
  const r = containRect(box, page);
  return { x: r.x + pagePt.x * r.scale, y: r.y + pagePt.y * r.scale };
}

// Pointer position relative to an element, undoing the board's zoom transform
export function localPoint(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const sx = rect.width ? el.offsetWidth / rect.width : 1;
  const sy = rect.height ? el.offsetHeight / rect.height : 1;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8
export function modifierBits(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function buttonName(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}
