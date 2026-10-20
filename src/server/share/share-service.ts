import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ConsoleInfo, Project, ShareCursorEvent, ShareGuestView, ShareStatus } from '../../shared/protocol.js';
import {
  importShareKey,
  newShareKey,
  open,
  peerColor,
  seal,
  type GuestMessage,
  type OwnerMessage,
  type ShareConsole,
  type ShareCursor,
  type ShareLevel,
  type SharePeer,
  type ShareProject,
} from '../../shared/share-crypto.js';
import type { ConsoleManager } from '../consoles.js';
import type { CloudLink } from '../cloud.js';

// Live sharing, phase 1 (Viewer): this computer hosts each share. It connects out to the relay room
// s_<id>, sends guests a board snapshot, live updates, terminal output of consoles they open, and
// everyone's pointers. Guests can only watch, point and follow; any other message is ignored here,
// whatever their app sends. Everything is sealed with the share key (see share-crypto.ts).

export interface StoredShare {
  id: string;
  url: string; // https://gridhive.dev/s/<id> (without the key)
  key: string; // AES key, only in shares.json (0600) and the link after "#"
  level: ShareLevel;
  title: string;
  expiresAt: string | null;
  createdAt: number;
}

interface Connection {
  share: StoredShare;
  key: CryptoKey;
  ws: WebSocket | null;
  self: string; // our device id in the room
  guests: Map<string, ShareGuestView>;
  attached: Map<string, Map<string, (data: string) => void>>; // guest -> console -> listener
  outBuffers: Map<string, Map<string, string>>; // guest -> console -> pending output
  flushTimer: NodeJS.Timeout | null;
  retry: number;
  retryTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface ShareServiceOptions {
  manager: ConsoleManager;
  cloud: CloudLink;
  filePath: string | null;
  siteUrl: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

const MAX_REPLAY = 200_000;
const MAX_OUT_CHUNK = 64_000;
const FLUSH_MS = 60;

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

export function toShareConsole(c: ConsoleInfo): ShareConsole {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    ...(c.statusDetail ? { statusDetail: c.statusDetail } : {}),
    ...(c.activity ? { activity: c.activity } : {}),
    ...(c.agent ? { agent: c.agent } : {}),
    ...(c.role ? { role: c.role } : {}),
    ...(c.model ? { model: c.model } : {}),
    projectId: c.projectId ?? null,
    folder: folderName(c.cwd),
    layout: { x: c.layout.x, y: c.layout.y, width: c.layout.width, height: c.layout.height },
    ...(c.todos?.length ? { todos: c.todos.map((t) => ({ content: t.content, status: t.status })) } : {}),
  };
}

export function toShareProject(p: Project): ShareProject {
  return { id: p.id, name: p.name, ...(p.color ? { color: p.color } : {}), consoleIds: p.consoleIds };
}

// What a viewer may send; everything else is dropped (phase 1)
export function allowedGuestMessage(raw: unknown): GuestMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'hello':
      return { t: 'hello' };
    case 'attach':
    case 'detach':
      return typeof m.id === 'string' && m.id.length < 100 ? { t: m.t, id: m.id } : null;
    case 'cursor': {
      if (m.c === null) return { t: 'cursor', c: null };
      const c = m.c as Record<string, unknown> | undefined;
      const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
      if (!c || !num(c.x) || !num(c.y)) return null;
      const cursor: ShareCursor = { x: c.x as number, y: c.y as number };
      if (num(c.vx) && num(c.vy) && num(c.vz)) Object.assign(cursor, { vx: c.vx, vy: c.vy, vz: c.vz });
      return { t: 'cursor', c: cursor };
    }
    default:
      return null;
  }
}

export class ShareService extends EventEmitter {
  private shares: StoredShare[];
  private conns = new Map<string, Connection>();
  private error: string | undefined;
  private names = new Map<string, string>(); // guest dev -> display name
  private ownerName = 'Host';
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;

