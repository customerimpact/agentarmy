import { useSyncExternalStore } from 'react';
import { getDrawVoicePrefs } from '../draw-voice-prefs';
import { createEngine } from './engines';
import { DictationController, type DictationState } from './machine';

// One dictation session at a time for the whole page; the command bar registers itself as the sink

export const dictation = new DictationController({
  createEngine: () => {
    const prefs = getDrawVoicePrefs();
    return createEngine(prefs.dictationEngine, prefs.whisperModel);
  },
  language: () => getDrawVoicePrefs().dictationLanguage,
  voiceSend: () => getDrawVoicePrefs().voiceSend,
  // Let React render the final text before the command bar's send() reads it
  schedule: (fn) => window.setTimeout(fn, 30),
});

export function useDictation(): DictationState {
  return useSyncExternalStore(
    (cb) => dictation.subscribe(cb),
    () => dictation.state,
    () => dictation.state,
  );
}
