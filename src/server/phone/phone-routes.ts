import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DeviceTarget, ServerMessage } from '../../shared/protocol.js';
import type { ConsoleManager } from '../consoles.js';
import { PhoneService } from './phone-server.js';
import { PhoneStore } from './phone-store.js';

// Board-side control of phone access (Settings > Phone) and "Continue on computer / phone".
// The listener starts with the board when phone access was left on.

export interface PhoneRouteOptions {
  manager: ConsoleManager;
  port: number;
  token: string;
  broadcast: (msg: ServerMessage) => void;
  dataDir: string | null; // null: in-memory (tests), phone access starts off
  webRoot: string | null;
  phonePort?: number; // tests: 0 = any free port
  phoneHost?: string; // tests: 127.0.0.1 (no firewall prompt); default every interface
}

export function registerPhoneRoutes(app: FastifyInstance, options: PhoneRouteOptions): PhoneService {
  const store = new PhoneStore(options.dataDir ? path.join(options.dataDir, 'phone.json') : null);
  const phone = new PhoneService({
    main: app,
    mainPort: options.port,
    mainToken: options.token,
    manager: options.manager,
    store,
    webRoot: options.webRoot,
    portOverride: options.phonePort,
    host: options.phoneHost,
  });
  phone.on('change', (status) => options.broadcast({ type: 'phone', phone: status }));

  app.addHook('onReady', async () => {
    if (store.enabled) await phone.start();
  });
  app.addHook('onClose', async () => phone.stop());

  app.get('/api/phone', async () => phone.status());

  app.put('/api/phone', async (request, reply) => {
    const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    return phone.setEnabled(enabled);
  });

  app.post('/api/phone/pair', async (_request, reply) => {
    try {
      return await phone.pairInfo();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/phone/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return phone.removeDevice(id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // Board and phones both get it; each acts only when it is the target
  app.post('/api/device-handoff', async (request, reply) => {
    const body = (request.body ?? {}) as { consoleId?: unknown; to?: unknown };
    const to = body.to as DeviceTarget;
    if (typeof body.consoleId !== 'string' || (to !== 'desktop' && to !== 'phone')) {
      return reply.code(400).send({ error: 'consoleId and to ("desktop" or "phone") are required' });
    }
    if (!options.manager.get(body.consoleId)) return reply.code(404).send({ error: `Unknown console ${body.consoleId}` });
    const msg: ServerMessage = { type: 'device-handoff', consoleId: body.consoleId, to };
    options.broadcast(msg);
    phone.handoff(body.consoleId, to);
    return { ok: true };
  });

  return phone;
}
