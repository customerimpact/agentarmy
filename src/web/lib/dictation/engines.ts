import type { DictationEngineChoice, WhisperModel } from '../draw-voice-prefs';
import type { DictationEngine, EngineHandlers, EngineKind, Language } from './machine';
import type { WorkerRequest, WorkerResponse } from './whisper-protocol';

// Two dictation engines:
// - whisper: on-device Whisper (transformers.js in a Web Worker). Audio never leaves the machine;
//   the model (~40 MB tiny / ~80 MB base) downloads once from Hugging Face and is cached by the browser.
// - webspeech: the browser's SpeechRecognition. Chrome sends the audio to Google for recognition.

export function webSpeechSupported(): boolean {
  const w = globalThis as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function onDeviceSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof AudioContext !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export function resolveEngine(choice: DictationEngineChoice): EngineKind | null {
  if (choice === 'whisper') return onDeviceSupported() ? 'whisper' : null;
  if (choice === 'webspeech') return webSpeechSupported() ? 'webspeech' : null;
  return onDeviceSupported() ? 'whisper' : webSpeechSupported() ? 'webspeech' : null;
}

export function microphoneError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'not-allowed' || name === 'service-not-allowed')
    return 'Microphone access is blocked. Allow it for this page (the lock or mic icon in the address bar), then try again.';
  if (name === 'NotFoundError' || name === 'audio-capture') return 'No microphone found. Plug one in or pick it in your system sound settings.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app.';
  return `Could not start the microphone (${name || String(err)}).`;
}

// ---------- microphone capture (16 kHz mono PCM for Whisper) ----------

const WORKLET = `class AaRec extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('aa-rec',AaRec);`;
export const TARGET_RATE = 16_000;

export function resample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

class Recorder {
  private chunks: Float32Array[] = [];
  private length = 0;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioNode | null = null;
  private closed = false;

  constructor(private readonly onLevel: (level: number) => void) {}

  async open(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const take = (data: Float32Array) => {
      if (this.closed) return;
      const pcm = resample(data, ctx.sampleRate);
      this.chunks.push(pcm);
      this.length += pcm.length;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      this.onLevel(Math.min(1, Math.sqrt(sum / Math.max(1, data.length)) * 4));
    };
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'aa-rec');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => take(e.data);
      source.connect(node);
      this.node = node;
    } else {
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
      this.node = node;
    }
  }

  // Everything recorded so far, at 16 kHz (the last maxSeconds only, when given)
  audio(maxSeconds?: number): Float32Array {
    const out = new Float32Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return maxSeconds && out.length > maxSeconds * TARGET_RATE ? out.slice(out.length - maxSeconds * TARGET_RATE) : out;
  }

  get seconds(): number {
    return this.length / TARGET_RATE;
  }

  close(): void {
    this.closed = true;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

// ---------- on-device Whisper ----------

const LANGUAGE_NAMES: Record<Exclude<Language, 'auto'>, string> = { en: 'english', nl: 'dutch', fr: 'french', de: 'german' };
const INTERIM_EVERY_MS = 1500;
const INTERIM_MAX_SECONDS = 25;

let sharedWorker: Worker | null = null;
let requestSeq = 0;

function getWorker(): Worker {
  sharedWorker ??= new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module', name: 'agentarmy-whisper' });
  return sharedWorker;
}

function call(worker: Worker, message: WorkerRequest, onProgress?: (p: number | null) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== message.id) return;
      if (msg.type === 'progress') {
        onProgress?.(msg.progress);
        return;
      }
      worker.removeEventListener('message', onMessage);
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg.type === 'result' ? msg.text : '');
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(message, message.type === 'transcribe' ? [message.audio.buffer] : []);
  });
}

export class WhisperEngine implements DictationEngine {
  readonly kind = 'whisper' as const;
  private recorder: Recorder | null = null;
  private cancelled = false;
  private stopped = false;
  private interimTimer: number | null = null;
  private busy = false;
  private ready: Promise<string> | null = null;

  constructor(private readonly model: WhisperModel) {}

