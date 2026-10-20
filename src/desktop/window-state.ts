import fs from 'node:fs';
import path from 'node:path';
import type { Rectangle } from 'electron';
import type { TitleBarColors } from '../shared/desktop-api';

// Small JSON file in the desktop profile (userData): window bounds plus a few one-time flags

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface DesktopState {
  window?: WindowBounds;
  titleBar?: TitleBarColors; // last page theme, so the next start paints the right colour at once
  closeNoticeShown?: boolean;
}

export const DEFAULT_BOUNDS: WindowBounds = { width: 1440, height: 900, maximized: false };
const MIN_VISIBLE = 120; // px of the window that must land on a screen to reuse the saved position

export class DesktopStateFile {
  private state: DesktopState;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly filePath: string) {
    this.state = DesktopStateFile.read(filePath);
  }

  private static read(file: string): DesktopState {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as DesktopState) : {};
    } catch {
      return {};
    }
  }

  get(): DesktopState {
    return this.state;
  }

  update(patch: Partial<DesktopState>, options: { now?: boolean } = {}): void {
    this.state = { ...this.state, ...patch };
    if (options.now) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch {
      // read-only profile: we just forget the window size
    }
  }
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= MIN_VISIBLE && h >= MIN_VISIBLE;
}

// Never larger than the screen it opens on (small laptops), or the bottom of dialogs is unreachable
function fitTo(bounds: WindowBounds, area: Rectangle | undefined): WindowBounds {
  if (!area) return bounds;
  return { ...bounds, width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) };
}

// Saved bounds, minus a position that is no longer on any screen (unplugged monitor).
// workAreas[0] is the primary display, where a window without a position opens.
export function restoreBounds(saved: WindowBounds | undefined, workAreas: Rectangle[]): WindowBounds {
  const valid =
    saved &&
    Number.isFinite(saved.width) &&
    Number.isFinite(saved.height) &&
    saved.width >= 400 &&
    saved.height >= 300;
  if (!valid) return fitTo({ ...DEFAULT_BOUNDS }, workAreas[0]);
  const bounds: WindowBounds = {
    width: Math.round(saved.width),
    height: Math.round(saved.height),
    maximized: saved.maximized === true,
  };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const rect = { x: saved.x!, y: saved.y!, width: bounds.width, height: bounds.height };
    const area = workAreas.find((a) => intersects(rect, a));
    if (area) {
      bounds.x = Math.round(saved.x!);
      bounds.y = Math.round(saved.y!);
      return fitTo(bounds, area);
    }
  }
  return fitTo(bounds, workAreas[0]);
}
