import { useState } from 'react';
import { Download } from 'lucide-react';
import { DRAW_COLORS } from '../../../shared/drawings';
import { useDrawVoicePrefs, type DictationEngineChoice, type DictationLanguage, type HoldToTalk, type WhisperModel } from '../../lib/draw-voice-prefs';
import { onDeviceSupported, preloadWhisper, resolveEngine, webSpeechSupported } from '../../lib/dictation/engines';
import { WHISPER_MODEL_MB } from '../../lib/dictation/whisper-protocol';
import { useDrawings } from '../../lib/drawing/store';
import type { SettingDef } from '../SettingsPanel';
import { colorVar } from '../../lib/drawing/colors';
import { Note, Segmented, Select, SmallButton, Toggle } from './fields';

// Settings rows for board drawings (Board section) and voice dictation (Voice section)

const set = useDrawVoicePrefs.getState().setPrefs;

function DrawColorControl() {
  const color = useDrawVoicePrefs((s) => s.prefs.drawColor);
  return (
    <div role="radiogroup" aria-label="Default drawing colour" className="flex flex-wrap gap-1.5">
      {DRAW_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={color === c}
          aria-label={c}
          title={c}
          onClick={() => {
            set({ drawColor: c });
            useDrawings.setState((s) => ({ style: { ...s.style, color: c } }));
          }}
          className={`size-6 rounded-full border-2 ${color === c ? 'border-fg' : 'border-transparent hover:border-line-strong'}`}
          style={{ background: colorVar(c) }}
        />
      ))}
    </div>
  );
}

function ShowDrawingsControl() {
  const show = useDrawVoicePrefs((s) => s.prefs.showDrawings);
  return <Toggle label="Show drawings" checked={show} onChange={(v) => set({ showDrawings: v })} />;
}

function EngineControl() {
  const engine = useDrawVoicePrefs((s) => s.prefs.dictationEngine);
  return (
    <Select<DictationEngineChoice>
      label="Dictation engine"
      value={engine}
      options={[
        { value: 'auto', label: 'Auto (on-device first)' },
        { value: 'whisper', label: 'On-device (private)' },
        { value: 'webspeech', label: 'Browser speech' },
      ]}
      onChange={(v) => set({ dictationEngine: v })}
    />
  );
}

function EngineBelow() {
  const engine = useDrawVoicePrefs((s) => s.prefs.dictationEngine);
  const model = useDrawVoicePrefs((s) => s.prefs.whisperModel);
  const [progress, setProgress] = useState<number | null | 'done' | 'error'>(null);
  const resolved = resolveEngine(engine);
  return (
    <>
      <Note>
        On-device runs Whisper in this browser: your voice never leaves the computer. The model (about {WHISPER_MODEL_MB[model]} MB) downloads
        once from Hugging Face and stays in the browser cache. Browser speech uses the browser’s own recognition; Chrome sends the audio to
        Google, and it does not work in the desktop app.
      </Note>
      {!resolved && (
        <Note tone="warn">
          {engine === 'webspeech' && !webSpeechSupported()
            ? 'This browser has no speech recognition. Pick On-device.'
            : !onDeviceSupported()
              ? 'This browser cannot record audio here (microphone access needs localhost or https).'
              : 'Dictation is not available in this browser.'}
        </Note>
      )}
      {resolved === 'whisper' && (
        <div className="mt-2 flex items-center gap-3">
          <SmallButton
            testId="dictation-preload"
            disabled={typeof progress === 'number'}
            onClick={() => {
              setProgress(0);
              preloadWhisper(model, (p) => setProgress(p ?? 0)).then(
                () => setProgress('done'),
                () => setProgress('error'),
              );
            }}
          >
            <Download size={13} />
            Download model now
          </SmallButton>
          <span className="text-[12px] text-fg-subtle">
            {progress === 'done'
              ? 'Ready: dictation starts instantly.'
              : progress === 'error'
                ? 'Download failed. Check your connection.'
                : typeof progress === 'number'
                  ? `Downloading… ${Math.round(progress * 100)}%`
                  : 'Optional: otherwise it downloads the first time you dictate.'}
          </span>
        </div>
      )}
    </>
  );
}

