import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  IMAGE_ID_RE,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_SHAPES,
  sniffImageType,
  validateShape,
  type DrawingOps,
  type ImageUploadResponse,
  type Shape,
} from '../shared/drawings.js';
import type { ServerMessage } from '../shared/protocol.js';

// Board drawings (pen, shapes, arrows, text, images) and the uploaded images they show.
// Shapes are kept in ConsoleManager.drawings (persisted with the board in state.json); image files
// live in <AGENTARMY_HOME>/images/ (in memory for throwaway servers without a data dir).

export interface OpsResult {
  upserted: Shape[];
  removed: string[];
  error?: string;
}

// Applies a batch from a client to the list in place. Invalid shapes are rejected as a whole batch,
// so a buggy client can't half-apply an undo step.
export function applyDrawingOps(list: Shape[], ops: unknown, defaultWorkspaceId = 'main'): OpsResult {
  if (!ops || typeof ops !== 'object') return { upserted: [], removed: [], error: 'body must be an object' };
  const body = ops as DrawingOps;
  const upsertRaw = body.upsert ?? [];
  const removeRaw = body.remove ?? [];
  if (!Array.isArray(upsertRaw) || !Array.isArray(removeRaw)) {
    return { upserted: [], removed: [], error: 'upsert and remove must be arrays' };
  }
  if (upsertRaw.length > MAX_SHAPES || removeRaw.length > MAX_SHAPES) {
    return { upserted: [], removed: [], error: 'too many shapes in one batch' };
  }
  const upserted: Shape[] = [];
  for (const raw of upsertRaw) {
    const shape = validateShape(raw, defaultWorkspaceId);
    if (!shape) return { upserted: [], removed: [], error: `invalid shape ${JSON.stringify((raw as { id?: unknown })?.id ?? null)}` };
    upserted.push(shape);
  }
  const removeIds = removeRaw.filter((id): id is string => typeof id === 'string');
  const index = new Map(list.map((s, i) => [s.id, i]));
  const newCount = upserted.filter((s) => !index.has(s.id)).length;
  const removing = removeIds.filter((id) => index.has(id)).length;
  if (list.length + newCount - removing > MAX_SHAPES) {
    return { upserted: [], removed: [], error: `a board holds at most ${MAX_SHAPES} shapes` };
  }
  for (const shape of upserted) {
    const i = index.get(shape.id);
    if (i === undefined) {
      index.set(shape.id, list.length);
      list.push(shape);
    } else {
      list[i] = shape;
    }
  }
  const removeSet = new Set(removeIds);
  const removed: string[] = [];
  if (removeSet.size) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (removeSet.has(list[i].id)) {
        removed.push(list[i].id);
        list.splice(i, 1);
      }
    }
  }
  return { upserted, removed };
}

// Image files: on disk under dir, or in memory when dir is null (tests, throwaway servers)
export class ImageStore {
  private memory = new Map<string, Buffer>();

  constructor(readonly dir: string | null) {}

  save(bytes: Buffer): { id: string } | { error: string; status: number } {
    if (bytes.length === 0) return { error: 'empty image', status: 400 };
    if (bytes.length > MAX_IMAGE_BYTES) return { error: 'image is larger than 10 MB', status: 413 };
    const type = sniffImageType(bytes);
    if (!type) return { error: 'only PNG, JPEG, GIF and WebP images are supported', status: 415 };
    const id = `img_${crypto.randomBytes(12).toString('hex')}.${IMAGE_TYPES[type]}`;
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, id), bytes);
    } else {
      this.memory.set(id, bytes);
    }
    return { id };
  }

  read(id: string): { bytes: Buffer; type: string } | null {
    if (!IMAGE_ID_RE.test(id)) return null; // also blocks path traversal
    const ext = id.slice(id.lastIndexOf('.') + 1);
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0];
    if (!type) return null;
    let bytes: Buffer | undefined;
    if (this.dir) {
      try {
        bytes = fs.readFileSync(path.join(this.dir, id));
      } catch {
        return null;
      }
    } else {
      bytes = this.memory.get(id);
    }
    return bytes ? { bytes, type } : null;
  }
}

export interface DrawingRoutesOptions {
  drawings: Shape[]; // mutated in place (ConsoleManager.drawings)
  persist: () => void;
  broadcast: (msg: ServerMessage) => void;
  activeWorkspaceId: () => string;
  imagesDir: string | null;
}

export async function registerDrawingRoutes(app: FastifyInstance, options: DrawingRoutesOptions): Promise<ImageStore> {
  const images = new ImageStore(options.imagesDir);

  app.get('/api/drawings', async () => ({ shapes: options.drawings }));

  app.post('/api/drawings/ops', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const result = applyDrawingOps(options.drawings, request.body, options.activeWorkspaceId());
    if (result.error) return reply.code(400).send({ error: result.error });
    if (result.upserted.length || result.removed.length) {
      const origin = (request.body as DrawingOps).origin;
      options.broadcast({
        type: 'drawings',
        upsert: result.upserted,
        remove: result.removed,
        ...(typeof origin === 'string' ? { origin: origin.slice(0, 64) } : {}),
      });
      options.persist();
    }
    return { ok: true, upserted: result.upserted.length, removed: result.removed.length };
  });

  // Raw image bytes in an encapsulated scope, so the binary parser and the 10 MB limit only apply here
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.post('/api/images', { bodyLimit: MAX_IMAGE_BYTES }, async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: 'send the image bytes with an image/* content type' });
      const saved = images.save(body);
      if ('error' in saved) return reply.code(saved.status).send({ error: saved.error });
      const response: ImageUploadResponse = { id: saved.id, url: `/api/images/${saved.id}`, bytes: body.length };
      return response;
    });
  });

  app.get('/api/images/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const image = images.read(id);
    if (!image) return reply.code(404).send({ error: 'Not found' });
    return reply
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .type(image.type)
      .send(image.bytes);
  });

  return images;
}
