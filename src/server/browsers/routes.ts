import type { FastifyInstance } from 'fastify';
import type { ConsoleLayout } from '../../shared/protocol.js';
import type { ConsoleManager } from '../consoles.js';
import { BrowserServiceImpl, type TileRequest } from './browser-service.js';
import { registerBrowserTools } from './tools.js';

// Browser tiles: launches Chromium, streams screencast frames, forwards input.
// The returned object handles the browser-* WebSocket messages for one socket.
export interface BrowserSocketHandler {
  onMessage(msg: unknown, send: (msg: unknown) => void): boolean; // true when handled
  onClose(): void;
}

export interface BrowserService {
  forSocket(send: (msg: unknown) => void): BrowserSocketHandler;
  shutdown(): Promise<void>;
  impl: BrowserServiceImpl; // for other server modules (auto previews)
}

const LAYOUT_KEYS = ['x', 'y', 'width', 'height'] as const;

// Returns null when the body is malformed
export function parseTileRequest(body: unknown): TileRequest | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const req: TileRequest = {};
  if (b.url !== undefined) {
    if (typeof b.url !== 'string') return null;
    req.url = b.url;
  }
  if (b.linkedConsoleId !== undefined) {
    if (b.linkedConsoleId !== null && typeof b.linkedConsoleId !== 'string') return null;
    req.linkedConsoleId = b.linkedConsoleId;
  }
  if (b.layout !== undefined) {
    if (!b.layout || typeof b.layout !== 'object') return null;
    const layout: Partial<ConsoleLayout> = {};
    for (const key of LAYOUT_KEYS) {
      const v = (b.layout as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      layout[key] = key === 'width' || key === 'height' ? Math.max(240, Math.round(v)) : Math.round(v);
    }
    req.layout = layout;
  }
  return req;
}

export async function registerBrowserRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager },
): Promise<BrowserService> {
  const { manager } = options;
  const service = new BrowserServiceImpl(manager);
  registerBrowserTools(service);

  app.post('/api/browsers', async (request, reply) => {
    const req = parseTileRequest(request.body);
    if (!req) return reply.code(400).send({ error: 'Invalid browser tile request' });
    if (req.linkedConsoleId && !manager.get(req.linkedConsoleId)) {
      return reply.code(404).send({ error: 'Unknown console' });
    }
    return service.createTile(req);
  });

  app.patch('/api/browsers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const req = parseTileRequest(request.body);
    if (!req) return reply.code(400).send({ error: 'Invalid browser tile request' });
    const tile = await service.updateTile(id, req);
    if (!tile) return reply.code(404).send({ error: 'Unknown browser tile' });
    return tile;
  });

  app.delete('/api/browsers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await service.deleteTile(id))) return reply.code(404).send({ error: 'Unknown browser tile' });
    return { ok: true };
  });

  return {
    forSocket: (send) => service.forSocket(send),
    shutdown: () => service.shutdown(),
    impl: service,
  };
}
