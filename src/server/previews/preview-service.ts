import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BrowserTile, PreviewMode, PreviewOffer, ServerMessage } from '../../shared/protocol.js';
import type { ConsoleManager } from '../consoles.js';
import type { TileRequest } from '../browsers/browser-service.js';
import { detectDevUrls, isLocalUrl, originOf, terminalText, type DevUrl } from './detect.js';
import { waitForPort } from './port-check.js';

// Auto dev previews: an agent starts a dev server, its console prints "Local: http://localhost:5173/",
// and a live browser tile opens next to the console (or its linked tile navigates there).
// Nothing happens until the port really accepts connections, so a URL in plain prose is ignored.

export interface PreviewBrowsers {
  tileForConsole(consoleId: string): BrowserTile | undefined;
  createTile(req: TileRequest): BrowserTile;
  updateTile(id: string, req: TileRequest): Promise<BrowserTile | undefined>;
  userActivity(id: string): { at: number; nav: boolean } | undefined;
  session?(id: string): Promise<unknown>; // launch the tile's browser now, even while it is off screen
}

export interface PreviewOptions {
  manager: ConsoleManager;
  browsers: PreviewBrowsers;
  settings: () => { autoPreview: boolean; previewMode: PreviewMode };
  broadcast: (msg: ServerMessage) => void;
  ignorePorts?: number[]; // our own server port: hook/bridge URLs show up in agent output
  onOpened?: (consoleId: string, url: string, how: 'created' | 'navigated') => void;
  portCheck?: (url: DevUrl) => Promise<boolean>;
  now?: () => number;
  debounceMs?: number; // scan once output is quiet this long...
  maxWaitMs?: number; // ...or at least this often while it keeps streaming
}

export const USER_NAV_GRACE_MS = 2 * 60_000; // a tile the user drove recently is left alone
const RAW_LIMIT = 16_384;
const RAW_KEEP = 600; // tail kept between scans so a URL split across chunks is still found
const RETRY_FAILED_MS = 60_000;

type OriginState = 'checking' | 'done' | { failedAt: number };

interface Watch {
  raw: string;
  timer: NodeJS.Timeout | null;
  firstAt: number;
  lastAt: number;
  origins: Map<string, OriginState>;
}

export type OpenResult = 'created' | 'navigated' | 'already-there' | 'user-busy' | 'not-local' | 'gone';