  start(h: EngineHandlers, options: { language: Language }): void {
    const worker = getWorker();
    const model = this.model;
    // Whisper in transformers.js does not detect the language (it assumes English), so 'auto'
    // means the browser's language when it is one we offer
    const browserLang = (navigator.language || 'en').slice(0, 2).toLowerCase() as Exclude<Language, 'auto'>;
    const lang = options.language === 'auto' ? (browserLang in LANGUAGE_NAMES ? browserLang : 'en') : options.language;
    const language = LANGUAGE_NAMES[lang];
    // Load the model while the microphone already records, so nothing said is lost
    this.ready = call(worker, { type: 'load', id: ++requestSeq, model }, (p) => !this.cancelled && h.onProgress(p));
    this.ready.then(
      () => !this.cancelled && h.onProgress(null),
      () => undefined,
    );
    const recorder = new Recorder((level) => !this.cancelled && h.onLevel(level));
    this.recorder = recorder;
    const transcribe = (audio: Float32Array) => call(worker, { type: 'transcribe', id: ++requestSeq, model, audio, language });

    recorder.open().then(
      () => {
        if (this.cancelled) return;
        h.onListening();
        this.interimTimer = window.setInterval(() => {
          if (this.busy || this.stopped || this.cancelled || recorder.seconds < 0.8) return;
          this.busy = true;
          this.ready!
            .then(() => transcribe(recorder.audio(INTERIM_MAX_SECONDS)))
            .then((text) => !this.cancelled && !this.stopped && h.onInterim(text))
            .catch(() => undefined)
            .finally(() => (this.busy = false));
        }, INTERIM_EVERY_MS);
      },
      (err) => {
        if (this.cancelled) return;
        this.cleanup();
        h.onError(microphoneError(err));
      },
    );

    this.finish = async () => {
      const audio = recorder.audio();
      this.cleanup();
      try {
        await this.ready;
      } catch (err) {
        if (this.cancelled) return;
        const message = (err as Error).message;
        const offline = /fetch|network|load failed|import/i.test(message);
        h.onError(
          offline
            ? 'Could not download the on-device speech model. The first use needs an internet connection; after that it works offline.'
            : `The on-device speech model could not start (${message.slice(0, 160)}). Try Browser speech in Settings › Voice.`,
        );
        return;
      }
      if (this.cancelled) return;
      if (audio.length < TARGET_RATE * 0.25) {
        h.onFinal('');
        return;
      }
      try {
        const text = await transcribe(audio);
        if (!this.cancelled) h.onFinal(text);
      } catch (err) {
        if (!this.cancelled) h.onError(`Transcription failed: ${(err as Error).message}`);
      }
    };
  }

  private finish: () => Promise<void> = async () => undefined;

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.finish();
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.interimTimer !== null) window.clearInterval(this.interimTimer);
    this.interimTimer = null;
    this.recorder?.close();
    this.recorder = null;
  }
}

// Download the model ahead of time (Settings › Voice)
export function preloadWhisper(model: WhisperModel, onProgress: (p: number | null) => void): Promise<void> {
  return call(getWorker(), { type: 'load', id: ++requestSeq, model }, onProgress).then(() => undefined);
}

// ---------- browser speech recognition ----------

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const SPEECH_LANG: Record<Language, string> = { auto: '', en: 'en-US', nl: 'nl-NL', fr: 'fr-FR', de: 'de-DE' };

export class WebSpeechEngine implements DictationEngine {
  readonly kind = 'webspeech' as const;
  private rec: SpeechRecognitionLike | null = null;
  private cancelled = false;

  start(h: EngineHandlers, options: { language: Language }): void {
    const w = globalThis as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      h.onError('This browser has no speech recognition. Use the on-device engine in Settings › Voice.');
      return;
    }
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = SPEECH_LANG[options.language] || navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    let interim = '';
    let failed = false;
    rec.onstart = () => !this.cancelled && h.onListening();
    rec.onresult = (e) => {
      if (this.cancelled) return;
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += `${r[0].transcript} `;
        else interim += r[0].transcript;
      }
      h.onInterim(`${finalText}${interim}`);
    };
    rec.onerror = (e) => {
      if (this.cancelled || e.error === 'aborted' || e.error === 'no-speech') return;
      failed = true;
      h.onError(
        e.error === 'network'
          ? 'Browser speech recognition needs an internet connection (Chrome sends the audio to Google). Try the on-device engine.'
          : microphoneError({ name: e.error }),
      );
    };
    rec.onend = () => {
      if (this.cancelled || failed) return;
      h.onFinal(`${finalText}${interim}`);
    };
    try {
      rec.start();
    } catch (err) {
      h.onError(microphoneError(err));
    }
  }

  stop(): void {
    this.rec?.stop();
  }

  cancel(): void {
    this.cancelled = true;
    this.rec?.abort();
  }
}

export function createEngine(choice: DictationEngineChoice, model: WhisperModel): DictationEngine {
  const kind = resolveEngine(choice);
  if (kind === 'whisper') return new WhisperEngine(model);
  if (kind === 'webspeech') return new WebSpeechEngine();
  throw new Error(
    choice === 'webspeech'
      ? 'This browser has no speech recognition. Switch Settings › Voice › Engine to On-device.'
      : 'Dictation is not supported in this browser (no microphone access or Web Workers).',
  );
}
