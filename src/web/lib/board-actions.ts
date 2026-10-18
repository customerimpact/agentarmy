import type { ReactFlowInstance } from '@xyflow/react';
import type { ConsoleInfo, ConsoleLayout, Project } from '../../shared/protocol';
import { api } from './api';
import {
  SIZE_PRESETS,
  arrange,
  sameSize,
  tidyByProject,
  type ArrangeItem,
  type ArrangeMode,
  type Layouts,
  type ProjectGroup,
} from './arrange';
import { useBoardUi } from './board-ui';
import { useBoard, type Viewport } from './store';
import { focusTerminal } from './terminals';
import { rememberRecentFolder } from './recent-folders';
import { getPrefs } from './prefs';

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

// Animate to a console (or browser tile) at zoom 1, select it and put the cursor in its terminal.
// Uses setCenter rather than fitView: fitView is queued until the next node update, and the
// selection change we make here re-renders the board first, which used to swap in the board's
// default fitView options (all nodes) and zoom OUT instead of in.
export const FLY_ZOOM = 1;
export const FLY_DURATION_MS = 300;

function itemRect(id: string): ConsoleLayout | null {
  const node = flow?.getInternalNode(id);
  if (node) {
    const width = node.measured?.width ?? node.width;
    const height = node.measured?.height ?? node.height;
    if (width && height) return { ...node.internals.positionAbsolute, width, height };
  }
  const { consoles, browsers } = useBoard.getState();
  return consoles[id]?.layout ?? browsers[id]?.layout ?? null;
}

export async function flyTo(id: string, options: { focus?: boolean } = {}): Promise<void> {
  const { focus = true } = options;
  useBoard.getState().select(id);
  const rect = itemRect(id);
  if (!flow || !rect) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  await flow.setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, {
    zoom: FLY_ZOOM, // exactly 1 keeps the terminal pixel-perfect (and lets it use WebGL)
    duration: reduced ? 0 : FLY_DURATION_MS,
  });
  persistViewport(flow.getViewport());
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

export async function createAgent(
  cwd: string,
  name?: string,
  options: { worktree?: boolean; accountId?: string } = {},
): Promise<void> {
  const existing = Object.values(useBoard.getState().consoles).map((c) => c.layout);
  // Settings > Board > New console size (M keeps the classic default)
  const preset = getPrefs().defaultSize;
  const spot = findFreeSpot(existing, preset === 'M' ? DEFAULT_SIZE : SIZE_PRESETS[preset]);
  const layout = {
    x: Math.round(spot.x),
    y: Math.round(spot.y),
    width: spot.width,
    height: spot.height,
  };
  const created = await api.createConsole({
    cwd,
    name: name?.trim() || undefined,
    layout,
    ...(options.worktree ? { worktree: true } : {}),
    ...(options.accountId && options.accountId !== 'auto' ? { accountId: options.accountId } : {}),
  });
  useBoard.getState().upsertConsole(created);
  rememberRecentFolder(cwd);
  // Let React Flow mount and measure the node before flying to it
  window.setTimeout(() => void flyTo(created.id), 60);
}

