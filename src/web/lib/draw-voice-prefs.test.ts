import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAW_VOICE_PREFS, sanitizeDrawVoicePrefs } from './draw-voice-prefs';

describe('sanitizeDrawVoicePrefs', () => {
  it('keeps valid values and replaces junk with defaults', () => {
    expect(sanitizeDrawVoicePrefs(null)).toEqual(DEFAULT_DRAW_VOICE_PREFS);
    const p = sanitizeDrawVoicePrefs({
      drawColor: 'teal',
      showDrawings: false,
      dictationEngine: 'webspeech',
      dictationLanguage: 'xx' as never,
      holdToTalk: 'ctrl-space',
      whisperModel: 'huge' as never,
      voiceSend: 'yes' as never,
    });
    expect(p).toEqual({
      ...DEFAULT_DRAW_VOICE_PREFS,
      drawColor: 'teal',
      showDrawings: false,
      dictationEngine: 'webspeech',
      holdToTalk: 'ctrl-space',
    });
  });
});