  constructor(private readonly options: ShareServiceOptions) {
    super();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WS = options.WebSocketImpl ?? WebSocket;
    this.shares = this.load();
    this.ownerName = options.cloud.status().user?.name || options.cloud.status().user?.email || 'Host';
    const m = options.manager;
    m.on('console', (c: ConsoleInfo) => this.toAllGuests({ t: 'console', console: toShareConsole(c) }));
    m.on('removed', (id: string) => this.toAllGuests({ t: 'removed', id }));
    m.on('project', (p: Project) => this.toAllGuests({ t: 'project', project: toShareProject(p) }));
    m.on('project-removed', (id: string) => this.toAllGuests({ t: 'project-removed', id }));
  }

  start(): void {
    if (!this.options.cloud.credentials()) return;
    for (const share of this.activeShares()) void this.connect(share);
  }

  stop(): void {
    for (const conn of this.conns.values()) this.disconnect(conn);
    this.conns.clear();
  }

  status(): ShareStatus {
    return {
      linked: !!this.options.cloud.credentials(),
      shares: this.activeShares().map((s) => {
        const conn = this.conns.get(s.id);
        return {
          id: s.id,
          link: `${s.url}#k=${s.key}`,
          level: s.level,
          title: s.title,
          expiresAt: s.expiresAt,
          connected: conn?.ws?.readyState === 1,
          guests: conn ? [...conn.guests.values()] : [],
        };
      }),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async create(body: { title?: string; expiresInHours?: number }): Promise<ShareStatus> {
    const creds = this.options.cloud.credentials();
    if (!creds) throw new Error('Sign in to GridHive on this computer first (Settings > General)');
    const res = await this.fetchImpl(`${this.options.siteUrl}/api/shares`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.deviceSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: body.title, level: 'viewer', expiresInHours: body.expiresInHours }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; url?: string; level?: ShareLevel; expiresAt?: string | null; error?: string };
    if (!res.ok || !data.id || !data.url) throw new Error(data.error ?? `gridhive.dev answered ${res.status}`);
    const share: StoredShare = {
      id: data.id,
      url: data.url,
      key: newShareKey(),
      level: data.level ?? 'viewer',
      title: (body.title || 'GridHive board').slice(0, 80),
      expiresAt: data.expiresAt ?? null,
      createdAt: Date.now(),
    };
    this.shares.push(share);
    this.save();
    void this.connect(share);
    this.changed();
    return this.status();
  }

  async revoke(id: string): Promise<ShareStatus> {
    const share = this.shares.find((s) => s.id === id);
    if (!share) throw new Error(`Unknown share ${id}`);
    const creds = this.options.cloud.credentials();
    if (creds) {
      await this.fetchImpl(`${this.options.siteUrl}/api/shares?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${creds.deviceSecret}` },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
    }
    const conn = this.conns.get(id);
    if (conn) {
      for (const dev of conn.guests.keys()) void this.send(conn, dev, { t: 'bye', reason: 'The owner stopped sharing' });
      this.disconnect(conn);
      this.conns.delete(id);
    }
    this.shares = this.shares.filter((s) => s.id !== id);
    this.save();
    this.changed();
    return this.status();
  }

  // The owner's own pointer, from the board UI
  localCursor(c: ShareCursor | null): void {
    for (const conn of this.conns.values()) {
      for (const dev of conn.guests.keys()) void this.send(conn, dev, { t: 'cursor', dev: conn.self, c });
    }
  }

  private activeShares(): StoredShare[] {
    const now = Date.now();
    return this.shares.filter((s) => !s.expiresAt || new Date(s.expiresAt).getTime() > now);
  }

  private changed(): void {
    this.emit('change', this.status());
  }

  private async connect(share: StoredShare): Promise<void> {
    const creds = this.options.cloud.credentials();
    if (!creds) return;
    let conn = this.conns.get(share.id);
    if (!conn) {
      conn = {
        share,
        key: await importShareKey(share.key),
        ws: null,
        self: creds.deviceId,
        guests: new Map(),
        attached: new Map(),
        outBuffers: new Map(),
        flushTimer: null,
        retry: 0,
        retryTimer: null,
        closed: false,
      };
      this.conns.set(share.id, conn);
    }
    const live = conn;
    try {
      const res = await this.fetchImpl(`${this.options.siteUrl}/api/relay/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.deviceSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ share: share.id }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json()) as { token?: string; relayUrl?: string; dev?: string; error?: string };
      if (res.status === 404) {
        // Revoked or expired on gridhive.dev
        this.shares = this.shares.filter((s) => s.id !== share.id);
        this.save();
        this.conns.delete(share.id);
        this.changed();
        return;
      }
      if (!res.ok || !data.token || !data.relayUrl) throw new Error(data.error ?? `gridhive.dev answered ${res.status}`);
      if (live.closed) return;
      live.self = data.dev ?? creds.deviceId;
      const ws = new this.WS(`${data.relayUrl}?token=${encodeURIComponent(data.token)}`);
      live.ws = ws;
      ws.addEventListener('open', () => {
        live.retry = 0;
        this.error = undefined;
        this.changed();
      });
      ws.addEventListener('message', (event) => void this.onFrame(live, String(event.data)));
      ws.addEventListener('close', () => {
        this.dropAllGuests(live);
        if (!live.closed) this.reconnectLater(live);
        this.changed();
      });
    } catch (err) {
      this.error = `Sharing is offline: ${(err as Error).message}`;
      this.reconnectLater(live);
      this.changed();
    }
  }

  private reconnectLater(conn: Connection): void {
    if (conn.closed || conn.retryTimer) return;
    const delay = Math.min(60_000, 1000 * 2 ** conn.retry++);
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = null;
      void this.connect(conn.share);
    }, delay);
    conn.retryTimer.unref?.();
  }

  private disconnect(conn: Connection): void {
    conn.closed = true;
    if (conn.retryTimer) clearTimeout(conn.retryTimer);
    if (conn.flushTimer) clearTimeout(conn.flushTimer);
    this.dropAllGuests(conn);
    try {
      conn.ws?.close();
    } catch {
      // already closed
    }
  }

  private dropAllGuests(conn: Connection): void {
    for (const dev of [...conn.guests.keys()]) this.dropGuest(conn, dev);
  }

  private dropGuest(conn: Connection, dev: string): void {
    for (const [id, listener] of conn.attached.get(dev) ?? []) this.options.manager.detach(id, listener);
    conn.attached.delete(dev);
    conn.outBuffers.delete(dev);
    conn.guests.delete(dev);
    this.emit('cursor', { share: conn.share.id, dev, name: '', color: '', c: null } satisfies ShareCursorEvent);
  }

  private async onFrame(conn: Connection, raw: string): Promise<void> {
    let frame: { type?: string; devices?: { id: string; kind: string }[]; from?: string; nonce?: string; box?: string };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === 'presence' && Array.isArray(frame.devices)) {
      const present = new Set(frame.devices.filter((d) => d.kind === 'guest').map((d) => d.id));
      for (const dev of [...conn.guests.keys()]) if (!present.has(dev)) this.dropGuest(conn, dev);
      const fresh = [...present].filter((dev) => !conn.guests.has(dev));
      if (fresh.length) await this.lookupNames(conn);
      for (const dev of fresh) conn.guests.set(dev, { dev, name: this.names.get(dev) ?? 'Guest', color: peerColor(dev) });
      this.sendPeers(conn);
      this.changed();
      return;
    }
    if (!frame.from || !frame.nonce || !frame.box || !conn.guests.has(frame.from)) return;
    const message = allowedGuestMessage(await open(conn.key, frame.from, conn.self, frame.nonce, frame.box));
    if (!message) return;
    const dev = frame.from;
    switch (message.t) {
      case 'hello':
        await this.sendSnapshot(conn, dev);
        return;
      case 'attach':
        this.attach(conn, dev, message.id);
        return;
      case 'detach': {
        const listener = conn.attached.get(dev)?.get(message.id);
        if (listener) this.options.manager.detach(message.id, listener);
        conn.attached.get(dev)?.delete(message.id);
        return;
      }
      case 'cursor': {
        const guest = conn.guests.get(dev);
        for (const other of conn.guests.keys()) if (other !== dev) void this.send(conn, other, { t: 'cursor', dev, c: message.c });
        this.emit('cursor', { share: conn.share.id, dev, name: guest?.name ?? 'Guest', color: guest?.color ?? peerColor(dev), c: message.c });
        return;
      }
    }
  }

  private async lookupNames(conn: Connection): Promise<void> {
    const creds = this.options.cloud.credentials();
    if (!creds) return;
    try {
      const res = await this.fetchImpl(`${this.options.siteUrl}/api/shares?guests=${encodeURIComponent(conn.share.id)}`, {
        headers: { authorization: `Bearer ${creds.deviceSecret}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { guests?: { dev: string; name: string | null; email: string }[] };
      for (const g of data.guests ?? []) this.names.set(g.dev, g.name || g.email.split('@')[0]);
    } catch {
      // names stay "Guest" until the next presence change
    }
  }

  private peers(conn: Connection): SharePeer[] {
    return [
      { dev: conn.self, name: this.ownerName, color: peerColor(conn.self), owner: true },
      ...[...conn.guests.values()].map((g) => ({ dev: g.dev, name: g.name, color: g.color })),
    ];
  }

  private sendPeers(conn: Connection): void {
    const peers = this.peers(conn);
    for (const dev of conn.guests.keys()) void this.send(conn, dev, { t: 'peers', peers });
  }

  private async sendSnapshot(conn: Connection, dev: string): Promise<void> {
    const state = this.options.manager.getState();
    const guest = conn.guests.get(dev);
    await this.send(conn, dev, {
      t: 'snapshot',
      title: conn.share.title,
      level: conn.share.level,
      consoles: state.consoles.map(toShareConsole),
      projects: state.projects.map(toShareProject),
      you: { dev, name: guest?.name ?? 'Guest', color: peerColor(dev) },
      peers: this.peers(conn),
    });
  }

  private attach(conn: Connection, dev: string, consoleId: string): void {
    const manager = this.options.manager;
    if (!manager.get(consoleId)) return;
    let mine = conn.attached.get(dev);
    if (!mine) conn.attached.set(dev, (mine = new Map()));
    if (mine.has(consoleId)) return;
    const listener = (data: string): void => this.queueOutput(conn, dev, consoleId, data);
    const replay = manager.attach(consoleId, listener);
    mine.set(consoleId, listener);
    const size = manager.size(consoleId) ?? { cols: 100, rows: 30 };
    void this.send(conn, dev, { t: 'replay', id: consoleId, data: replay.slice(-MAX_REPLAY), cols: size.cols, rows: size.rows });
  }

  private queueOutput(conn: Connection, dev: string, id: string, data: string): void {
    let buffers = conn.outBuffers.get(dev);
    if (!buffers) conn.outBuffers.set(dev, (buffers = new Map()));
    buffers.set(id, (buffers.get(id) ?? '') + data);
    if (!conn.flushTimer) conn.flushTimer = setTimeout(() => this.flush(conn), FLUSH_MS);
  }

  private flush(conn: Connection): void {
    conn.flushTimer = null;
    for (const [dev, buffers] of conn.outBuffers) {
      for (const [id, data] of buffers) {
        for (let i = 0; i < data.length; i += MAX_OUT_CHUNK) void this.send(conn, dev, { t: 'out', id, data: data.slice(i, i + MAX_OUT_CHUNK) });
      }
      buffers.clear();
    }
  }

  private toAllGuests(message: OwnerMessage): void {
    for (const conn of this.conns.values()) for (const dev of conn.guests.keys()) void this.send(conn, dev, message);
  }

  private async send(conn: Connection, to: string, message: OwnerMessage): Promise<void> {
    if (conn.ws?.readyState !== 1) return;
    const frame = await seal(conn.key, conn.self, to, message);
    try {
      conn.ws.send(JSON.stringify(frame));
    } catch {
      // closing
    }
  }

  private load(): StoredShare[] {
    if (!this.options.filePath) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.options.filePath, 'utf8')) as { shares?: StoredShare[] };
      return (data.shares ?? []).filter((s) => typeof s.id === 'string' && typeof s.key === 'string');
    } catch {
      return [];
    }
  }

  // 0600: the file holds the share keys
  private save(): void {
    if (!this.options.filePath) return;
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    fs.writeFileSync(this.options.filePath, JSON.stringify({ version: 1, shares: this.shares }, null, 2), { mode: 0o600 });
  }
}
