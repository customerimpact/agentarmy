import { useBoard } from './store';

// A recipe opened as http://127.0.0.1:<port>/#recipe=<code> (from gridhive.dev/r). The code is kept
// in sessionStorage so it survives the "missing token" page, and the hash is removed right away.

const KEY = 'gridhive.pendingRecipe';

export function captureRecipeHash(): void {
  const match = /^#recipe=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!match) return;
  try {
    sessionStorage.setItem(KEY, match[1]);
  } catch {
    // private window: the import just won't open
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function openPendingRecipe(): void {
  let code: string | null = null;
  try {
    code = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (code) useBoard.getState().openRecipeImport(code);
}
