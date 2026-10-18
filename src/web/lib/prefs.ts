import { create } from 'zustand';
import type { SizePreset } from './arrange';

// Per-browser preferences from the Settings tab (stored in localStorage, never sent to the server).
// Theme, sound on/off and arrange/snap live in their own modules (theme.ts, notify.ts, board-ui.ts).

export type DefaultSidebarTab = 'agents' | 'actions' | 'progress' | 'settings';

export interface Prefs {
  soundVolume: number; // 0..1
  termFontSize: number; // 11..18
  termLineHeight: number; // 1.0..1.6
  termCursorBlink: boolean;
  termScrollback: number; // lines
  gridSize: number; // snap grid in board px
  defaultSize: SizePreset; // size of a new console
  showMinimap: boolean;
  reduceMotion: boolean;
  defaultSidebarTab: DefaultSidebarTab;
}

export const DEFAULT_PREFS: Prefs = {
  soundVolume: 0.7,
  termFontSize: 13,
  termLineHeight: 1.15,
  termCursorBlink: true,
  termScrollback: 5000,
  gridSize: 20,
  defaultSize: 'M',
  showMinimap: true,
  reduceMotion: false,
  defaultSidebarTab: 'agents',
};

export const PREF_LIMITS = {
  termFontSize: { min: 11, max: 18, step: 1 },
  termLineHeight: { min: 1, max: 1.6, step: 0.05 },
  termScrollback: { min: 500, max: 50_000, step: 500 },
  gridSize: { min: 4, max: 80, step: 4 },
  soundVolume: { min: 0, max: 1, step: 0.05 },
} as const;

const KEY = 'agentarmy.prefs';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function sanitize(raw: Partial<Prefs>): Prefs {
  const p = { ...DEFAULT_PREFS, ...raw };
  const num = (key: keyof typeof PREF_LIMITS, value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
      ? clamp(value, PREF_LIMITS[key].min, PREF_LIMITS[key].max)
      : (DEFAULT_PREFS[key] as number);
  return {
    soundVolume: num('soundVolume', p.soundVolume),
    termFontSize: Math.round(num('termFontSize', p.termFontSize)),
    termLineHeight: num('termLineHeight', p.termLineHeight),
    termCursorBlink: typeof p.termCursorBlink === 'boolean' ? p.termCursorBlink : DEFAULT_PREFS.termCursorBlink,
    termScrollback: Math.round(num('termScrollback', p.termScrollback)),
    gridSize: Math.round(num('gridSize', p.gridSize)),
    defaultSize: p.defaultSize === 'S' || p.defaultSize === 'L' ? p.defaultSize : 'M',
    showMinimap: typeof p.showMinimap === 'boolean' ? p.showMinimap : true,
    reduceMotion: p.reduceMotion === true,
    defaultSidebarTab: (['agents', 'actions', 'progress', 'settings'] as const).includes(p.defaultSidebarTab)
      ? p.defaultSidebarTab
      : 'agents',
  };
}

function load(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw) as Partial<Prefs>) : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function applyToDocument(prefs: Prefs): void {
  if (typeof document === 'undefined') return;
  // styles.css turns animations and transitions off under this attribute
  if (prefs.reduceMotion) document.documentElement.dataset.reduceMotion = 'true';
  else delete document.documentElement.dataset.reduceMotion;
}

interface PrefsStore {
  prefs: Prefs;
  setPrefs: (partial: Partial<Prefs>) => void;
  resetPrefs: () => void;
}

export const usePrefs = create<PrefsStore>((set, get) => {
  const save = (prefs: Prefs) => {
    set({ prefs });
    applyToDocument(prefs);
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked: keep it for this tab only
    }
  };
  const initial = load();
  applyToDocument(initial);
  return {
    prefs: initial,
    setPrefs: (partial) => save(sanitize({ ...get().prefs, ...partial })),
    resetPrefs: () => save(DEFAULT_PREFS),
  };
});

export const getPrefs = (): Prefs => usePrefs.getState().prefs;

// Animations are off when the OS asks for it or the user turned on "Reduce motion"
export function prefersReducedMotion(): boolean {
  if (getPrefs().reduceMotion) return true;
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
