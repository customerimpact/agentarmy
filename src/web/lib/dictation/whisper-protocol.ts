// Messages between the page and whisper.worker.ts

export type WorkerRequest =
  | { type: 'load'; id: number; model: 'tiny' | 'base' }
  | { type: 'transcribe'; id: number; model: 'tiny' | 'base'; audio: Float32Array; language: string | null };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: number | null } // model download, 0..1
  | { type: 'ready'; id: number }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string };

// transformers.js is loaded from a pinned CDN URL inside the worker only when dictation is first
// used, so it adds nothing to the app bundle or the npm package.
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
export const WHISPER_MODELS = { tiny: 'onnx-community/whisper-tiny', base: 'onnx-community/whisper-base' } as const;
export const WHISPER_MODEL_MB = { tiny: 40, base: 80 } as const;
