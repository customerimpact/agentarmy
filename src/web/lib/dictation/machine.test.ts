import { describe, expect, it } from 'vitest';
import { resample } from './engines';
import {
  DictationController,
  detectSendCommand,
  INITIAL_DICTATION,
  joinDraft,
  reduceDictation,
  tidyTranscript,
  type DictationEngine,
  type EngineHandlers,
  type Language,
} from './machine';

// A scripted engine: the test drives its callbacks
class FakeEngine implements DictationEngine {
  handlers: EngineHandlers | null = null;
  language: Language | null = null;
  stopped = false;
  cancelled = false;
  constructor(readonly kind: 'whisper' | 'webspeech' = 'whisper') {}
  start(h: EngineHandlers, options: { language: Language }) {
    this.handlers = h;
    this.language = options.language;
  }
  stop() {
    this.stopped = true;
  }
  cancel() {
    this.cancelled = true;
  }
}

function setup(opts: { voiceSend?: boolean; kind?: 'whisper' | 'webspeech'; initial?: string } = {}) {
  const engines: FakeEngine[] = [];
  const sent: string[] = [];
  let value = opts.initial ?? '';
  const controller = new DictationController({
    createEngine: () => {
      const e = new FakeEngine(opts.kind);
      engines.push(e);
      return e;
    },
    language: () => 'nl',
    voiceSend: () => opts.voiceSend ?? true,
  });
  controller.sink = { getValue: () => value, setValue: (v) => (value = v), send: () => sent.push(value), focus: () => undefined };
  return { controller, engines, sent, value: () => value };
}

describe('reduceDictation', () => {
  it('walks idle → starting → listening → finishing → idle', () => {
    let s = reduceDictation(INITIAL_DICTATION, { type: 'start', engine: 'whisper' });
    expect(s.phase).toBe('starting');
    s = reduceDictation(s, { type: 'progress', progress: 0.5 });
    expect(s.progress).toBe(0.5);
    s = reduceDictation(s, { type: 'listening' });
    s = reduceDictation(s, { type: 'interim', text: 'hallo' });
    expect(s).toMatchObject({ phase: 'listening', interim: 'hallo' });
    s = reduceDictation(s, { type: 'stop' });
    expect(s.phase).toBe('finishing');
    expect(reduceDictation(s, { type: 'done' })).toEqual(INITIAL_DICTATION);
  });

  it('ignores events that do not fit the phase', () => {
    expect(reduceDictation(INITIAL_DICTATION, { type: 'listening' })).toBe(INITIAL_DICTATION);
    expect(reduceDictation(INITIAL_DICTATION, { type: 'interim', text: 'x' })).toBe(INITIAL_DICTATION);
    const listening = { ...INITIAL_DICTATION, phase: 'listening' as const };
    expect(reduceDictation(listening, { type: 'start', engine: 'whisper' })).toBe(listening);
  });

  it('keeps errors until dismissed', () => {
    const s = reduceDictation(INITIAL_DICTATION, { type: 'error', message: 'Microphone access is blocked' });
    expect(s).toMatchObject({ phase: 'error', error: 'Microphone access is blocked' });
    expect(reduceDictation(s, { type: 'done' })).toBe(s);
    expect(reduceDictation(s, { type: 'dismiss' })).toEqual(INITIAL_DICTATION);
  });
});

describe('text helpers', () => {
  it('cleans Whisper output', () => {
    expect(tidyTranscript(' [BLANK_AUDIO] fix the  login bug .  then run tests')).toBe('Fix the login bug. Then run tests');
    expect(tidyTranscript('(music)')).toBe('');
    expect(tidyTranscript(' (Bell)')).toBe(''); // what real Whisper hears from Chromium's fake mic
    expect(tidyTranscript('(Door closes).')).toBe('');
    expect(tidyTranscript('run the tests (all of them)')).toBe('Run the tests (all of them)');
  });

  it('turns spoken punctuation into marks for browser speech only', () => {
    expect(tidyTranscript('hello comma world question mark new line next', true)).toBe('Hello, world?\nNext');
    expect(tidyTranscript('het punt is dat', false)).toBe('Het punt is dat');
  });

  it('detects a trailing send command in four languages', () => {
    expect(detectSendCommand('Fix the tests and send it.')).toEqual({ text: 'Fix the tests', send: true });
    expect(detectSendCommand('Los de bug op en verstuur')).toEqual({ text: 'Los de bug op', send: true });
    expect(detectSendCommand('Corrige le bug et envoie')).toEqual({ text: 'Corrige le bug', send: true });
    expect(detectSendCommand('Behebe den Fehler und senden')).toEqual({ text: 'Behebe den Fehler', send: true });
    expect(detectSendCommand('Write an email to send')).toEqual({ text: 'Write an email to send', send: false });
    expect(detectSendCommand('Send it')).toEqual({ text: '', send: false }); // nothing left to send
  });

  it('joins dictated text to what was typed', () => {
    expect(joinDraft('', 'Hi')).toBe('Hi');
    expect(joinDraft('@Ada', 'Hi')).toBe('@Ada Hi');
    expect(joinDraft('@Ada ', 'Hi')).toBe('@Ada Hi');
    expect(joinDraft('x', '')).toBe('x');
  });

  it('resamples to 16 kHz', () => {
    const input = new Float32Array(48_000).fill(0.5);
    const out = resample(input, 48_000);
    expect(out.length).toBe(16_000);
    expect(out[100]).toBeCloseTo(0.5);
    expect(resample(input, 16_000)).toBe(input);
  });
});

