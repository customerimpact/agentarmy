import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { RelayHub } from '../../../relay/src/hub';
import { REPO_ROOT } from './server';

// A stand-in for gridhive.dev + the Cloudflare relay, for e2e tests of live sharing:
// serves the built viewer (site/app) and the API calls the app and the viewer make, and relays
// frames with the real RelayHub rules. Tokens are plain "<kind>:<dev>" here.

const OWNER_DEVICE = 'pc1';
const GUEST_DEV = 'g_tim';
export const GUEST_COOKIE = 'gh_session=guest-tim';

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

export interface FakeCloud {
  url: string;
  close(): Promise<void>;
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const shares = new Map<string, { title: string }>();
  const hub = new RelayHub();
  let base = '';

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
    });
  const serveFile = (res: http.ServerResponse, file: string) => {
    if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const owner = req.headers.authorization === 'Bearer owner-secret';
    const guest = (req.headers.cookie ?? '').includes(GUEST_COOKIE);
    if (url.pathname.startsWith('/s/')) return serveFile(res, path.join(REPO_ROOT, 'site', 'app', 'viewer.html'));
    if (url.pathname.startsWith('/app/')) return serveFile(res, path.join(REPO_ROOT, 'site', url.pathname));
    if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.svg') return serveFile(res, path.join(REPO_ROOT, 'site', url.pathname));
    if (url.pathname === '/api/auth/session') return json(res, 200, { user: guest ? { id: 'u2', email: 'tim@example.dev', name: 'Tim' } : null });
    if (url.pathname === '/api/shares' && req.method === 'POST' && owner) {
      const body = await readBody(req);
      const id = 'abcdefghijkl';
      shares.set(id, { title: String(body.title ?? 'GridHive board') });
      return json(res, 200, { id, url: `${base}/s/${id}`, level: 'viewer', expiresAt: null });
    }
    if (url.pathname === '/api/shares' && req.method === 'GET' && owner && url.searchParams.get('guests')) {
      return json(res, 200, { guests: [{ dev: GUEST_DEV, name: 'Tim', email: 'tim@example.dev' }] });
    }
    if (url.pathname === '/api/shares' && req.method === 'DELETE' && owner) {
      shares.delete(url.searchParams.get('id') ?? '');
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/shares/info') {
      const share = shares.get(url.searchParams.get('id') ?? '');
      return share ? json(res, 200, { id: 'abcdefghijkl', level: 'viewer', title: share.title, owner: 'Owner', ownerDevice: OWNER_DEVICE }) : json(res, 404, { error: 'This share link has expired or was turned off' });
    }
    if (url.pathname === '/api/relay/token' && req.method === 'POST') {
      const body = await readBody(req);
      if (!shares.has(String(body.share))) return json(res, 404, { error: 'expired' });
      const relayUrl = `${base.replace('http', 'ws')}/v1/connect`;
      if (owner) return json(res, 200, { token: `computer:${OWNER_DEVICE}`, relayUrl, dev: OWNER_DEVICE, kind: 'computer' });
      if (guest) return json(res, 200, { token: `guest:${GUEST_DEV}`, relayUrl, dev: GUEST_DEV, kind: 'guest', level: 'viewer', ownerDevice: OWNER_DEVICE });
      return json(res, 401, { error: 'Sign in first' });
    }
    return json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ server, path: '/v1/connect' });
  wss.on('connection', (ws, req) => {
    const [kind, dev] = (new URL(req.url ?? '', base).searchParams.get('token') ?? '').split(':');
    const peer = { id: dev, kind: kind as 'computer' | 'guest', send: (t: string) => ws.send(t), close: () => ws.close() };
    hub.join(peer);
    ws.on('message', (raw) => hub.forward(dev, String(raw)));
    ws.on('close', () => hub.leave(dev, peer));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: base,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

// cloud.json for a temp home, as if this computer had been linked to an account
export function writeLinkedCloud(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'cloud.json'),
    JSON.stringify({ version: 1, deviceId: OWNER_DEVICE, deviceSecret: 'owner-secret', user: { email: 'owner@example.dev', name: 'Owner' }, linkedAt: Date.now() }),
  );
}