// "Spawn 4": a 2x2 block of consoles in one folder, placed as a unit so the grid stays intact
export async function createAgentGrid(
  cwd: string,
  columns = 2,
  rows = 2,
  options: { worktree?: boolean; accountId?: string } = {},
): Promise<void> {
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
    const c = await api.createConsole({
      cwd,
      layout,
      ...(options.worktree ? { worktree: true } : {}),
      ...(options.accountId && options.accountId !== 'auto' ? { accountId: options.accountId } : {}),
    });
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

// Sends a line to a console as if typed. Goes through the server, which pastes the text, waits
// for Claude Code to take the paste in, presses Enter and re-presses it once if nothing submitted.
export function sendLine(id: string, text: string): void {
  api.sendText(id, text).catch((error: Error) => {
    const name = useBoard.getState().consoles[id]?.name ?? 'the console';
    useBoard.getState().toast(`Could not send to ${name}: ${error.message}`);
  });
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

// ---------- browser tile layouts (same debounce as consoles) ----------

const pendingBrowserLayouts = new Map<string, Partial<ConsoleLayout>>();
const browserTimers = new Map<string, number>();

export function persistBrowserLayout(id: string, layout: Partial<ConsoleLayout>): void {
  const rounded = Object.fromEntries(
    Object.entries(layout).map(([key, value]) => [key, Math.round(value as number)]),
  ) as Partial<ConsoleLayout>;
  const board = useBoard.getState();
  const prev = board.browsers[id];
  if (!prev) return;
  board.upsertBrowser({ ...prev, layout: { ...prev.layout, ...rounded } });
  pendingBrowserLayouts.set(id, { ...pendingBrowserLayouts.get(id), ...rounded });
  window.clearTimeout(browserTimers.get(id));
  browserTimers.set(
    id,
    window.setTimeout(() => {
      const pending = pendingBrowserLayouts.get(id);
      pendingBrowserLayouts.delete(id);
      browserTimers.delete(id);
      if (!pending || !useBoard.getState().browsers[id]) return;
      api.updateBrowser(id, { layout: pending }).catch(() => {
        useBoard.getState().toast('Could not save the layout. Is the server still running?');
      });
    }, 300),
  );
}

// Persist a layout for any board item (console or browser tile)
export function persistItemLayout(id: string, layout: Partial<ConsoleLayout>): void {
  const { consoles, browsers } = useBoard.getState();
  if (consoles[id]) persistLayout(id, layout);
  else if (browsers[id]) persistBrowserLayout(id, layout);
}

// ---------- visibility and selection ----------

// Consoles of a closed project are hidden from the board (their processes are stopped)
export function isHiddenConsole(c: ConsoleInfo, projects: Record<string, Project>): boolean {
  const project = c.projectId ? projects[c.projectId] : undefined;
  return !!project && !project.open;
}

// Every console and browser tile currently on the board, as rects
export function boardItems(): ArrangeItem[] {
  const { consoles, browsers, projects } = useBoard.getState();
  const items: ArrangeItem[] = [];
  for (const c of Object.values(consoles)) {
    if (!isHiddenConsole(c, projects)) items.push({ id: c.id, rect: { ...c.layout } });
  }
  for (const b of Object.values(browsers)) items.push({ id: b.id, rect: { ...b.layout } });
  return items;
}

export function selectAll(): void {
  useBoard.getState().setSelectedIds(boardItems().map((i) => i.id));
}

export function clearSelection(): void {
  useBoard.getState().setSelectedIds([]);
}

// The selection, or everything when fewer than two items are selected
function targetItems(): ArrangeItem[] {
  const all = boardItems();
  const selected = new Set(useBoard.getState().selectedIds);
  const picked = all.filter((i) => selected.has(i.id));
  return picked.length >= 2 ? picked : all;
}

// ---------- arranging ----------

let animationTimer: number | undefined;

// Move/resize many items at once with a short glide (never used while dragging)
export function applyLayouts(layouts: Layouts, animate = true): void {
  if (!layouts.size) return;
  const ui = useBoardUi.getState();
  if (animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    ui.setAnimating(true);
    window.clearTimeout(animationTimer);
    animationTimer = window.setTimeout(() => useBoardUi.getState().setAnimating(false), 320);
  }
  for (const [id, rect] of layouts) persistItemLayout(id, rect);
}

function overlapsAny(layouts: Layouts): boolean {
  const rects = [...layouts.values()];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y)
        return true;
    }
  }
  return false;
}

export function arrangeBoard(mode: ArrangeMode): void {
  const items = targetItems();
  if (!items.length) return;
  const { prefs } = useBoardUi.getState();
  const options = { columns: prefs.columns, gap: prefs.gap };
  if (mode !== 'project') {
    applyLayouts(arrange(items, mode, options));
    return;
  }
  const { consoles, projects } = useBoard.getState();
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups: ProjectGroup[] = [];
  const used = new Set<string>();
  const openProjects = Object.values(projects)
    .filter((p) => p.open)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const p of openProjects) {
    const members = p.consoleIds.map((id) => byId.get(id)).filter((i): i is ArrangeItem => !!i);
    members.forEach((m) => used.add(m.id));
    if (members.length) groups.push({ key: p.id, items: members });
  }
  // Loose consoles and browser tiles share one unframed block, ordered by folder
  const loose = items
    .filter((i) => !used.has(i.id))
    .sort((a, b) => (consoles[a.id]?.cwd ?? '~').localeCompare(consoles[b.id]?.cwd ?? '~'));
  if (loose.length) groups.push({ key: null, items: loose });
  applyLayouts(tidyByProject(groups, options));
}

