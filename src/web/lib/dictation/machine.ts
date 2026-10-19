// Voice dictation for the command bar: a small state machine, text clean-up and the controller
// that drives an engine (on-device Whisper or browser speech recognition, see engines.ts).
// Kept free of DOM APIs so it can be unit-tested with a fake engine.

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing' | 'error';
export type EngineKind = 'whisper' | 'webspeech';
export type Language = 'auto' | 'en' | 'nl' | 'fr' | 'de';

export interface DictationState {
  phase: DictationPhase;
  engine: EngineKind | null;
  interim: string; // latest partial transcript of this session
  progress: number | null; // model download 0..1 while it loads, else null
  level: number; // microphone level 0..1 (for the meter)
  error: string | null;
}

export const INITIAL_DICTATION: DictationState = { phase: 'idle', engine: null, interim: '', progress: null, level: 0, error: null };

export type DictationEvent =
  | { type: 'start'; engine: EngineKind }
  | { type: 'listening' }
  | { type: 'progress'; progress: number | null }
  | { type: 'level'; level: number }
  | { type: 'interim'; text: string }
  | { type: 'stop' }
  | { type: 'done' }
  | { type: 'cancel' }
  | { type: 'error'; message: string }
  | { type: 'dismiss' };

export const isActive = (phase: DictationPhase) => phase === 'starting' || phase === 'listening' || phase === 'finishing';

export function reduceDictation(state: DictationState, event: DictationEvent): DictationState {
  switch (event.type) {
    case 'start':
      if (isActive(state.phase)) return state;
      return { ...INITIAL_DICTATION, phase: 'starting', engine: event.engine };
    case 'listening':
      return state.phase === 'starting' ? { ...state, phase: 'listening' } : state;
    case 'progress':
      return isActive(state.phase) ? { ...state, progress: event.progress } : state;
    case 'level':
      return state.phase === 'listening' ? { ...state, level: event.level } : state;
    case 'interim':
      return state.phase === 'listening' || state.phase === 'finishing' ? { ...state, interim: event.text } : state;
    case 'stop':
      return state.phase === 'listening' || state.phase === 'starting' ? { ...state, phase: 'finishing', level: 0 } : state;
    case 'done':
    case 'cancel':
      return state.phase === 'error' && event.type === 'done' ? state : { ...INITIAL_DICTATION };
    case 'error':
      return { ...INITIAL_DICTATION, phase: 'error', engine: state.engine, error: event.message };
    case 'dismiss':
      return state.phase === 'error' ? { ...INITIAL_DICTATION } : state;
  }
}

// ---------- text ----------