export class PreviewService {
  private watches = new Map<string, Watch>();
  private offers = new Map<string, PreviewOffer>();
  private autoOpened = new Map<string, string>(); // tile id -> origin we last sent it to
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: PreviewOptions) {
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? 400;
    this.maxWaitMs = options.maxWaitMs ?? 1500;
    options.manager.on('output', (id, data) => this.onOutput(id, data));
    options.manager.on('removed', (id) => this.forget(id));
  }

  listOffers(): PreviewOffer[] {
    return [...this.offers.values()];
  }

  onOutput(consoleId: string, data: string): void {
    if (!this.options.settings().autoPreview) return;
    let watch = this.watches.get(consoleId);
    if (!watch) {
      watch = { raw: '', timer: null, firstAt: 0, lastAt: 0, origins: new Map() };
      this.watches.set(consoleId, watch);
    }
    const now = this.now();
    watch.raw = (watch.raw + data).slice(-RAW_LIMIT);
    watch.lastAt = now;
    if (!watch.timer) watch.firstAt = now;
    else if (now - watch.firstAt < this.maxWaitMs) clearTimeout(watch.timer);
    else return; // a scan is due soon anyway
    const w = watch;
    w.timer = setTimeout(() => {
      w.timer = null;
      this.scan(consoleId, this.now() - w.lastAt >= this.debounceMs);
    }, this.debounceMs);
    w.timer.unref?.();
  }

  // complete: output went quiet, so a URL at the very end is finished
  scan(consoleId: string, complete = true): DevUrl[] {
    const watch = this.watches.get(consoleId);
    if (!watch) return [];
    const text = terminalText(watch.raw);
    watch.raw = watch.raw.slice(-RAW_KEEP);
    const found = detectDevUrls(text, { ignorePorts: this.options.ignorePorts, complete });
    const fresh: DevUrl[] = [];
    for (const url of found) {
      const state = watch.origins.get(url.origin);
      if (state === 'checking' || state === 'done') continue;
      if (state && this.now() - state.failedAt < RETRY_FAILED_MS) continue;
      watch.origins.set(url.origin, 'checking');
      fresh.push(url);
      void this.verify(consoleId, watch, url);
    }
    return fresh;
  }

  private async verify(consoleId: string, watch: Watch, url: DevUrl): Promise<void> {
    const check = this.options.portCheck ?? ((u: DevUrl) => waitForPort(u.host, u.port, { timeoutMs: 20_000 }));
    let open = false;
    try {
      open = await check(url);
    } catch {
      open = false;
    }
    if (this.watches.get(consoleId) !== watch) return; // console closed meanwhile
    if (!open) {
      watch.origins.set(url.origin, { failedAt: this.now() });
      return;
    }
    watch.origins.set(url.origin, 'done');
    this.offerOrOpen(consoleId, url.url);
  }

  offerOrOpen(consoleId: string, url: string): void {
    const settings = this.options.settings();
    if (!settings.autoPreview) return;
    const info = this.options.manager.get(consoleId);
    if (!info) return;
    if (settings.previewMode === 'ask') {
      const origin = originOf(url);
      const dup = [...this.offers.values()].some((o) => o.consoleId === consoleId && originOf(o.url) === origin);
      if (dup) return;
      const offer: PreviewOffer = { id: crypto.randomUUID(), consoleId, consoleName: info.name, url, createdAt: this.now() };
      this.offers.set(offer.id, offer);
      this.options.broadcast({ type: 'preview-offer', offer });
      return;
    }
    void this.open(consoleId, url);
  }

  async open(consoleId: string, url: string): Promise<OpenResult> {
    if (!isLocalUrl(url)) return 'not-local';
    if (!this.options.manager.get(consoleId)) return 'gone';
    const { browsers } = this.options;
    const origin = originOf(url);
    const tile = browsers.tileForConsole(consoleId);
    if (!tile) {
      const created = browsers.createTile({ url, linkedConsoleId: consoleId });
      // Load the page right away so the preview is live (and titled) before the user looks at it
      browsers.session?.(created.id).catch(() => undefined);
      this.autoOpened.set(created.id, origin ?? '');
      this.options.onOpened?.(consoleId, url, 'created');
      return 'created';
    }
    const current = originOf(tile.url);
    if (current === origin) return 'already-there';
    const activity = browsers.userActivity(tile.id);
    const recent = activity && this.now() - activity.at < USER_NAV_GRACE_MS;
    // Clicking around in a preview we opened is fine; navigating elsewhere (or browsing a page we
    // did not open) means the user is using the tile for something else right now
    if (recent && (activity.nav || this.autoOpened.get(tile.id) !== current)) return 'user-busy';
    await browsers.updateTile(tile.id, { url });
    this.autoOpened.set(tile.id, origin ?? '');
    this.options.onOpened?.(consoleId, url, 'navigated');
    return 'navigated';
  }

  async accept(offerId: string): Promise<OpenResult | null> {
    const offer = this.offers.get(offerId);
    if (!offer) return null;
    this.removeOffer(offerId);
    return this.open(offer.consoleId, offer.url);
  }

  dismiss(offerId: string): boolean {
    if (!this.offers.has(offerId)) return false;
    this.removeOffer(offerId);
    return true;
  }

  private removeOffer(id: string): void {
    this.offers.delete(id);
    this.options.broadcast({ type: 'preview-offer-removed', id });
  }

  private forget(consoleId: string): void {
    const watch = this.watches.get(consoleId);
    if (watch?.timer) clearTimeout(watch.timer);
    this.watches.delete(consoleId);
    for (const offer of [...this.offers.values()]) if (offer.consoleId === consoleId) this.removeOffer(offer.id);
  }

  shutdown(): void {
    for (const watch of this.watches.values()) if (watch.timer) clearTimeout(watch.timer);
    this.watches.clear();
  }
}

export function registerPreviewRoutes(app: FastifyInstance, options: PreviewOptions): PreviewService {
  const service = new PreviewService(options);
  app.addHook('onClose', async () => service.shutdown());

  app.get('/api/previews/offers', async () => service.listOffers());

  app.post('/api/previews/offers/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await service.accept(id);
    if (!result) return reply.code(404).send({ error: 'This preview offer has expired' });
    return { ok: true, result };
  });

  app.delete('/api/previews/offers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.dismiss(id)) return reply.code(404).send({ error: 'Unknown preview offer' });
    return { ok: true };
  });

  return service;
}
