import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import QRCode from 'qrcode';
import type { WebSocket } from 'ws';
import type {
  DeviceTarget,
  PhoneDevice,
  PhonePairInfo,
  PhoneStatus,
  ServerMessage,
} from '../../shared/protocol.js';
import type { ConsoleManager } from '../consoles.js';
import { readCookie } from '../security.js';
import { parseClientMessage } from '../client-message.js';
import { PhoneStore } from './phone-store.js';
import {
  isAllowedPhoneHost,
  isAllowedPhoneOrigin,
  localAddresses,
  PHONE_COOKIE,
  phoneCookie,
} from './phone-security.js';

// The phone server: a second Fastify instance on 0.0.0.0, started only when phone access is on.
// Paired phones get the phone page, a WebSocket with board events and terminals, and an allow-list
// of the board API (forwarded in-process to the 127.0.0.1 server with its token).
//
//   phone ──/m/api/<path>──► allow-list ──inject()──► board server /api/<path>
//   phone ──/m/ws──────────► console/action/project events, attach/input, device handoffs

// Everything a phone may do; anything else under /m/api is 404
const ALLOWED: [string, RegExp][] = [
  ['GET', /^\/api\/state$/],
  ['GET', /^\/api\/templates$/],
  ['POST', /^\/api\/templates\/[^/]+\/launch$/],
  ['POST', /^\/api\/consoles$/],
  ['POST', /^\/api\/consoles\/[^/]+\/(send|restart)$/],
  ['POST', /^\/api\/actions\/[^/]+\/answer$/],
  ['PATCH', /^\/api\/actions\/[^/]+$/],
  ['POST', /^\/api\/(pause|resume-paused)$/],
  ['POST', /^\/api\/projects\/[^/]+\/send$/],
  ['GET', /^\/api\/fs\/list$/],
  ['POST', /^\/api\/device-handoff$/],
];

export function isAllowedPhoneCall(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

// Board events a phone needs (no drawings, browser frames, usage...)
const FORWARDED_EVENTS = ['console', 'removed', 'action', 'actions-removed', 'project', 'project-removed'] as const;

export interface PhoneServiceOptions {
  main: FastifyInstance; // the board server (127.0.0.1)
  mainPort: number;
  mainToken: string;
  manager: ConsoleManager;
  store: PhoneStore;
  webRoot: string | null; // built UI (dist/web) with phone.html
  host?: string; // listen address, default every interface
  portOverride?: number; // tests: 0 = any free port
  addresses?: () => string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    phoneDevice?: PhoneDevice;
  }
}

export class PhoneService extends EventEmitter {
  private app: FastifyInstance | null = null;
  private listeningPort: number | null = null;
  private error: string | undefined;
  private sockets = new Map<WebSocket, string>(); // socket -> device id
  private readonly addresses: () => string[];

  constructor(private readonly options: PhoneServiceOptions) {
    super();
    this.addresses = options.addresses ?? (() => localAddresses());
  }

  private get port(): number {
    return this.listeningPort ?? this.options.portOverride ?? this.options.store.port;
  }

  status(): PhoneStatus {
    const online = new Set(this.sockets.values());
    return {
      enabled: this.options.store.enabled,
      port: this.port,
      listening: this.app !== null,
      ...(this.error ? { error: this.error } : {}),
      addresses: this.addresses().filter((ip) => !ip.startsWith('127.')),
      devices: this.options.store.devices().map((d) => ({ ...d, online: online.has(d.id) })),
    };
  }

  async setEnabled(enabled: boolean): Promise<PhoneStatus> {
    this.options.store.setEnabled(enabled);
    if (enabled) await this.start();
    else await this.stop();
    this.changed();
    return this.status();
  }

