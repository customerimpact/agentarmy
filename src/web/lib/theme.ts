import { useSyncExternalStore } from 'react';
import type { ITheme } from '@xterm/xterm';

// Color themes. The CSS side lives in styles.css as [data-theme='<id>'] token overrides on <html>;
// this module owns the choice (persisted in localStorage) and the matching xterm palettes.

export type ThemeId = 'ember' | 'midnight' | 'aurora' | 'paper';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  dark: boolean;
  swatches: string[]; // canvas, surface, accent, then a couple of status colors, for preview chips
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm near-black with a Claude-orange glow',
    dark: true,
    swatches: ['#0c0a09', '#1d1917', '#e8774a', '#fbbf3c', '#5cc98f'],
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep navy ink with an electric cyan accent',
    dark: true,
    swatches: ['#060a14', '#121b2e', '#3cc4ff', '#ffc94d', '#7c6cff'],
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Polar night with drifting green and violet light',
    dark: true,
    swatches: ['#05090b', '#111b1c', '#4fe3b5', '#b294ff', '#ffd166'],
  },
  {
    id: 'paper',
    name: 'Paper',
    description: 'Clean light canvas with indigo ink, for daylight',
    dark: false,
    swatches: ['#f4f0e8', '#ffffff', '#4f46e5', '#d97706', '#15803d'],
  },
];

export const DEFAULT_THEME: ThemeId = 'ember';
export const THEME_STORAGE_KEY = 'agentarmy.theme';

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.has(value);
}

function readStored(): ThemeId {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // private mode / blocked storage
  }
}

let current: ThemeId = readStored();
const listeners = new Set<() => void>();

function apply(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = id;
  const info = THEMES.find((t) => t.id === id)!;
  root.style.colorScheme = info.dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', info.swatches[0]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', info.dark ? 'dark' : 'light');
}

export function getTheme(): ThemeId {
  return current;
}

export function setTheme(id: ThemeId): void {
  if (!isThemeId(id)) return;
  current = id;
  apply(id);
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // keep the choice for this tab only
  }
  for (const listener of listeners) listener();
}

// Next theme in THEMES order (used by the Shift+T test shortcut)
export function cycleTheme(direction: 1 | -1 = 1): ThemeId {
  const index = THEMES.findIndex((t) => t.id === current);
  const next = THEMES[(index + direction + THEMES.length) % THEMES.length].id;
  setTheme(next);
  return next;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

// Applies the saved theme; call before the first render (index.html also does it pre-paint)
export function initTheme(): void {
  current = readStored();
  apply(current);
}

// ---------- Terminal palettes ----------

const EMBER: ITheme = {
  background: '#100e0d',
  foreground: '#e9e2da',
  cursor: '#f08a5d',
  cursorAccent: '#100e0d',
  selectionBackground: 'rgba(232, 119, 74, 0.34)',
  selectionInactiveBackground: 'rgba(232, 119, 74, 0.18)',
  scrollbarSliderBackground: 'rgba(255, 230, 210, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 230, 210, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(255, 230, 210, 0.24)',
  black: '#1f1a17',
  red: '#f2666d',
  green: '#7fcf8c',
  yellow: '#f5bd55',
  blue: '#6fa6f5',
  magenta: '#d38ad6',
  cyan: '#5ccfc4',
  white: '#d6cec6',
  brightBlack: '#6e635b',
  brightRed: '#ff8a86',
  brightGreen: '#a2e2a8',
  brightYellow: '#ffd88a',
  brightBlue: '#9cc2ff',
  brightMagenta: '#e9b0ea',
  brightCyan: '#8ce6dc',
  brightWhite: '#faf6f1',
};

const MIDNIGHT: ITheme = {
  background: '#080d19',
  foreground: '#dce6f5',
  cursor: '#5fd0ff',
  cursorAccent: '#080d19',
  selectionBackground: 'rgba(60, 196, 255, 0.30)',
  selectionInactiveBackground: 'rgba(60, 196, 255, 0.16)',
  scrollbarSliderBackground: 'rgba(200, 225, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(200, 225, 255, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(200, 225, 255, 0.24)',
  black: '#151d2e',
  red: '#ff6b81',
  green: '#5fe0a0',
  yellow: '#ffd166',
  blue: '#5ea8ff',
  magenta: '#c49bff',
  cyan: '#4fd6f0',
  white: '#c8d3e4',
  brightBlack: '#5a6782',
  brightRed: '#ff94a4',
  brightGreen: '#8cf0bf',
  brightYellow: '#ffe197',
  brightBlue: '#93c6ff',
  brightMagenta: '#dcc0ff',
  brightCyan: '#8ce9fa',
  brightWhite: '#f4f8ff',
};

const AURORA: ITheme = {
  background: '#070c0d',
  foreground: '#dcefe8',
  cursor: '#6ef0c6',
  cursorAccent: '#070c0d',
  selectionBackground: 'rgba(79, 227, 181, 0.28)',
  selectionInactiveBackground: 'rgba(79, 227, 181, 0.15)',
  scrollbarSliderBackground: 'rgba(210, 255, 240, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(210, 255, 240, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(210, 255, 240, 0.24)',
  black: '#142020',
  red: '#ff6f8e',
  green: '#5ee3a6',
  yellow: '#f3d36b',
  blue: '#6aaeff',
  magenta: '#bb98ff',
  cyan: '#4fd9d0',
  white: '#cbdcd6',
  brightBlack: '#587069',
  brightRed: '#ff9bb0',
  brightGreen: '#93f2c6',
  brightYellow: '#fbe59c',
  brightBlue: '#9ccaff',
  brightMagenta: '#d6c0ff',
  brightCyan: '#8cece5',
  brightWhite: '#f3fbf8',
};

// Paper keeps a dark "ink" terminal: Claude Code's dark-theme truecolor output stays readable,
// and a dark slab reads as a clear console card on the light canvas.
const PAPER: ITheme = {
  background: '#1b1a22',
  foreground: '#ebe8e2',
  cursor: '#a5a1ff',
  cursorAccent: '#1b1a22',
  selectionBackground: 'rgba(129, 120, 255, 0.36)',
  selectionInactiveBackground: 'rgba(129, 120, 255, 0.18)',
  scrollbarSliderBackground: 'rgba(235, 232, 226, 0.12)',
  scrollbarSliderHoverBackground: 'rgba(235, 232, 226, 0.20)',
  scrollbarSliderActiveBackground: 'rgba(235, 232, 226, 0.26)',
  black: '#2a2833',
  red: '#ff7078',
  green: '#78d89a',
  yellow: '#f2c35f',
  blue: '#7aa6ff',
  magenta: '#c99af5',
  cyan: '#62d2d0',
  white: '#d5d1ca',
  brightBlack: '#6f6b7a',
  brightRed: '#ff979c',
  brightGreen: '#a0e8b8',
  brightYellow: '#ffdb8f',
  brightBlue: '#a6c3ff',
  brightMagenta: '#e0bdfa',
  brightCyan: '#93e6e3',
  brightWhite: '#faf8f4',
};

const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  ember: EMBER,
  midnight: MIDNIGHT,
  aurora: AURORA,
  paper: PAPER,
};

export function terminalTheme(id: ThemeId): ITheme {
  return TERMINAL_THEMES[id] ?? EMBER;
}
