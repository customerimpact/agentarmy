import { useEffect, useRef, useState, type RefObject } from 'react';
import { LoaderCircle, Mic, X } from 'lucide-react';
import { useDrawVoicePrefs } from '../lib/draw-voice-prefs';
import { resolveEngine } from '../lib/dictation/engines';
import { isActive } from '../lib/dictation/machine';
import { dictation, useDictation } from '../lib/dictation/use-dictation';

// Mic button + status bubble for the command bar. Hold Space (input focused and empty) or
// Ctrl+Space to talk, Alt+V anywhere to start / stop, Esc to cancel, Enter to finish and send.

interface Props {
  value: string;
  setValue: (value: string) => void;
  send: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

const ERROR_TTL_MS = 9000;

export function DictationButton({ value, setValue, send, inputRef }: Props) {
  const state = useDictation();
  const prefs = useDrawVoicePrefs((s) => s.prefs);
  const [focused, setFocused] = useState(false);
  const mode = useRef<'hold' | 'toggle'>('toggle');
  const latest = useRef({ value, setValue, send });
  latest.current = { value, setValue, send };
  const active = isActive(state.phase);
  const engineKind = state.engine ?? resolveEngine(prefs.dictationEngine);

  // The command bar is where dictated text goes
  useEffect(() => {
    dictation.sink = {
      getValue: () => latest.current.value,
      setValue: (v) => latest.current.setValue(v),
      send: () => latest.current.send(),
      focus: () => inputRef.current?.focus(),
    };
    return () => {
      dictation.cancel();
      dictation.sink = null;
    };
  }, [inputRef]);

  // Keys inside the input: hold-to-talk, Esc cancels, Enter finishes and sends
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const hold = useDrawVoicePrefs.getState().prefs.holdToTalk;
      const running = dictation.active;
      if (running && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dictation.cancel();
        return;
      }
      if (running && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        dictation.stop(true);
        return;
      }
      if (e.key !== ' ') return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const trigger =
        (hold === 'space' && plain && input.value.trim() === '') || (hold === 'ctrl-space' && e.ctrlKey && !e.altKey && !e.metaKey);
      if (running && mode.current === 'hold') {
        e.preventDefault(); // key repeat while held
        e.stopPropagation();
        return;
      }
      if (!trigger || e.repeat || running) return;
      e.preventDefault();
      e.stopPropagation();
      mode.current = 'hold';
      dictation.start();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (mode.current !== 'hold' || !dictation.active) return;
      if (e.key === ' ' || e.key === 'Control') {
        e.preventDefault();
        dictation.stop();
      }
    };
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      setFocused(false);
      if (mode.current === 'hold' && dictation.active) dictation.stop();
    };
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('keyup', onKeyUp);
    input.addEventListener('focus', onFocus);
    input.addEventListener('blur', onBlur);
    setFocused(document.activeElement === input);
    return () => {
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('keyup', onKeyUp);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
    };
  }, [inputRef]);

  // Alt+V anywhere (also inside terminals) starts / stops dictation into the command bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== 'KeyV') return;
      e.preventDefault();
      e.stopPropagation();
      mode.current = 'toggle';
      dictation.toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Errors fade out on their own
  useEffect(() => {
    if (state.phase !== 'error') return;
    const t = window.setTimeout(() => dictation.dismissError(), ERROR_TTL_MS);
    return () => window.clearTimeout(t);
  }, [state.phase, state.error]);

  const showHint = !active && state.phase !== 'error' && focused && !value.trim() && prefs.holdToTalk !== 'off' && !!engineKind;
  const holdKey = prefs.holdToTalk === 'ctrl-space' ? 'Ctrl+Space' : 'Space';
  const engineNote =
    engineKind === 'whisper' ? 'On-device · private' : engineKind === 'webspeech' ? 'Browser speech · audio goes to Google' : 'Not available here';

  return (
    <div className="relative shrink-0">
      {(active || showHint || state.phase === 'error') && (
        <div
          role="status"
          data-testid="dictation-status"
          data-phase={state.phase}
          className={`absolute right-0 bottom-full mb-3 flex w-max max-w-96 flex-col gap-1.5 rounded-xl border px-3 py-2 text-[12px] shadow-xl shadow-black/30 backdrop-blur
                      ${state.phase === 'error' ? 'border-error/50 bg-elevated/95 text-error' : 'border-line-strong bg-elevated/95 text-fg-muted'}
                      ${showHint ? 'pointer-events-none py-1.5' : ''}`}
        >
          {showHint && (
            <span>
              Hold <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10.5px] text-fg">{holdKey}</kbd> to speak ·{' '}
              <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10.5px] text-fg">Alt+V</kbd>
            </span>
          )}
          {state.phase === 'error' && (
            <div className="flex items-start gap-2">
              <span className="flex-1 leading-[17px]">{state.error}</span>
              <button type="button" aria-label="Dismiss" onClick={() => dictation.dismissError()} className="text-fg-subtle hover:text-fg">
                <X size={13} />
              </button>
            </div>
          )}
          {active && (
            <>
              <div className="flex items-center gap-2 text-fg">
                {state.phase === 'finishing' ? (
                  <LoaderCircle size={13} className="animate-spin text-accent" />
                ) : (
                  <span className="relative grid size-2.5 place-items-center">
                    <span className="absolute size-2.5 animate-ping rounded-full bg-error/60" />
                    <span className="size-2 rounded-full bg-error" />
                  </span>
                )}
                <span className="font-medium">
                  {state.phase === 'starting' ? 'Starting microphone…' : state.phase === 'finishing' ? 'Transcribing…' : 'Listening'}
                </span>
                {state.phase === 'listening' && <LevelMeter level={state.level} />}
              </div>
              {state.progress !== null && (
                <div data-testid="dictation-progress">
                  <div className="mb-1 text-[11px]">Downloading the speech model (one time) · {Math.round(state.progress * 100)}%</div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(state.progress * 100)}%` }} />
                  </div>
                </div>
              )}
              <div className="text-[11px] text-fg-subtle">
                {state.phase === 'listening'
                  ? mode.current === 'hold'
                    ? `Release ${holdKey} to finish · Enter sends · Esc cancels`
                    : 'Alt+V or the mic to finish · Enter sends · Esc cancels'
                  : 'Esc cancels'}{' '}
                · {engineNote}
              </div>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="dictation-button"
        aria-label={active ? 'Stop dictation' : 'Dictate (Alt+V)'}
        aria-pressed={active}
        title={active ? 'Stop dictation (Alt+V)' : `Dictate (Alt+V, or hold ${holdKey})`}
        onMouseDown={(e) => e.preventDefault()} // keep focus in the input
        onClick={() => {
          mode.current = 'toggle';
          dictation.toggle();
        }}
        className={`grid size-8 place-items-center rounded-lg transition-colors
                    ${active ? 'bg-error/15 text-error ring-1 ring-error/50' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
      >
        {state.phase === 'finishing' ? <LoaderCircle size={15} className="animate-spin" /> : <Mic size={15} />}
      </button>
    </div>
  );
}

function LevelMeter({ level }: { level: number }) {
  const bars = [0.25, 0.5, 0.75, 1];
  return (
    <span aria-hidden className="ml-1 flex h-3 items-end gap-0.5">
      {bars.map((b, i) => (
        <span key={i} className="w-0.5 rounded-full bg-error/80 transition-[height] duration-75" style={{ height: `${Math.max(20, Math.min(100, (level / b) * 100))}%` }} />
      ))}
    </span>
  );
}
