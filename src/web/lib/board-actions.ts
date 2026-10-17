import type { ReactFlowInstance } from '@xyflow/react';
import type { ConsoleInfo, ConsoleLayout } from '../../shared/protocol';
import { api } from './api';
import { useBoard, type Viewport } from './store';
import { socket } from './socket';
import { focusTerminal, getTerminal } from './terminals';
import { rememberRecentFolder } from './recent-folders';

export const DEFAULT_SIZE = { width: 760, height: 460 };
export const MIN_SIZE = { width: 360, height: 220 };
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;
// Below this zoom the live terminal is swapped for a status card (xterm text gets unreadable/blurry)
export const COMPACT_ZOOM = 0.6;

let flow: ReactFlowInstance | null = null;

export function setFlowInstance(instance: ReactFlowInstance | null): void {
  flow = instance;
}

function boardRect(): DOMRect | null {
  return document.querySelector('.react-flow')?.getBoundingClientRect() ?? null;
}

// Animate to a console at a readable zoom, select it and put the cursor in its terminal
export async function flyTo(id: string, options: { focus?: boolean } = {}): Promise<void> {
  const { focus = true } = options;
  useBoard.getState().select(id);
  if (!flow) return;
  await flow.fitView({
    nodes: [{ id }],
    duration: 450,
    padding: 0.08,
    minZoom: COMPACT_ZOOM,
    // Landing at exactly 1 keeps the focused terminal pixel-perfect (and lets it use WebGL)
    maxZoom: 1,
  });
  if (focus) window.requestAnimationFrame(() => focusTerminal(id));
}

export function fitAll(): void {
  void flow?.fitView({ duration: 400, padding: 0.1, maxZoom: 1 });
}

// Zoom around a screen point; used for ctrl/cmd+wheel over terminals, which swallow wheel events
export function zoomAt(clientX: number, clientY: number, factor: number): void {
  const rect = boardRect();
  if (!flow || !rect) return;
  const { x, y, zoom } = flow.getViewport();
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  if (nextZoom === zoom) return;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const ratio = nextZoom / zoom;
  const next = { x: px - (px - x) * ratio, y: py - (py - y) * ratio, zoom: nextZoom };
  void flow.setViewport(next);
  persistViewport(next);
}

// ---------- persistence (debounced) ----------

const pendingLayouts = new Map<string, Partial<ConsoleLayout>>();
const layoutTimers = new Map<string, number>();

export function persistLayout(id: string, layout: Partial<ConsoleLayout>): void {
  const rounded = Object.fromEntries(
    Object.entries(layout).map(([key, value]) => [key, Math.round(value as number)]),
  ) as Partial<ConsoleLayout>;
  useBoard.getState().setLayoutLocal(id, rounded);
  pendingLayouts.set(id, { ...pendingLayouts.get(id), ...rounded });
  window.clearTimeout(layoutTimers.get(id));
  layoutTimers.set(
    id,
    window.setTimeout(() => {
      const pending = pendingLayouts.get(id);
      pendingLayouts.delete(id);
      layoutTimers.delete(id);
      if (!pending || !useBoard.getState().consoles[id]) return;
      api.updateConsole(id, { layout: pending }).catch(() => {
        useBoard.getState().toast('Could not save the layout. Is the server still running?');
      });
    }, 300),
  );
}

let viewportTimer: number | undefined;

export function persistViewport(viewport: Viewport): void {
  useBoard.getState().setViewport(viewport);
  window.clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(() => {
    api.putViewport(viewport).catch(() => undefined);
  }, 500);
}

// ---------- creating consoles ----------

function overlaps(a: ConsoleLayout, b: ConsoleLayout, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

// Nearest free slot to the viewport center, scanning a grid outwards ring by ring
const GRID_GAP = 32;

function findFreeSpot(
  existing: ConsoleLayout[],
  size: { width: number; height: number } = DEFAULT_SIZE,
): ConsoleLayout {
  const rect = boardRect();
  const center =
    flow && rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
  const { width, height } = size;
  const gap = GRID_GAP;
  const origin = { x: center.x - width / 2, y: center.y - height / 2 };

  for (let ring = 0; ring < 12; ring++) {
    const candidates: ConsoleLayout[] = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({
          x: origin.x + dx * (width + gap),
          y: origin.y + dy * (height + gap),
          width,
          height,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y),
    );
    const free = candidates.find((c) => existing.every((e) => !overlaps(c, e, gap / 2)));
    if (free) return free;
  }
  return { ...origin, width, height };
}

export async function createAgent(cwd: string, name?: string): Promise<void> {
  const existing = Object.values(useBoard.getState().consoles).map((c) => c.layout);
  const spot = findFreeSpot(existing);
  const layout = {
    x: Math.round(spot.x),
    y: Math.round(spot.y),
    width: spot.width,
    height: spot.height,
  };
  const created = await api.createConsole({ cwd, name: name?.trim() || undefined, layout });
  useBoard.getState().upsertConsole(created);
  rememberRecentFolder(cwd);
  // Let React Flow mount and measure the node before flying to it
  window.setTimeout(() => void flyTo(created.id), 60);
}

// "Spawn 4": a 2x2 block of consoles in one folder, placed as a unit so the grid stays intact
export async function createAgentGrid(cwd: string, columns = 2, rows = 2): Promise<void> {
  const { width, height } = DEFAULT_SIZE;
  const existing = Object.values(useBoard.getState().consoles).map((c) => c.layout);
  const block = findFreeSpot(existing, {
    width: columns * width + (columns - 1) * GRID_GAP,
    height: rows * height + (rows - 1) * GRID_GAP,
  });
  const layouts: ConsoleLayout[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      layouts.push({
        x: Math.round(block.x + col * (width + GRID_GAP)),
        y: Math.round(block.y + row * (height + GRID_GAP)),
        width,
        height,
      });
    }
  }
  // Sequential so the server hands out friendly names in a stable order
  const created: ConsoleInfo[] = [];
  for (const layout of layouts) {
    const c = await api.createConsole({ cwd, layout });
    useBoard.getState().upsertConsole(c);
    created.push(c);
  }
  rememberRecentFolder(cwd);
  window.setTimeout(() => {
    void flow?.fitView({
      nodes: created.map((c) => ({ id: c.id })),
      duration: 450,
      padding: 0.08,
      maxZoom: 1,
    });
    if (created[0]) useBoard.getState().select(created[0].id);
  }, 80);
}

// Sends a line to a console as if typed. Text and Enter go out as separate writes: TUIs like
// Claude Code treat one chunk ending in "\r" as a paste and insert a newline instead of submitting.
export function sendLine(id: string, text: string): void {
  const term = getTerminal(id);
  const multiLine = text.includes('\n');
  // Bracketed paste keeps multi-line text in one prompt instead of submitting at each newline
  const payload = multiLine && term?.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
  socket.send({ type: 'input', id, data: payload });
  window.setTimeout(() => socket.send({ type: 'input', id, data: '\r' }), 40);
}

export async function restartConsole(id: string): Promise<void> {
  try {
    const updated = await api.restartConsole(id);
    useBoard.getState().upsertConsole(updated);
  } catch (error) {
    useBoard.getState().toast(`Restart failed: ${(error as Error).message}`);
  }
}

export async function closeConsole(id: string): Promise<void> {
  try {
    await api.deleteConsole(id);
    useBoard.getState().removeConsole(id);
  } catch (error) {
    useBoard.getState().toast(`Close failed: ${(error as Error).message}`);
  }
}
