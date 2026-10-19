import type { BoardItem, BoardItemKind, Workspace } from '../../shared/protocol';
import { boardItems, getFlowInstance, switchWorkspace } from './board-actions';
import { itemsApi, useItems, workspaceOf, workspacesApi } from './items';
import { useBoard } from './store';

export const ITEM_SIZE: Record<BoardItemKind, { width: number; height: number }> = {
  note: { width: 280, height: 220 },
  checklist: { width: 320, height: 340 },
  kanban: { width: 780, height: 440 },
  file: { width: 560, height: 420 },
};

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Nearest free spot to the center of the view: scans rings of item-sized cells around it
function freeSpotNearCenter(size: { width: number; height: number }): { x: number; y: number } {
  const flow = getFlowInstance();
  const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
  const center =
    flow && rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
  const taken = boardItems().map((i) => ({ x: i.rect.x - 16, y: i.rect.y - 16, width: i.rect.width + 32, height: i.rect.height + 32 }));
  const origin = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
  const stepX = size.width / 2 + 16;
  const stepY = size.height / 2 + 16;
  for (let ring = 0; ring < 30; ring++) {
    const cells: { x: number; y: number }[] = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) cells.push({ x: origin.x + dx * stepX, y: origin.y + dy * stepY });
      }
    }
    cells.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y));
    const free = cells.find((c) => !taken.some((t) => overlaps({ ...c, ...size }, t)));
    if (free) return { x: Math.round(free.x), y: Math.round(free.y) };
  }
  return { x: Math.round(origin.x), y: Math.round(origin.y) };
}

// Pan (same zoom) so a new item is fully on screen
function revealRect(r: { x: number; y: number; width: number; height: number }): void {
  const flow = getFlowInstance();
  const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
  if (!flow || !rect) return;
  const topLeft = flow.screenToFlowPosition({ x: rect.left + 40, y: rect.top + 60 });
  const bottomRight = flow.screenToFlowPosition({ x: rect.right - 40, y: rect.bottom - 140 });
  const inside = r.x >= topLeft.x && r.y >= topLeft.y && r.x + r.width <= bottomRight.x && r.y + r.height <= bottomRight.y;
  if (inside) return;
  const { zoom } = flow.getViewport();
  void flow.setCenter(r.x + r.width / 2, r.y + r.height / 2 + 40 / zoom, { zoom, duration: 250 });
}

// Creates an item on the visible workspace; `at` is a board (flow) position for its top-left
export async function createBoardItem(
  kind: BoardItemKind,
  options: { at?: { x: number; y: number }; data?: Record<string, unknown> } = {},
): Promise<BoardItem | null> {
  const size = ITEM_SIZE[kind];
  const pos = options.at ? { x: Math.round(options.at.x), y: Math.round(options.at.y) } : freeSpotNearCenter(size);
  try {
    const item = await itemsApi.create({
      kind,
      layout: { ...pos, ...size },
      workspaceId: useItems.getState().activeWorkspaceId,
      ...(options.data ? { data: options.data } : {}),
    });
    useItems.getState().upsertItem(item);
    if (!options.at) revealRect(item.layout);
    const board = useBoard.getState();
    board.setSelectedIds([item.id]);
    board.select(null);
    return item;
  } catch (error) {
    useBoard.getState().toast(`Could not add the ${kind}: ${(error as Error).message}`);
    return null;
  }
}

// ---------- workspace tab actions ----------

export async function newWorkspace(): Promise<void> {
  try {
    const ws = await workspacesApi.create();
    const store = useItems.getState();
    // The server made it active; keep our list in sync before switching the view
    if (!store.workspaces.some((w) => w.id === ws.id)) store.setWorkspaces([...store.workspaces, ws], store.activeWorkspaceId);
    await switchWorkspace(ws.id);
  } catch (error) {
    useBoard.getState().toast(`Could not add a workspace: ${(error as Error).message}`);
  }
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const store = useItems.getState();
  store.setWorkspaces(store.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w)), store.activeWorkspaceId);
  await workspacesApi.update(id, { name: trimmed }).catch((e: Error) => useBoard.getState().toast(`Rename failed: ${e.message}`));
}

export async function reorderWorkspaces(ids: string[]): Promise<void> {
  const store = useItems.getState();
  const byId = new Map(store.workspaces.map((w) => [w.id, w]));
  store.setWorkspaces(
    ids.map((id, order) => ({ ...byId.get(id)!, order })),
    store.activeWorkspaceId,
  );
  await workspacesApi.reorder(ids).catch(() => undefined);
}

// What lives on a workspace (consoles, browser tiles, items; projects move with their consoles)
export function workspaceContents(id: string): { consoles: number; browsers: number; items: number; total: number } {
  const { consoles, browsers } = useBoard.getState();
  const consolesN = Object.values(consoles).filter((c) => workspaceOf(c) === id).length;
  const browsersN = Object.values(browsers).filter((b) => workspaceOf(b) === id).length;
  const itemsN = Object.values(useItems.getState().items).filter((i) => i.workspaceId === id).length;
  return { consoles: consolesN, browsers: browsersN, items: itemsN, total: consolesN + browsersN + itemsN };
}

export async function deleteWorkspace(id: string, moveTo?: string): Promise<void> {
  const store = useItems.getState();
  if (store.workspaces.length <= 1) return;
  try {
    if (store.activeWorkspaceId === id) {
      const next = moveTo ?? store.workspaces.find((w) => w.id !== id)!.id;
      await switchWorkspace(next);
    }
    await workspacesApi.remove(id, moveTo);
    const after = useItems.getState();
    after.setWorkspaces(after.workspaces.filter((w) => w.id !== id), after.activeWorkspaceId);
  } catch (error) {
    useBoard.getState().toast(`Could not close the workspace: ${(error as Error).message}`);
  }
}

// Move consoles / projects / tiles / items to another workspace (the view stays where it is)
export async function moveToWorkspace(
  target: Workspace['id'],
  ids: { consoleIds?: string[]; projectIds?: string[]; browserIds?: string[]; itemIds?: string[] },
): Promise<void> {
  try {
    await workspacesApi.move(target, ids);
    const name = useItems.getState().workspaces.find((w) => w.id === target)?.name ?? 'the workspace';
    const n = (ids.consoleIds?.length ?? 0) + (ids.browserIds?.length ?? 0) + (ids.itemIds?.length ?? 0) + (ids.projectIds?.length ?? 0);
    useBoard.getState().setSelectedIds([]);
    useBoard.getState().toast(`Moved ${n === 1 ? '1 thing' : `${n} things`} to ${name}`);
  } catch (error) {
    useBoard.getState().toast(`Move failed: ${(error as Error).message}`);
  }
}

// The current multi-selection split by type, for "Move to workspace…"
export function selectionForMove(): { consoleIds: string[]; browserIds: string[]; itemIds: string[] } {
  const { selectedIds, selectedId, consoles, browsers } = useBoard.getState();
  const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
  const items = useItems.getState().items;
  return {
    consoleIds: ids.filter((id) => consoles[id]),
    browserIds: ids.filter((id) => browsers[id]),
    itemIds: ids.filter((id) => items[id]),
  };
}