describe('DictationController', () => {
  it('streams interim text after the typed draft and finishes with the final text', () => {
    const t = setup({ initial: '@Ada' });
    t.controller.start();
    const engine = t.engines[0];
    expect(engine.language).toBe('nl');
    engine.handlers!.onListening();
    engine.handlers!.onInterim('maak de');
    expect(t.value()).toBe('@Ada Maak de');
    t.controller.stop();
    expect(engine.stopped).toBe(true);
    expect(t.controller.state.phase).toBe('finishing');
    engine.handlers!.onFinal('maak de tests groen.');
    expect(t.value()).toBe('@Ada Maak de tests groen.');
    expect(t.controller.state.phase).toBe('idle');
    expect(t.sent).toEqual([]);
  });

  it('sends when the final text ends with a send command (if enabled)', () => {
    const t = setup();
    t.controller.start();
    t.engines[0].handlers!.onListening();
    t.controller.stop();
    t.engines[0].handlers!.onFinal('Run the build and send it');
    expect(t.value()).toBe('Run the build');
    expect(t.sent).toEqual(['Run the build']);

    const off = setup({ voiceSend: false });
    off.controller.start();
    off.engines[0].handlers!.onListening();
    off.controller.stop();
    off.engines[0].handlers!.onFinal('Run the build and send it');
    expect(off.sent).toEqual([]);
    expect(off.value()).toBe('Run the build and send it');
  });

  it('Enter while dictating finishes and sends', () => {
    const t = setup();
    t.controller.start();
    t.engines[0].handlers!.onListening();
    t.controller.stop(true);
    t.engines[0].handlers!.onFinal('deploy');
    expect(t.sent).toEqual(['Deploy']);
  });

  it('cancel restores the draft and ignores late engine callbacks', () => {
    const t = setup({ initial: 'typed' });
    t.controller.start();
    const engine = t.engines[0];
    engine.handlers!.onListening();
    engine.handlers!.onInterim('something');
    t.controller.cancel();
    expect(engine.cancelled).toBe(true);
    expect(t.value()).toBe('typed');
    engine.handlers!.onFinal('late text');
    expect(t.value()).toBe('typed');
    expect(t.controller.state.phase).toBe('idle');
  });

  it('a quick tap before the microphone opens cancels instead of transcribing', () => {
    const t = setup();
    t.controller.start();
    t.controller.stop();
    expect(t.engines[0].cancelled).toBe(true);
    expect(t.controller.state.phase).toBe('idle');
  });

  it('reports engine errors and restores the draft', () => {
    const t = setup({ initial: 'draft' });
    t.controller.start();
    t.engines[0].handlers!.onInterim('half');
    t.engines[0].handlers!.onError('Microphone access is blocked.');
    expect(t.controller.state).toMatchObject({ phase: 'error', error: 'Microphone access is blocked.' });
    expect(t.value()).toBe('draft');
    t.controller.dismissError();
    expect(t.controller.state.phase).toBe('idle');
  });

  it('reports an unsupported browser when no engine can be created', () => {
    const t = setup();
    const c = new DictationController({
      createEngine: () => {
        throw new Error('Dictation is not supported in this browser');
      },
      language: () => 'auto',
      voiceSend: () => true,
    });
    c.sink = t.controller.sink;
    c.start();
    expect(c.state).toMatchObject({ phase: 'error', error: 'Dictation is not supported in this browser' });
  });

  it('toggle starts and stops; download progress and level are tracked', () => {
    const t = setup({ kind: 'webspeech' });
    t.controller.toggle();
    const h = t.engines[0].handlers!;
    h.onProgress(0.3);
    expect(t.controller.state.progress).toBe(0.3);
    h.onListening();
    h.onLevel(0.7);
    expect(t.controller.state.level).toBe(0.7);
    h.onInterim('hello comma world');
    expect(t.value()).toBe('Hello, world');
    t.controller.toggle();
    expect(t.engines[0].stopped).toBe(true);
  });
});