export function makeSameSize(preset?: keyof typeof SIZE_PRESETS): void {
  const items = targetItems();
  const sized = sameSize(items, preset ? SIZE_PRESETS[preset] : undefined);
  if (!sized.size) return;
  // Growing can make neighbours overlap; re-grid them in reading order when that happens
  if (overlapsAny(sized)) {
    const { prefs } = useBoardUi.getState();
    const resized = items.map((i) => ({ id: i.id, rect: sized.get(i.id) ?? i.rect }));
    applyLayouts(arrange(resized, 'grid', { columns: prefs.columns, gap: prefs.gap }));
  } else {
    applyLayouts(sized);
  }
}

// ---------- projects ----------

export function nextProjectName(): string {
  const projects = Object.values(useBoard.getState().projects);
  const names = new Set(projects.map((p) => p.name));
  let n = projects.length + 1;
  while (names.has(`Project ${n}`)) n++;
  return `Project ${n}`;
}

export async function groupSelection(name: string): Promise<boolean> {
  const { selectedIds, consoles, upsertProject, toast } = useBoard.getState();
  const consoleIds = selectedIds.filter((id) => consoles[id]);
  if (!consoleIds.length) {
    toast('Select one or more consoles to group them.');
    return false;
  }
  try {
    const project = await api.createProject({ name: name.trim() || nextProjectName(), consoleIds });
    upsertProject(project);
    // Reflect membership right away; the server echoes confirm it
    const board = useBoard.getState();
    for (const p of Object.values(board.projects)) {
      if (p.id === project.id) continue;
      const left = p.consoleIds.filter((id) => !consoleIds.includes(id));
      if (left.length !== p.consoleIds.length) board.upsertProject({ ...p, consoleIds: left });
    }
    for (const id of consoleIds) {
      const c = useBoard.getState().consoles[id];
      if (c && c.projectId !== project.id)
        useBoard.getState().upsertConsole({ ...c, projectId: project.id });
    }
    return true;
  } catch (error) {
    toast(`Could not create the project: ${(error as Error).message}`);
    return false;
  }
}

// ---------- kill (stop and remove consoles / browser tiles) ----------

// The multi-selection, or else the focused console/tile
export function killTargets(): { consoles: string[]; browsers: string[] } {
  const { selectedIds, selectedId, consoles, browsers } = useBoard.getState();
  const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
  return {
    consoles: ids.filter((id) => consoles[id]),
    browsers: ids.filter((id) => browsers[id]),
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function askKill(): void {
  const targets = killTargets();
  const total = targets.consoles.length + targets.browsers.length;
  if (!total) return;
  const parts: string[] = [];
  if (targets.consoles.length) {
    parts.push(
      `Stops the Claude process and removes ${plural(targets.consoles.length, 'terminal')} from the board. Conversations can still be resumed later with claude --resume.`,
    );
  }
  const branched = targets.consoles.filter((id) => useBoard.getState().consoles[id]?.git).length;
  if (branched) {
    parts.push(
      `Git worktrees and branches are kept (${plural(branched, 'agent')} on its own branch); delete them with Review > Discard branch.`,
    );
  }
  if (targets.browsers.length) {
    parts.push(`Closes ${plural(targets.browsers.length, 'browser tile')}.`);
  }
  useBoard.getState().askConfirm({
    title: total === 1 ? 'Kill this item?' : `Kill ${total} items?`,
    message: parts.join(' '),
    confirmLabel: total === 1 ? 'Kill' : `Kill ${total}`,
    danger: true,
    onConfirm: async () => {
      await Promise.all([
        ...targets.consoles.map((id) => closeConsole(id)),
        ...targets.browsers.map((id) =>
          api
            .deleteBrowser(id)
            .then(() => useBoard.getState().removeBrowser(id))
            .catch((error: Error) => useBoard.getState().toast(`Close failed: ${error.message}`)),
        ),
      ]);
      const board = useBoard.getState();
      board.setSelectedIds([]);
      if (board.selectedId && (targets.consoles.includes(board.selectedId) || targets.browsers.includes(board.selectedId)))
        board.select(null);
    },
  });
}
