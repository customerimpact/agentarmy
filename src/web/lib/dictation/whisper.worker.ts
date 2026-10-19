import { TRANSFORMERS_URL, WHISPER_MODELS, type WorkerRequest, type WorkerResponse } from './whisper-protocol';

// On-device speech-to-text: Whisper through transformers.js (MIT), in this worker so the board
// stays smooth. The model files come from Hugging Face once and live in the browser's cache.

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
interface ProgressInfo {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number; // 0-100
}

// Typed by hand: the webworker lib clashes with the DOM lib in this tsconfig
const scope = self as unknown as { postMessage: (msg: WorkerResponse) => void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };
const post = (msg: WorkerResponse) => scope.postMessage(msg);

const pipes = new Map<string, Promise<Transcriber>>();
const listeners = new Set<(p: number | null) => void>();
let queue: Promise<unknown> = Promise.resolve();

function loadPipe(model: 'tiny' | 'base'): Promise<Transcriber> {
  let pipe = pipes.get(model);
  if (pipe) return pipe;
  pipe = (async () => {
    const lib = (await import(/* @vite-ignore */ TRANSFORMERS_URL)) as {
      pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Transcriber>;
      env: { allowLocalModels: boolean; useBrowserCache: boolean };
    };
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = true;
    // Per-file fractions; servers do not always send a content-length, so fall back to `progress` (0-100)
    const files = new Map<string, number>();
    const progress_callback = (p: ProgressInfo) => {
      if (!p.file) return;
      if (p.status === 'initiate' || p.status === 'download') files.set(p.file, files.get(p.file) ?? 0);
      else if (p.status === 'progress') files.set(p.file, p.total ? (p.loaded ?? 0) / p.total : (p.progress ?? 0) / 100);
      else if (p.status === 'done') files.set(p.file, 1);
      else return;
      let sum = 0;
      for (const f of files.values()) sum += Math.min(1, Math.max(0, f));
      for (const fn of listeners) fn(files.size ? sum / files.size : null);
    };
    const id = WHISPER_MODELS[model];
    // Only try WebGPU when an adapter really exists (headless / blocklisted GPUs have navigator.gpu but no adapter)
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    const hasGpu = gpu ? !!(await gpu.requestAdapter().catch(() => null)) : false;
    if (hasGpu) {
      try {
        return await lib.pipeline('automatic-speech-recognition', id, {
          device: 'webgpu',
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
          progress_callback,
        });
      } catch {
        // No usable GPU adapter: fall back to WebAssembly
      }
    }
    return lib.pipeline('automatic-speech-recognition', id, { device: 'wasm', dtype: 'q8', progress_callback });
  })();
  pipes.set(model, pipe);
  pipe.catch(() => pipes.delete(model)); // let the next attempt retry (e.g. after going online)
  return pipe;
}

async function handle(msg: WorkerRequest): Promise<void> {
  const onProgress = (p: number | null) => post({ type: 'progress', id: msg.id, progress: p });
  listeners.add(onProgress);
  try {
    const pipe = await loadPipe(msg.model);
    listeners.delete(onProgress);
    if (msg.type === 'load') {
      post({ type: 'ready', id: msg.id });
      return;
    }
    // One transcription at a time: interim passes and the final pass share the model
    const run = queue.then(() =>
      pipe(msg.audio, {
        task: 'transcribe',
        ...(msg.language ? { language: msg.language } : {}),
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      }),
    );
    queue = run.catch(() => undefined);
    const out = await run;
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
    post({ type: 'result', id: msg.id, text: text.trim() });
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    listeners.delete(onProgress);
  }
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => void handle(e.data);