  async pairInfo(): Promise<PhonePairInfo> {
    if (!this.app) throw new Error('Turn on phone access first');
    const ip = this.addresses().find((a) => !a.startsWith('127.'));
    if (!ip) throw new Error('This computer has no Wi-Fi or network address. Connect it to the same Wi-Fi as your phone.');
    const { code, expiresAt } = this.options.store.newPairCode();
    const url = `http://${ip}:${this.port}/#pair=${code}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { url, qrSvg, expiresAt };
  }

  removeDevice(id: string): PhoneStatus {
    if (!this.options.store.removeDevice(id)) throw new Error(`Unknown phone ${id}`);
    // Its open pages lose the connection right away
    for (const [socket, deviceId] of this.sockets) if (deviceId === id) socket.close(4401, 'Removed');
    this.changed();
    return this.status();
  }

  handoff(consoleId: string, to: DeviceTarget): void {
    this.broadcast({ type: 'device-handoff', consoleId, to });
  }

  async start(): Promise<void> {
    if (this.app) return;
    this.error = undefined;
    const app = await this.build();
    try {
      await app.listen({ port: this.options.portOverride ?? this.options.store.port, host: this.options.host ?? '0.0.0.0' });
      const address = app.server.address();
      this.listeningPort = typeof address === 'object' && address ? address.port : null;
      this.app = app;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.error =
        code === 'EADDRINUSE'
          ? `Port ${this.options.store.port} is already used by another program`
          : `Could not start phone access: ${(err as Error).message}`;
      await app.close().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    this.listeningPort = null;
    for (const socket of this.sockets.keys()) socket.close(1001, 'Phone access turned off');
    this.sockets.clear();
    if (app) await app.close().catch(() => undefined);
  }

  private changed(): void {
    this.emit('change', this.status());
  }

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const socket of this.sockets.keys()) if (socket.readyState === socket.OPEN) socket.send(text);
  }

  private deviceFor(request: FastifyRequest): PhoneDevice | null {
    return this.options.store.deviceForToken(readCookie(request.headers.cookie, PHONE_COOKIE));
  }

  private async build(): Promise<FastifyInstance> {
    const { manager, main, mainPort, mainToken, store, webRoot } = this.options;
    const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

    app.addHook('onRequest', async (request, reply) => {
      const host = request.headers.host;
      if (!isAllowedPhoneHost(host, this.port, this.addresses())) return reply.code(403).send({ error: 'Forbidden host' });
      if (!isAllowedPhoneOrigin(request.headers.origin, host)) return reply.code(403).send({ error: 'Forbidden origin' });
      const url = request.url.split('?')[0];
      if (url === '/m/api/pair') return;
      if (url.startsWith('/m/')) {
        const device = this.deviceFor(request);
        if (!device) return reply.code(401).send({ error: 'This phone is not paired' });
        request.phoneDevice = device;
      }
    });

    await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

    app.post('/m/api/pair', async (request, reply) => {
      const body = (request.body ?? {}) as { code?: unknown; name?: unknown };
      const result = store.pair(body.code, body.name);
      if (result === 'rate-limited') return reply.code(429).send({ error: 'Too many attempts. Wait a minute.' });
      if (result === 'invalid') {
        return reply.code(401).send({ error: 'This pairing code is used or expired. Show a new QR code on the computer.' });
      }
      reply.header('set-cookie', phoneCookie(result.token));
      this.changed();
      return { device: result.device };
    });

    app.get('/m/api/me', async (request) => ({ device: request.phoneDevice }));

    // Allow-listed board API, forwarded in-process with the board's own token
    app.route({
      method: ['GET', 'POST', 'PATCH'],
      url: '/m/api/*',
      handler: async (request, reply) => {
        const [path, query] = request.url.slice('/m'.length).split('?', 2);
        if (!isAllowedPhoneCall(request.method, path)) return reply.code(404).send({ error: 'Not available from a phone' });
        const res = await main.inject({
          method: request.method as 'GET' | 'POST' | 'PATCH',
          url: query ? `${path}?${query}` : path,
          headers: { host: `127.0.0.1:${mainPort}`, 'x-agentarmy-token': mainToken, 'content-type': 'application/json' },
          ...(request.method === 'GET' ? {} : { payload: JSON.stringify(request.body ?? {}) }),
        });
        return reply
          .code(res.statusCode)
          .type(String(res.headers['content-type'] ?? 'application/json'))
          .send(res.rawPayload);
      },
    });

    app.get('/m/ws', { websocket: true }, (socket, request) => {
      const deviceId = request.phoneDevice!.id;
      this.sockets.set(socket, deviceId);
      this.changed();
      const send = (msg: ServerMessage): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const unsubscribe = FORWARDED_EVENTS.map((event) => {
        const handler = (payload: unknown): void => {
          if (event === 'console') send({ type: 'console', console: payload as never });
          else if (event === 'removed') send({ type: 'removed', id: payload as string });
          else if (event === 'action') send({ type: 'action', action: payload as never });
          else if (event === 'actions-removed') send({ type: 'actions-removed', ids: payload as string[] });
          else if (event === 'project') send({ type: 'project', project: payload as never });
          else send({ type: 'project-removed', id: payload as string });
        };
        manager.on(event, handler);
        return () => manager.off(event, handler);
      });
      const listeners = new Map<string, (data: string) => void>();

      socket.on('message', (raw) => {
        const msg = parseClientMessage(raw);
        if (!msg) return;
        switch (msg.type) {
          case 'attach': {
            if (listeners.has(msg.id) || !manager.get(msg.id)) return;
            const listener = (data: string): void => send({ type: 'output', id: msg.id, data });
            const replay = manager.attach(msg.id, listener);
            listeners.set(msg.id, listener);
            send({ type: 'replay', id: msg.id, data: replay, ...(manager.size(msg.id) ?? {}) });
            return;
          }
          case 'detach': {
            const listener = listeners.get(msg.id);
            if (listener) manager.detach(msg.id, listener);
            listeners.delete(msg.id);
            return;
          }
          case 'input':
            manager.input(msg.id, msg.data);
            return;
          // A phone never resizes the PTY: the computer's board keeps the terminal size it shows
          case 'resize':
            return;
        }
      });

      socket.on('close', () => {
        this.sockets.delete(socket);
        for (const off of unsubscribe) off();
        for (const [id, listener] of listeners) manager.detach(id, listener);
        listeners.clear();
        this.changed();
      });
    });

    if (webRoot) {
      await app.register(fastifyStatic, { root: webRoot, wildcard: false, index: false });
    }
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0];
      if (request.method !== 'GET' || url.startsWith('/m/')) return reply.code(404).send({ error: 'Not found' });
      if (!webRoot) return reply.code(404).type('text/plain').send('UI not built. Run "npm run build" first.');
      return reply.sendFile('phone.html');
    });

    return app;
  }
}
