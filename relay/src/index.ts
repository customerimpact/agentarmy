import { DurableObject } from 'cloudflare:workers';
import { RelayHub, type Peer } from './hub';
import { importPublicKey, verifyRelayToken, type DeviceKind } from './token';

// gridhive-relay: wss://<worker>/v1/connect?token=<relay token>
// One Durable Object per account forwards end-to-end encrypted frames between its devices.
// POST /v1/revoke { token } with a token of the removed device (signed by gridhive.dev)
// drops that device right away instead of waiting for its token to expire.

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  RELAY_PUBLIC_KEY: string; // Ed25519, raw, base64url (not secret)
}

let cachedKey: { raw: string; key: Promise<CryptoKey> } | null = null;
function publicKey(env: Env): Promise<CryptoKey> {
  if (cachedKey?.raw !== env.RELAY_PUBLIC_KEY) cachedKey = { raw: env.RELAY_PUBLIC_KEY, key: importPublicKey(env.RELAY_PUBLIC_KEY) };
  return cachedKey.key;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json(200, { ok: true, keyConfigured: !!env.RELAY_PUBLIC_KEY });
    if (!env.RELAY_PUBLIC_KEY) return json(503, { error: 'Relay key not configured' });

    if (url.pathname === '/v1/connect') {
      if (request.headers.get('upgrade') !== 'websocket') return json(426, { error: 'WebSocket upgrade required' });
      const claims = await verifyRelayToken(url.searchParams.get('token') ?? '', await publicKey(env), Date.now() / 1000);
      if (!claims) return json(401, { error: 'Invalid or expired token' });
      const stub = env.RELAY.get(env.RELAY.idFromName(claims.sub));
      return stub.fetch('https://relay/connect', {
        headers: { upgrade: 'websocket', 'x-device': claims.dev, 'x-kind': claims.kind },
      });
    }

    if (url.pathname === '/v1/revoke' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { token?: string };
      const claims = await verifyRelayToken(body.token ?? '', await publicKey(env), Date.now() / 1000);
      if (!claims) return json(401, { error: 'Invalid or expired token' });
      await env.RELAY.get(env.RELAY.idFromName(claims.sub)).revoke(claims.dev);
      return json(200, { ok: true });
    }

    return json(404, { error: 'Not found' });
  },
} satisfies ExportedHandler<Env>;

// Hibernatable WebSockets: the object sleeps between frames and is billed only while it works
export class Relay extends DurableObject<Env> {
  private hub = new RelayHub();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // After waking up, rebuild the peer list from the sockets that survived hibernation
    for (const ws of ctx.getWebSockets()) {
      const [id, kind] = ctx.getTags(ws);
      if (id && kind) this.hub.join(this.peer(ws, id, kind as DeviceKind));
    }
  }

  private peer(ws: WebSocket, id: string, kind: DeviceKind): Peer {
    return {
      id,
      kind,
      send: (text) => {
        try {
          ws.send(text);
        } catch {
          // closed in the meantime
        }
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          // already closed
        }
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const id = request.headers.get('x-device') ?? '';
    const kind = request.headers.get('x-kind') as DeviceKind;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [id, kind]);
    this.hub.join(this.peer(server, id, kind));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [id] = this.ctx.getTags(ws);
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const error = this.hub.forward(id, text);
    if (error) ws.send(JSON.stringify({ type: 'error', error }));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const [id] = this.ctx.getTags(ws);
    this.hub.leave(id);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const [id] = this.ctx.getTags(ws);
    this.hub.leave(id);
  }

  async revoke(deviceId: string): Promise<void> {
    this.hub.revoke(deviceId);
  }
}
