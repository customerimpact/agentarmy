import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage, ShareCursorEvent, ShareStatus } from '../../shared/protocol.js';
import type { ShareCursor } from '../../shared/share-crypto.js';
import { allowedGuestMessage, ShareService } from './share-service.js';
import type { ConsoleManager } from '../consoles.js';
import { CLOUD_URL, type CloudLink } from '../cloud.js';

// Board-side control of live sharing: Share dialog, the owner's pointer, guests' pointers on the board
export function registerShareRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager; cloud: CloudLink; dataDir: string | null; broadcast: (msg: ServerMessage) => void },
): ShareService {
  const share = new ShareService({
    manager: options.manager,
    cloud: options.cloud,
    filePath: options.dataDir ? path.join(options.dataDir, 'shares.json') : null,
    siteUrl: CLOUD_URL,
  });
  share.on('change', (status: ShareStatus) => options.broadcast({ type: 'share', share: status }));
  share.on('cursor', (cursor: ShareCursorEvent) => options.broadcast({ type: 'share-cursor', cursor }));
  // Signing in or out on this computer starts or stops hosting
  options.cloud.on('change', () => {
    share.stop();
    share.start();
    options.broadcast({ type: 'share', share: share.status() });
  });
  app.addHook('onReady', async () => share.start());
  app.addHook('onClose', async () => share.stop());

  app.get('/api/share', async () => share.status());
  app.post('/api/share', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: unknown; expiresInHours?: unknown };
    try {
      return await share.create({
        title: typeof body.title === 'string' ? body.title : undefined,
        expiresInHours: typeof body.expiresInHours === 'number' ? body.expiresInHours : undefined,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete('/api/share/:id', async (request, reply) => {
    try {
      return await share.revoke((request.params as { id: string }).id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  app.post('/api/share/cursor', async (request) => {
    const parsed = allowedGuestMessage({ t: 'cursor', c: (request.body as { c?: unknown } | undefined)?.c ?? null });
    if (parsed?.t === 'cursor') share.localCursor(parsed.c as ShareCursor | null);
    return { ok: true };
  });
  return share;
}
