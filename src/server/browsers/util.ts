import type { ConsoleLayout } from '../../shared/protocol.js';
import { findFreeSlot } from '../placement.js';

export const TILE_SIZE = { width: 960, height: 640 };
// Height of the browser chrome (header) above the page in a tile; the page viewport is the rest
export const TILE_HEADER = 40;
const GAP = 40;

// "example.com" -> "https://example.com"; "localhost:3000" -> "http://localhost:3000";
// anything with spaces and no dot becomes a Google search.
export function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return 'about:blank';
  if (/^(about|data|file|chrome|view-source):/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`;
  if (/\s/.test(raw) || !/[.:]/.test(raw)) {
    return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }
  return `https://${raw}`;
}

export interface Point {
  x: number;
  y: number;
}

// Points from `from` to `to` (excluding from, including to) with ease-in-out and a slight arc,
// so an agent's pointer glides like a hand-moved mouse instead of teleporting.
export function cursorPath(from: Point, to: Point, steps: number): Point[] {
  const n = Math.max(1, Math.round(steps));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Perpendicular offset for the arc, at most 40px
  const bend = Math.min(40, dist * 0.12);
  const nx = dist ? -dy / dist : 0;
  const ny = dist ? dx / dist : 0;
  const points: Point[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const arc = Math.sin(Math.PI * t) * bend;
    points.push({
      x: Math.round((from.x + dx * e + nx * arc) * 10) / 10,
      y: Math.round((from.y + dy * e + ny * arc) * 10) / 10,
    });
  }
  points[n - 1] = { x: to.x, y: to.y };
  return points;
}

const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Escape: { code: 'Escape', keyCode: 27 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Delete: { code: 'Delete', keyCode: 46 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
};

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

export interface KeyInfo {
  key: string;
  code: string;
  keyCode: number; // windowsVirtualKeyCode, which Chrome needs for editing keys (Enter, arrows...)
  text?: string;
}

// Resolve a DOM key/code pair (or a loose name like "enter" from an agent) to what CDP wants
export function keyInfo(key: string, code = ''): KeyInfo {
  const named = NAMED_KEYS[key] ?? NAMED_KEYS[KEY_ALIASES[key.toLowerCase()] ?? ''];
  if (named) {
    const name = NAMED_KEYS[key] ? key : KEY_ALIASES[key.toLowerCase()];
    return { key: name, code: code || named.code, keyCode: named.keyCode, text: named.text };
  }
  const fn = /^F([1-9]|1[0-2])$/i.exec(key);
  if (fn) return { key: key.toUpperCase(), code: key.toUpperCase(), keyCode: 111 + Number(fn[1]) };
  let keyCode = 0;
  const fromCode = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  if (fromCode) keyCode = fromCode[1].charCodeAt(0);
  else if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z0-9]/.test(upper)) keyCode = upper.charCodeAt(0);
  }
  if (!code && key.length === 1) {
    if (/[a-z]/i.test(key)) code = `Key${key.toUpperCase()}`;
    else if (/[0-9]/.test(key)) code = `Digit${key}`;
  }
  return { key, code, keyCode, text: key.length === 1 ? key : undefined };
}

function intersects(a: ConsoleLayout, b: ConsoleLayout): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Right of the anchor console, else below it, else the first free grid slot
export function placeTile(
  anchor: ConsoleLayout | undefined,
  existing: ConsoleLayout[],
  size = TILE_SIZE,
): ConsoleLayout {
  if (anchor) {
    const tries = [
      { x: anchor.x + anchor.width + GAP, y: anchor.y, ...size },
      { x: anchor.x, y: anchor.y + anchor.height + GAP, ...size },
      { x: anchor.x - size.width - GAP, y: anchor.y, ...size },
    ];
    for (const slot of tries) if (!existing.some((l) => intersects(slot, l))) return slot;
  }
  return findFreeSlot(existing, size);
}

export function viewportForLayout(layout: ConsoleLayout): { width: number; height: number } {
  return {
    width: Math.max(200, Math.round(layout.width)),
    height: Math.max(150, Math.round(layout.height - TILE_HEADER)),
  };
}
