// UI-only board state that is not part of the server contract: snap guides while dragging,
// the arrange animation flag, the inline "Group as project" prompt and arrange preferences.
import { create } from 'zustand';
import type { ColumnsSetting, SizePreset } from './arrange';
import type { Guide } from './snap';

export interface ArrangePrefs {
  columns: ColumnsSetting;
  gap: number;
  size: SizePreset | 'common';
  snap: boolean;
}

const PREFS_KEY = 'agentarmy.arrange';
const DEFAULT_PREFS: ArrangePrefs = { columns: 'auto', gap: 40, size: 'common', snap: true };

function loadPrefs(): ArrangePrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ArrangePrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface BoardUi {
  guides: Guide[];
  animating: boolean;
  groupPromptOpen: boolean;
  prefs: ArrangePrefs;
  setGuides: (guides: Guide[]) => void;
  setAnimating: (animating: boolean) => void;
  setGroupPromptOpen: (open: boolean) => void;
  setPrefs: (prefs: Partial<ArrangePrefs>) => void;
}

export const useBoardUi = create<BoardUi>((set, get) => ({
  guides: [],
  animating: false,
  groupPromptOpen: false,
  prefs: loadPrefs(),
  setGuides: (guides) => {
    if (guides.length === 0 && get().guides.length === 0) return;
    set({ guides });
  },
  setAnimating: (animating) => set({ animating }),
  setGroupPromptOpen: (groupPromptOpen) => set({ groupPromptOpen }),
  setPrefs: (partial) => {
    const prefs = { ...get().prefs, ...partial };
    set({ prefs });
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // private mode / blocked storage: keep the preference for this tab only
    }
  },
}));

// Project colors come from the theme (--aa-project-<color>); hex fallbacks keep frames visible
const PROJECT_HEX: Record<string, string> = {
  orange: '#ff7a45',
  amber: '#f5a524',
  rose: '#f43f5e',
  violet: '#8b5cf6',
  blue: '#4c8dff',
  teal: '#14b8a6',
  green: '#2fbf71',
};

export function projectColor(color: string | undefined): string {
  const key = color && PROJECT_HEX[color] ? color : 'orange';
  return `var(--aa-project-${key}, ${PROJECT_HEX[key]})`;
}
