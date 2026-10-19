import { create } from 'zustand';
import { DRAW_COLORS, type DrawColor } from '../../shared/drawings';

// Per-browser preferences for drawings and voice dictation (localStorage, never sent to the server)

export type DictationEngineChoice = 'auto' | 'whisper' | 'webspeech';
export type DictationLanguage = 'auto' | 'en' | 'nl' | 'fr' | 'de';
export type HoldToTalk = 'space' | 'ctrl-space' | 'off';
export type WhisperModel = 'tiny' | 'base';

export interface DrawVoicePrefs {
  drawColor: DrawColor; // colour new shapes start with
  showDrawings: boolean;
  dictationEngine: DictationEngineChoice; // auto = on-device when the browser can, else browser speech
  dictationLanguage: DictationLanguage;
  holdToTalk: HoldToTalk;
  whisperModel: WhisperModel;
  voiceSend: boolean; // saying "... and send it" sends the message
}

export const DEFAULT_DRAW_VOICE_PREFS: DrawVoicePrefs = {
  drawColor: 'orange',
  showDrawings: true,
  dictationEngine: 'auto',
  dictationLanguage: 'auto',
  holdToTalk: 'space',
  whisperModel: 'tiny',
  voiceSend: true,
};

const KEY = 'agentarmy.drawVoicePrefs';

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

export function sanitizeDrawVoicePrefs(raw: Partial<DrawVoicePrefs> | null | undefined): DrawVoicePrefs {
  const d = DEFAULT_DRAW_VOICE_PREFS;
  const p = raw ?? {};
  return {
    drawColor: pick(p.drawColor, DRAW_COLORS, d.drawColor),
    showDrawings: typeof p.showDrawings === 'boolean' ? p.showDrawings : d.showDrawings,
    dictationEngine: pick(p.dictationEngine, ['auto', 'whisper', 'webspeech'] as const, d.dictationEngine),
    dictationLanguage: pick(p.dictationLanguage, ['auto', 'en', 'nl', 'fr', 'de'] as const, d.dictationLanguage),
    holdToTalk: pick(p.holdToTalk, ['space', 'ctrl-space', 'off'] as const, d.holdToTalk),
    whisperModel: pick(p.whisperModel, ['tiny', 'base'] as const, d.whisperModel),
    voiceSend: typeof p.voiceSend === 'boolean' ? p.voiceSend : d.voiceSend,
  };
}

function load(): DrawVoicePrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? sanitizeDrawVoicePrefs(JSON.parse(raw) as Partial<DrawVoicePrefs>) : DEFAULT_DRAW_VOICE_PREFS;
  } catch {
    return DEFAULT_DRAW_VOICE_PREFS;
  }
}

interface Store {
  prefs: DrawVoicePrefs;
  setPrefs: (partial: Partial<DrawVoicePrefs>) => void;
  reset: () => void;
}

export const useDrawVoicePrefs = create<Store>((set, get) => {
  const save = (prefs: DrawVoicePrefs) => {
    set({ prefs });
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked: this tab only
    }
  };
  return {
    prefs: load(),
    setPrefs: (partial) => save(sanitizeDrawVoicePrefs({ ...get().prefs, ...partial })),
    reset: () => save(DEFAULT_DRAW_VOICE_PREFS),
  };
});

export const getDrawVoicePrefs = () => useDrawVoicePrefs.getState().prefs;
