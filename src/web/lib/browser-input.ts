import type { BrowserInputEvent, BrowserTile, ConsoleLayout } from '../../shared/protocol';
import { api } from './api';
import { socket } from './socket';
import { useBoard } from './store';

export * from './browser-geometry';

export function sendBrowserInput(id: string, event: BrowserInputEvent): void {
  socket.send({ type: 'browser-input', id, event });
}

// Creates a browser tile on the board (optionally driven by a console) and selects it
export async function openBrowserTile(url?: string, linkedConsoleId?: string): Promise<BrowserTile | null> {
  try {
    const tile = await api.createBrowser({
      ...(url ? { url } : {}),
      ...(linkedConsoleId ? { linkedConsoleId } : {}),
    });
    useBoard.getState().upsertBrowser(tile);
    return tile;
  } catch (err) {
    useBoard.getState().toast(`Could not open a browser: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const pending = new Map<string, Partial<ConsoleLayout>>();
const timers = new Map<string, number>();

// Debounced layout save for browser tiles (drag end / resize end)
export function persistBrowserLayout(id: string, layout: Partial<ConsoleLayout>): void {
  const rounded = Object.fromEntries(
    Object.entries(layout).map(([k, v]) => [k, Math.round(v as number)]),
  ) as Partial<ConsoleLayout>;
  const tile = useBoard.getState().browsers[id];
  if (tile) useBoard.getState().upsertBrowser({ ...tile, layout: { ...tile.layout, ...rounded } });
  pending.set(id, { ...pending.get(id), ...rounded });
  window.clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => {
      const next = pending.get(id);
      pending.delete(id);
      timers.delete(id);
      if (!next || !useBoard.getState().browsers[id]) return;
      api.updateBrowser(id, { layout: next }).catch(() => undefined);
    }, 300),
  );
}