function ModelControl() {
  const model = useDrawVoicePrefs((s) => s.prefs.whisperModel);
  return (
    <Segmented<WhisperModel>
      label="On-device model"
      value={model}
      options={[
        { value: 'tiny', label: `Tiny · ${WHISPER_MODEL_MB.tiny} MB` },
        { value: 'base', label: `Base · ${WHISPER_MODEL_MB.base} MB` },
      ]}
      onChange={(v) => set({ whisperModel: v })}
    />
  );
}

function LanguageControl() {
  const lang = useDrawVoicePrefs((s) => s.prefs.dictationLanguage);
  return (
    <Select<DictationLanguage>
      label="Dictation language"
      value={lang}
      options={[
        { value: 'auto', label: 'Browser language' },
        { value: 'en', label: 'English' },
        { value: 'nl', label: 'Nederlands' },
        { value: 'fr', label: 'Français' },
        { value: 'de', label: 'Deutsch' },
      ]}
      onChange={(v) => set({ dictationLanguage: v })}
    />
  );
}

function HoldControl() {
  const hold = useDrawVoicePrefs((s) => s.prefs.holdToTalk);
  return (
    <Segmented<HoldToTalk>
      label="Hold-to-talk key"
      value={hold}
      options={[
        { value: 'space', label: 'Space' },
        { value: 'ctrl-space', label: 'Ctrl+Space' },
        { value: 'off', label: 'Off' },
      ]}
      onChange={(v) => set({ holdToTalk: v })}
    />
  );
}

function VoiceSendControl() {
  const on = useDrawVoicePrefs((s) => s.prefs.voiceSend);
  return <Toggle label="Send by voice" checked={on} onChange={(v) => set({ voiceSend: v })} />;
}

export const DRAWING_SETTINGS: SettingDef[] = [
  { id: 'draw-color', section: 'board', group: 'Drawing', label: 'Default colour', description: 'Colour new shapes start with. Press D on the board to draw.', keywords: 'draw drawing pen ink annotate colour color arrow sketch', Control: DrawColorControl },
  { id: 'draw-show', section: 'board', group: 'Drawing', label: 'Show drawings', description: 'Show pen strokes, arrows, shapes, text and images on the board.', keywords: 'draw drawing annotations hide visible layer', Control: ShowDrawingsControl },
];

export const VOICE_SETTINGS: SettingDef[] = [
  { id: 'dictation-engine', section: 'voice', group: 'Dictation', label: 'Engine', description: 'How speech becomes text in the command bar.', keywords: 'voice dictation speech microphone mic whisper speak talk privacy google', Control: EngineControl, Below: EngineBelow },
  { id: 'dictation-model', section: 'voice', group: 'Dictation', label: 'On-device model', description: 'Base is more accurate, Tiny is faster and smaller.', keywords: 'whisper size accuracy speed download', Control: ModelControl },
  { id: 'dictation-language', section: 'voice', group: 'Dictation', label: 'Language', description: 'The language you speak. Browser language uses this browser’s language when it is one of these, else English.', keywords: 'voice english dutch nederlands french francais german deutsch', Control: LanguageControl },
  { id: 'dictation-hold', section: 'voice', group: 'Keys', label: 'Hold-to-talk key', description: 'Hold it in the command bar to dictate (Space only while the bar is empty). Alt+V starts and stops dictation anywhere.', keywords: 'push to talk shortcut keyboard space hotkey', Control: HoldControl },
  { id: 'dictation-send', section: 'voice', group: 'Keys', label: 'Send by voice', description: 'End with “and send it” (or “en verstuur”, “et envoie”, “und senden”) to send the message.', keywords: 'voice command send submit', Control: VoiceSendControl },
];
