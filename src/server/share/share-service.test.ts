import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { RelayHub } from '../../../relay/src/hub';
import { importShareKey, open, seal, type OwnerMessage } from '../../shared/share-crypto';
import type { ShareCursorEvent } from '../../shared/protocol';
import { ConsoleManager } from '../consoles';
import type { CloudLink } from '../cloud';
import { allowedGuestMessage, ShareService } from './share-service';

// A local relay with the real forwarding rules; the token is just "<kind>:<dev>"
function startRelay(): Promise<{ url: string; close: () => void }> {
  const hub = new RelayHub();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? '';
    const [kind, dev] = token.split(':');
    const peer = { id: dev, kind: kind as 'computer' | 'guest', send: (t: string) => ws.send(t), close: () => ws.close() };
    hub.join(peer);
    ws.on('message', (raw) => {
      const error = hub.forward(dev, String(raw));
      if (error) ws.send(JSON.stringify({ type: 'error', error }));
    });
    ws.on('close', () => hub.leave(dev, peer));
  });
  return new Promise((resolve) =>
    wss.on('listening', () => {
      const { port } = wss.address() as { port: number };
      resolve({ url: `ws://127.0.0.1:${port}/v1/connect`, close: () => wss.close() });
    }),
  );
}

describe('ShareService (Viewer)', () => {
  let relay: { url: string; close: () => void };
  let manager: ConsoleManager;
  let service: ShareService;
  let consoleId = '';

  beforeAll(async () => {
    relay = await startRelay();
    manager = new ConsoleManager({ port: 1, token: 't', onChange: () => {} });
    consoleId = manager.create({ cwd: os.tmpdir(), name: 'Ada', agent: 'custom', command: 'node -e "console.log(\'hello from Ada\');setInterval(()=>{},1000)"' }).id;
    const cloud = { credentials: () => ({ deviceId: 'pc1', deviceSecret: 's' }), status: () => ({ user: { email: 'owner@x.io', name: 'Owner' } }) } as unknown as CloudLink;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/shares' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'abcdefghijkl', url: 'https://site.test/s/abcdefghijkl', level: 'viewer', expiresAt: null }));
      }
      if (u.pathname === '/api/relay/token') return new Response(JSON.stringify({ token: 'computer:pc1', relayUrl: relay.url, dev: 'pc1' }));
      if (u.searchParams.get('guests')) return new Response(JSON.stringify({ guests: [{ dev: 'g_tim', name: 'Tim', email: 'tim@x.io' }] }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    service = new ShareService({ manager, cloud, filePath: null, siteUrl: 'https://site.test', fetchImpl, WebSocketImpl: WsClient as unknown as typeof WebSocket });
  });

  afterAll(() => {
    service.stop();
    manager.remove(consoleId);
    relay.close();
  });

  it('only lets a viewer say hello, open consoles and point', () => {
    expect(allowedGuestMessage({ t: 'hello' })).toEqual({ t: 'hello' });
    expect(allowedGuestMessage({ t: 'cursor', c: { x: 1, y: 2, vx: 0, vy: 0, vz: 1 } })).toEqual({ t: 'cursor', c: { x: 1, y: 2, vx: 0, vy: 0, vz: 1 } });
    expect(allowedGuestMessage({ t: 'input', id: 'c1', data: 'rm -rf /\r' })).toBeNull();
    expect(allowedGuestMessage({ t: 'launch' })).toBeNull();
    expect(allowedGuestMessage({ t: 'cursor', c: { x: 'a', y: 2 } })).toBeNull();
  });

  it('a guest gets the board, a terminal and the owner pointer; their pointer reaches the owner', async () => {
    const status = await service.create({ title: 'Shop' });
    const link = status.shares[0].link;
    expect(link).toMatch(/^https:\/\/site\.test\/s\/abcdefghijkl#k=[A-Za-z0-9_-]{43}$/);
    const key = await importShareKey(link.split('#k=')[1]);
    await expect.poll(() => service.status().shares[0].connected, { timeout: 10_000 }).toBe(true);

    const guest = new WsClient(`${relay.url}?token=guest:g_tim`);
    const inbox: OwnerMessage[] = [];
    guest.on('message', async (raw) => {
      const frame = JSON.parse(String(raw)) as { from?: string; nonce?: string; box?: string };
      if (!frame.from) return;
      const msg = (await open(key, frame.from, 'g_tim', frame.nonce!, frame.box!)) as OwnerMessage | null;
      if (msg) inbox.push(msg);
    });
    await new Promise((r) => guest.once('open', r));
    const say = async (m: unknown) => guest.send(JSON.stringify(await seal(key, 'g_tim', 'pc1', m)));
    await expect.poll(() => service.status().shares[0].guests.map((g) => g.name), { timeout: 10_000 }).toEqual(['Tim']);

    await say({ t: 'hello' });
    await expect.poll(() => inbox.find((m) => m.t === 'snapshot'), { timeout: 10_000 }).toBeTruthy();
    const snapshot = inbox.find((m) => m.t === 'snapshot') as Extract<OwnerMessage, { t: 'snapshot' }>;
    expect(snapshot.consoles.map((c) => c.name)).toEqual(['Ada']);
    expect(snapshot.consoles[0]).not.toHaveProperty('cwd');
    expect(snapshot.peers.map((p) => p.name)).toEqual(['Owner', 'Tim']);

    await say({ t: 'attach', id: consoleId });
    await expect.poll(() => inbox.filter((m) => m.t === 'replay' || m.t === 'out').map((m) => ('data' in m ? m.data : '')).join(''), { timeout: 10_000 }).toContain('hello from Ada');

    const cursors: ShareCursorEvent[] = [];
    service.on('cursor', (c: ShareCursorEvent) => cursors.push(c));
    await say({ t: 'cursor', c: { x: 10, y: 20 } });
    await expect.poll(() => cursors.at(-1), { timeout: 10_000 }).toMatchObject({ dev: 'g_tim', name: 'Tim', c: { x: 10, y: 20 } });

    // Typing is not something a viewer can do: nothing reaches the console
    const before = manager.get(consoleId)!.status;
    await say({ t: 'input', id: consoleId, data: 'exit\r' });
    service.localCursor({ x: 5, y: 6 });
    await expect.poll(() => inbox.find((m) => m.t === 'cursor'), { timeout: 10_000 }).toMatchObject({ t: 'cursor', dev: 'pc1', c: { x: 5, y: 6 } });
    expect(manager.get(consoleId)!.status).toBe(before);
    guest.close();
    await expect.poll(() => service.status().shares[0].guests, { timeout: 10_000 }).toEqual([]);
  });
});