const SPOKEN_PUNCTUATION: [RegExp, string][] = [
  [/\s*\b(new line|newline|nieuwe regel|nouvelle ligne|neue zeile)\b[.,]?\s*/gi, '\n'],
  [/\s*\b(question mark|vraagteken|point d'interrogation|fragezeichen)\b/gi, '?'],
  [/\s*\b(exclamation mark|exclamation point|uitroepteken|point d'exclamation|ausrufezeichen)\b/gi, '!'],
  [/\s*\b(full stop|period|punt|punkt)\b/gi, '.'],
  [/\s*\b(comma|komma|virgule)\b/gi, ','],
  [/\s*\b(colon|dubbele punt|deux points|doppelpunkt)\b/gi, ':'],
];

// Whisper marks silence and noise like "[BLANK_AUDIO]" or "(music)"
const NOISE =
  /\[[^\]]{1,40}\]|\((?:[a-z]+ )?(?:music|silence|noise|inaudible|applause|laughs?|laughing|bell|beeps?|beeping|buzz(?:ing|er)?|static|cough(?:s|ing)?|sighs?|typing|clicking|wind|tone|whistl(?:e|ing))\)|\*[^*]{1,30}\*/gi;

// spokenPunctuation: turn "comma", "question mark", "new line"... into marks. Only for browser speech;
// Whisper punctuates by itself and would turn real words (Dutch "punt") into marks.
export function tidyTranscript(raw: string, spokenPunctuation = false): string {
  let text = raw.replace(NOISE, ' ');
  if (spokenPunctuation) for (const [re, mark] of SPOKEN_PUNCTUATION) text = text.replace(re, mark);
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/ ([,.!?:])/g, '$1')
    .replace(/([,.!?:])(?=[^\s\d,.!?:\n])/g, '$1 ')
    .replace(/([.!?]) ?([.!?,])+/g, '$1')
    .trim();
  // Capitalize the start and after sentence ends
  text = text.replace(/(^|[.!?]\s+|\n)(\p{Ll})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  // A transcript that is only a sound annotation, like "(Door closes)", is not something you said
  if (/^\([^()]{1,40}\)\.?$/.test(text)) return '';
  return text;
}

// "... and send it" at the end of what was said sends the message
const SEND_COMMANDS = [
  /[\s,.;]*\b(?:(?:and|then|now) send(?: it| that| this)?|send (?:it|that|this))\b[\s.!]*$/i,
  /[\s,.;]*\b(?:en )?(?:verstuur(?: het| dat| maar)?|verzend(?: het)?|stuur (?:het|dat|maar) (?:door|op))\b[\s.!]*$/i,
  /[\s,.;]*(?:\bet envoie|\benvoie[- ]le|\benvoyer)\b[\s.!]*$/i,
  /[\s,.;]*\b(?:und senden|abschicken|absenden|schick(?:e)? es ab)\b[\s.!]*$/i,
];

export function detectSendCommand(text: string): { text: string; send: boolean } {
  for (const re of SEND_COMMANDS) {
    if (re.test(text)) {
      const rest = text.replace(re, '').trim();
      return { text: rest, send: rest.length > 0 };
    }
  }
  return { text, send: false };
}

// Dictated text added after what was already typed
export function joinDraft(base: string, addition: string): string {
  if (!addition) return base;
  if (!base) return addition;
  return /[\s]$/.test(base) ? base + addition : `${base} ${addition}`;
}

// ---------- engine + controller ----------

export interface EngineHandlers {
  onListening: () => void; // microphone open, audio is being captured
  onProgress: (progress: number | null) => void; // model download
  onLevel: (level: number) => void;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void; // after stop(): the whole session's text (may be empty)
  onError: (message: string) => void;
}

export interface DictationEngine {
  readonly kind: EngineKind;
  start(handlers: EngineHandlers, options: { language: Language }): void;
  stop(): void; // finish: transcribe what was said, then onFinal
  cancel(): void; // drop everything, no callbacks afterwards
}

export interface DictationSink {
  getValue: () => string;
  setValue: (value: string) => void;
  send: () => void; // sends the current command bar value
  focus: () => void;
}

export interface ControllerOptions {
  createEngine: () => DictationEngine;
  language: () => Language;
  voiceSend: () => boolean;
  schedule?: (fn: () => void) => void; // runs fn after the sink's setValue has rendered
}

export class DictationController {
  state: DictationState = INITIAL_DICTATION;
  private listeners = new Set<(s: DictationState) => void>();
  private engine: DictationEngine | null = null;
  private base = '';
  private session = 0;
  private sendAfter = false;
  sink: DictationSink | null = null;

  constructor(private readonly options: ControllerOptions) {}

  subscribe(fn: (s: DictationState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private dispatch(event: DictationEvent): void {
    const next = reduceDictation(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }

  get active(): boolean {
    return isActive(this.state.phase);
  }

  start(): void {
    if (this.active || !this.sink) return;
    let engine: DictationEngine;
    try {
      engine = this.options.createEngine();
    } catch (err) {
      this.dispatch({ type: 'error', message: (err as Error).message });
      return;
    }
    const session = ++this.session;
    this.engine = engine;
    this.sendAfter = false;
    this.base = this.sink.getValue();
    this.sink.focus();
    this.dispatch({ type: 'start', engine: engine.kind });
    const live = () => session === this.session;
    engine.start(
      {
        onListening: () => live() && this.dispatch({ type: 'listening' }),
        onProgress: (p) => live() && this.dispatch({ type: 'progress', progress: p }),
        onLevel: (level) => live() && this.dispatch({ type: 'level', level }),
        onInterim: (text) => {
          if (!live()) return;
          this.dispatch({ type: 'interim', text });
          this.sink?.setValue(joinDraft(this.base, tidyTranscript(text, engine.kind === 'webspeech')));
        },
        onFinal: (text) => {
          if (!live()) return;
          this.finish(text, engine.kind === 'webspeech');
        },
        onError: (message) => {
          if (!live()) return;
          this.session++;
          this.engine = null;
          this.sink?.setValue(this.base);
          this.dispatch({ type: 'error', message });
        },
      },
      { language: this.options.language() },
    );
  }

  // sendAfter: send the message once the text is in (Enter pressed while dictating)
  stop(sendAfter = false): void {
    if (!this.engine) return;
    this.sendAfter = this.sendAfter || sendAfter;
    if (this.state.phase === 'starting' && this.state.progress === null && !this.state.interim) {
      // Released before the microphone even opened: nothing to transcribe
      this.cancel();
      return;
    }
    this.dispatch({ type: 'stop' });
    this.engine.stop();
  }

  toggle(): void {
    if (this.state.phase === 'listening' || this.state.phase === 'starting') this.stop();
    else if (!this.active) this.start();
  }

  cancel(): void {
    const engine = this.engine;
    this.engine = null;
    this.session++;
    engine?.cancel();
    if (this.sink && this.state.phase !== 'idle') this.sink.setValue(this.base);
    this.dispatch({ type: 'cancel' });
  }

  dismissError(): void {
    this.dispatch({ type: 'dismiss' });
  }

  private finish(raw: string, spokenPunctuation: boolean): void {
    this.engine = null;
    this.session++;
    const sink = this.sink;
    let text = tidyTranscript(raw, spokenPunctuation);
    let send = false;
    if (this.options.voiceSend()) ({ text, send } = detectSendCommand(text));
    send = send || this.sendAfter;
    this.sendAfter = false;
    const value = joinDraft(this.base, text);
    sink?.setValue(value);
    this.dispatch({ type: 'done' });
    if (send && sink && value.trim()) (this.options.schedule ?? ((fn) => fn()))(() => sink.send());
  }
}
