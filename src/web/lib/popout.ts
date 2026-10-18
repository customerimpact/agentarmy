import { create } from 'zustand';
import { usePrefs } from './prefs';
import { useBoard } from './store';
import { THEME_STORAGE_KEY, isThemeId, setTheme } from './theme';
import { popoutFeatures, popoutKey, viewUrl, type PopoutView } from './views';

// Pop-out windows talk to each other over BroadcastChannel('agentarmy'):
// - a pop-out says 'here' when it opens (and every few seconds), 'gone' when it closes
// - the board asks 'who' on load, so pop-outs that outlived a board reload re-announce
// - 'bring-back' asks the pop-out with that key to close itself
// The board dims consoles that live in another window, so two windows never fight over the
// size of one terminal (the PTY can only have one size).

export const CHANNEL_NAME = 'agentarmy';
const HEARTBEAT_MS = 4000;
const EXPIRE_MS = 11_000;
const PREFS_STORAGE_KEY = 'agentarmy.prefs'; // see prefs.ts

export type PopoutMessage =
  | { type: 'here'; key: string; view: PopoutView }
  | { type: 'gone'; key: string }
  | { type: 'who' }
  | { type: 'bring-back'; key: string };

interface PopoutStore {
  open: Record<string, { view: PopoutView; seen: number }>;
}

export const usePopouts = create<PopoutStore>(() => ({ open: {} }));

let channel: BroadcastChannel | null = null;
const handlers = new Set<(message: PopoutMessage) => void>();

function getChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<PopoutMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    for (const handler of handlers) handler(message);
  };
  return channel;
}

function post(message: PopoutMessage): void {
  try {
    getChannel()?.postMessage(message);
  } catch {
    // channel closed while the page unloads
  }
}

function mark(key: string, view: PopoutView): void {
  usePopouts.setState((s) => ({ open: { ...s.open, [key]: { view, seen: Date.now() } } }));
}

function unmark(key: string): void {
  usePopouts.setState((s) => {
    if (!s.open[key]) return s;
    const open = { ...s.open };
    delete open[key];
    return { open };
  });
}

// Pop-out window keys that hold a console: its own window, or its project's window
export function popoutKeysFor(consoleId: string, projectId: string | null | undefined): string[] {
  const keys = [popoutKey({ kind: 'console', id: consoleId })];
  if (projectId) keys.push(popoutKey({ kind: 'project', id: projectId }));
  return keys;
}

// The key of the other window showing this console, or null when it lives here
export function usePoppedOut(consoleId: string, options: { includeProject?: boolean } = {}): string | null {
  const { includeProject = true } = options;
  const projectId = useBoard((s) => (includeProject ? (s.consoles[consoleId]?.projectId ?? null) : null));
  return usePopouts((s) => popoutKeysFor(consoleId, projectId).find((key) => s.open[key]) ?? null);
}

export function useProjectPoppedOut(projectId: string): boolean {
  return usePopouts((s) => !!s.open[popoutKey({ kind: 'project', id: projectId })]);
}

// ---------- opening and closing (any window) ----------

const refs = new Map<string, Window>();

export function openPopout(view: PopoutView): void {
  const key = popoutKey(view);
  const existing = refs.get(key);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }
  // An empty URL returns the window with this name if it is still open, without reloading it
  const win = window.open('', key, popoutFeatures(view, window.screen));
  if (!win) {
    useBoard.getState().toast('The pop-up was blocked. Allow pop-ups for this site and try again.');
    return;
  }
  refs.set(key, win);
  let blank = true;
  try {
    blank = win.location.href === 'about:blank';
  } catch {
    blank = false;
  }
  if (blank) win.location.href = new URL(viewUrl(view), window.location.origin).href;
  if (view.kind !== 'focus') mark(key, view);
  win.focus();
}

export function bringBack(key: string): void {
  post({ type: 'bring-back', key });
  const win = refs.get(key);
  refs.delete(key);
  try {
    win?.close();
  } catch {
    // not ours to close
  }
  unmark(key);
}

// ---------- the main board ----------

let started = false;
let syncing = false;

export function startPopoutTracking(): void {
  if (started) return;
  started = true;
  handlers.add((message) => {
    if (message.type === 'here' && message.view.kind !== 'focus') mark(message.key, message.view);
    else if (message.type === 'gone') unmark(message.key);
  });
  getChannel();
  post({ type: 'who' });
  // A pop-out that crashed never says 'gone'; drop it once its heartbeat stops
  window.setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of Object.entries(usePopouts.getState().open)) {
      const ref = refs.get(key);
      if (ref?.closed || (now - entry.seen > EXPIRE_MS && !(ref && !ref.closed))) {
        refs.delete(key);
        unmark(key);
      }
    }
  }, 2000);
}

// ---------- inside a pop-out window ----------

export function startPopoutPresence(view: PopoutView): void {
  if (started) return;
  started = true;
  const key = popoutKey(view);
  // Name the window so a later window.open(…, key) from the board finds it
  try {
    window.name = key;
  } catch {
    // ignore
  }
  const announce = () => post({ type: 'here', key, view });
  handlers.add((message) => {
    if (message.type === 'who') announce();
    else if (message.type === 'bring-back' && message.key === key) {
      window.close();
      // Opened by hand (not by the board): scripts may not close it, so go to the board instead
      window.setTimeout(() => window.location.assign('/'), 300);
    }
  });
  getChannel();
  announce();
  window.setInterval(announce, HEARTBEAT_MS);
  window.addEventListener('pagehide', () => post({ type: 'gone', key }));
}

// ---------- shared look ----------

// Theme and board/terminal prefs live in localStorage; follow changes made in other windows
export function syncPrefsAcrossWindows(): void {
  if (syncing) return;
  syncing = true;
  window.addEventListener('storage', (e) => {
    if (e.storageArea !== window.localStorage || e.newValue === null) return;
    if (e.key === THEME_STORAGE_KEY && isThemeId(e.newValue)) setTheme(e.newValue);
    if (e.key === PREFS_STORAGE_KEY) {
      try {
        usePrefs.getState().setPrefs(JSON.parse(e.newValue));
      } catch {
        // malformed value from another version: ignore
      }
    }
  });
}
