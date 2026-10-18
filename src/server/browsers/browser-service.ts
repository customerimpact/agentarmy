import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  BrowserInputEvent,
  BrowserTile,
  ConsoleLayout,
  ServerMessage,
} from '../../shared/protocol.js';
import type { ConsoleManager } from '../consoles.js';
import { agentArmyHome } from '../store.js';
import { activeSettings } from '../settings.js';
import { CdpConnection, chromeArgs, launchChrome, type CdpEvent } from './cdp.js';
import { findBrowser } from './chrome-finder.js';
import { READ_SCRIPT, SAME_TAB_SCRIPT, locateScript } from './page-scripts.js';
import {
  TILE_SIZE,
  cursorPath,
  keyInfo,
  normalizeUrl,
  placeTile,
  viewportForLayout,
  type Point,
} from './util.js';

type Send = (msg: ServerMessage) => void;
type Frame = Extract<ServerMessage, { type: 'browser-frame' }>;

export interface TileRequest {
  url?: string;
  layout?: Partial<ConsoleLayout>;
  linkedConsoleId?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CURSOR_EMIT_MS = 33; // ~30 cursor updates per second
const NAV_TIMEOUT_MS = 15_000;

// Every Chrome we started, so a hard exit still takes them down
const liveProcesses = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackProcess(proc: ChildProcess): void {
  liveProcesses.add(proc);
  proc.once('exit', () => liveProcesses.delete(proc));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const p of liveProcesses) p.kill();
    });
  }
}

const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

class Session {
  conn!: CdpConnection;
  proc!: ChildProcess;
  sessionId = '';
  targetId = '';
  mainFrameId = '';
  viewport = { width: TILE_SIZE.width, height: TILE_SIZE.height };
  screencasting = false;
  lastFrame: Frame | null = null;
  cursor: Point | null = null;
  buttons = 0;
  loading = false;
  dead = false;
  private loadWaiters = new Set<() => void>();
  private popups = new Set<string>();

  constructor(
    readonly tile: BrowserTile,
    private readonly service: BrowserServiceImpl,
  ) {}

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.conn.send<T>(method, params, this.sessionId);
  }

  async start(executable: string, userDataDir: string): Promise<void> {
    this.viewport = viewportForLayout(this.tile.layout);
    // The blank start page reports itself as the url while starting; remember what to load
    const initialUrl = this.tile.url;
    fs.mkdirSync(userDataDir, { recursive: true });
    const launched = await launchChrome(
      executable,
      chromeArgs(userDataDir, this.viewport.width, this.viewport.height),
    );
    this.proc = launched.process;
    trackProcess(this.proc);
    this.proc.once('exit', () => this.onDead());
    try {
      this.conn = await CdpConnection.connect(launched.wsUrl);
    } catch (err) {
      this.proc.kill();
      throw err;
    }
    this.conn.on('event', (e) => this.onEvent(e));
    this.conn.on('close', () => this.onDead());

    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.conn.send<{ targetInfos: { targetId: string; type: string }[] }>(
      'Target.getTargets',
    );
    let page = targetInfos.find((t) => t.type === 'page');
    if (!page) {
      const created = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      page = { targetId: created.targetId, type: 'page' };
    }
    this.targetId = page.targetId;
    const attached = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: SAME_TAB_SCRIPT });
    const tree = await this.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    this.mainFrameId = tree.frameTree.frame.id;
    await this.applyViewport();
    if (initialUrl && initialUrl !== 'about:blank') {
      void this.navigate(initialUrl).catch(() => undefined);
    }
  }

  private onDead(): void {
    if (this.dead) return;
    this.dead = true;
    this.screencasting = false;
    for (const w of this.loadWaiters) w();
    this.loadWaiters.clear();
    try {
      this.conn?.close();
    } catch {
      // ignore
    }
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    this.service.onSessionDead(this);
  }

  private onEvent(e: CdpEvent): void {
    const p = e.params;
    if (!e.sessionId) {
      if (e.method === 'Target.targetCreated' && p.targetInfo?.openerId === this.targetId) {
        this.popups.add(p.targetInfo.targetId);
      } else if (e.method === 'Target.targetInfoChanged') {
        const info = p.targetInfo;
        if (info.targetId === this.targetId) this.service.updateMeta(this.tile, info.url, info.title);
        else if (this.popups.has(info.targetId) && info.url && info.url !== 'about:blank') {
          // A popup the page opened anyway: show it in this tile instead
          this.popups.delete(info.targetId);
          void this.conn.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
          void this.navigate(info.url).catch(() => undefined);
        }
      }
      return;
    }
    if (e.sessionId !== this.sessionId) return;
    switch (e.method) {
      case 'Page.screencastFrame': {
        void this.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
        const frame: Frame = {
          type: 'browser-frame',
          id: this.tile.id,
          data: p.data,
          width: Math.round(p.metadata?.deviceWidth ?? this.viewport.width),
          height: Math.round(p.metadata?.deviceHeight ?? this.viewport.height),
        };
        this.lastFrame = frame;
        this.service.broadcastFrame(this.tile.id, frame);
        break;
      }
      case 'Page.frameStartedLoading':
        if (p.frameId === this.mainFrameId) this.loading = true;
        break;
      case 'Page.frameStoppedLoading':
        if (p.frameId === this.mainFrameId) {
          this.loading = false;
          for (const w of this.loadWaiters) w();
          this.loadWaiters.clear();
        }
        break;
      case 'Page.loadEventFired':
        for (const w of this.loadWaiters) w();
        this.loadWaiters.clear();
        void this.refreshMeta();
        break;
      case 'Page.frameNavigated':
        if (!p.frame?.parentId) {
          this.mainFrameId = p.frame.id;
          this.service.updateMeta(this.tile, p.frame.url, undefined);
        }
        break;
      case 'Page.navigatedWithinDocument':
        if (p.frameId === this.mainFrameId) this.service.updateMeta(this.tile, p.url, undefined);
        break;
      case 'Page.javascriptDialogOpening':
        // Nobody can answer a dialog in a headless tab; accept so the page does not hang
        void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
        break;
    }
  }

  private waitForLoad(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.loadWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.loadWaiters.add(done);
    });
  }

  async navigate(url: string): Promise<string | null> {
    const target = normalizeUrl(url);
    const loaded = this.waitForLoad(NAV_TIMEOUT_MS);
    const res = await this.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url: target });
    if (res.errorText) return `${res.errorText} (${target})`;
    if (res.loaderId) await loaded;
    return null;
  }

  // Let clicks or key presses that start a navigation finish loading
  async settle(): Promise<void> {
    await sleep(250);
    if (this.loading) await this.waitForLoad(NAV_TIMEOUT_MS);
  }

  async history(action: 'back' | 'forward' | 'reload'): Promise<void> {
    if (action === 'reload') {
      await this.send('Page.reload');
      return;
    }
    const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
    if (entry) await this.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  async setViewport(width: number, height: number): Promise<void> {
    const w = Math.max(200, Math.min(3840, Math.round(width)));
    const h = Math.max(150, Math.min(2160, Math.round(height)));
    if (w === this.viewport.width && h === this.viewport.height) return;
    this.viewport = { width: w, height: h };
    await this.applyViewport();
    if (this.screencasting) {
      await this.send('Page.stopScreencast').catch(() => undefined);
      this.screencasting = false;
      await this.startScreencast();
    }
  }

  private async applyViewport(): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async startScreencast(): Promise<void> {
    if (this.screencasting || this.dead) return;
    this.screencasting = true;
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencasting || this.dead) return;
    this.screencasting = false;
    await this.send('Page.stopScreencast');
  }

  async input(event: BrowserInputEvent): Promise<void> {
    switch (event.kind) {
      case 'mouse': {
        const x = Math.max(0, Math.min(this.viewport.width, event.x));
        const y = Math.max(0, Math.min(this.viewport.height, event.y));
        const button = event.button ?? 'left';
        const bit = button === 'left' ? 1 : button === 'right' ? 2 : 4;
        if (event.action === 'down') this.buttons |= bit;
        if (event.action === 'up') this.buttons &= ~bit;
        const type =
          event.action === 'move'
            ? 'mouseMoved'
            : event.action === 'down'
              ? 'mousePressed'
              : event.action === 'up'
                ? 'mouseReleased'
                : 'mouseWheel';
        await this.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: event.action === 'move' || event.action === 'wheel' ? (this.buttons & 1 ? 'left' : 'none') : button,
          buttons: this.buttons,
          clickCount: event.action === 'down' || event.action === 'up' ? (event.clickCount ?? 1) : 0,
          ...(event.action === 'wheel' ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 } : {}),
        });
        return;
      }
      case 'key': {
        const info = keyInfo(event.key, event.code);
        const commandKey = (event.modifiers & (2 | 4)) !== 0;
        const text = event.text ?? info.text;
        const withText = event.action === 'down' && text && !commandKey;
        await this.send('Input.dispatchKeyEvent', {
          type: event.action === 'up' ? 'keyUp' : withText ? 'keyDown' : 'rawKeyDown',
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.keyCode,
          nativeVirtualKeyCode: info.keyCode,
          modifiers: event.modifiers,
          ...(withText ? { text, unmodifiedText: text } : {}),
        });
        return;
      }
      case 'text':
        if (event.text) await this.send('Input.insertText', { text: event.text });
        return;
      case 'navigate':
        await this.navigate(event.url);
        return;
      case 'history':
        await this.history(event.action);
        return;
      case 'viewport':
        await this.setViewport(event.width, event.height);
        return;
    }
  }

  // ---------- agent actions (with a visible pointer) ----------

  async moveTo(to: Point): Promise<void> {
    const from = this.cursor ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(6, Math.min(22, Math.round(dist / 30)));
    let lastEmit = 0;
    const path = cursorPath(from, to, steps);
    for (let i = 0; i < path.length; i++) {
      const pt = path[i];
      this.cursor = pt;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
      const now = Date.now();
      if (now - lastEmit >= CURSOR_EMIT_MS || i === path.length - 1) {
        lastEmit = now;
        this.service.setCursor(this.tile, { x: pt.x, y: pt.y, t: now });
      }
      await sleep(18);
    }
  }

  async click(to: Point, clickCount = 1): Promise<void> {
    await this.moveTo(to);
    await sleep(60);
    this.service.setCursor(this.tile, { x: to.x, y: to.y, t: Date.now(), click: true });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: to.x, y: to.y, button: 'left', buttons: 1, clickCount });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value as T;
  }

  async locate(selector: string | null, text: string | null): Promise<{ x: number; y: number; label: string }> {
    const found = await this.evaluate<{ x: number; y: number; label: string; error?: string }>(
      locateScript(selector, text),
    );
    if (!found || found.error) throw new Error(found?.error ?? 'Element not found');
    await sleep(80); // let scrollIntoView paint
    return found;
  }

  async pressKey(combo: string): Promise<void> {
    const parts = combo.length > 1 ? combo.split('+').filter(Boolean) : [combo];
    const keyName = parts.pop() ?? combo;
    let modifiers = 0;
    for (const m of parts) modifiers |= MODIFIERS[m.toLowerCase()] ?? 0;
    const info = keyInfo(keyName);
    const withText = info.text && !(modifiers & (2 | 4));
    const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', {
      ...base,
      type: withText ? 'keyDown' : 'rawKeyDown',
      ...(withText ? { text: info.text, unmodifiedText: info.text } : {}),
    });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  // Title events can lag behind the load; read url/title straight from the page
  async refreshMeta(): Promise<void> {
    try {
      const meta = await this.evaluate<{ url: string; title: string }>('({ url: location.href, title: document.title })');
      if (meta) this.service.updateMeta(this.tile, meta.url, meta.title);
    } catch {
      // page is mid-navigation; events will catch up
    }
  }

  async screenshot(): Promise<string> {
    const res = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return res.data;
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try {
      await Promise.race([this.conn.send('Browser.close'), sleep(1500)]);
    } catch {
      // fall through to kill
    }
    if (this.proc.exitCode === null) this.proc.kill();
    this.onDead();
  }
}

export class BrowserServiceImpl {
  private sessions = new Map<string, Session>();
  private starting = new Map<string, Promise<Session>>();
  private attached = new Map<string, Set<Send>>();
  private lastUserInput = new Map<string, { at: number; nav: boolean }>();

  // Last time the user typed/clicked in a tile (nav: they navigated it themselves)
  userActivity(id: string): { at: number; nav: boolean } | undefined {
    return this.lastUserInput.get(id);
  }
  private executable: string | null | undefined;

  constructor(
    private readonly manager: ConsoleManager,
    private readonly home: string = agentArmyHome(),
  ) {
    // Unlink tiles from consoles that are gone
    manager.on('removed', (consoleId) => {
      for (const tile of manager.browsers) {
        if (tile.linkedConsoleId === consoleId) {
          tile.linkedConsoleId = null;
          this.changed(tile);
        }
      }
    });
  }

  get tiles(): BrowserTile[] {
    return this.manager.browsers;
  }

  get(id: string): BrowserTile | undefined {
    return this.tiles.find((t) => t.id === id);
  }

  tileForConsole(consoleId: string): BrowserTile | undefined {
    return this.tiles.find((t) => t.linkedConsoleId === consoleId);
  }

  private changed(tile: BrowserTile, persist = true): void {
    this.manager.emit('browser', tile);
    if (persist) this.manager.persist();
  }

  updateMeta(tile: BrowserTile, url: string | undefined, title: string | undefined): void {
    let dirty = false;
    if (url !== undefined && url !== tile.url) {
      tile.url = url;
      dirty = true;
    }
    if (title !== undefined && title !== tile.title) {
      tile.title = title;
      dirty = true;
    }
    if (dirty) this.changed(tile);
  }

  setCursor(tile: BrowserTile, cursor: NonNullable<BrowserTile['cursor']>): void {
    tile.cursor = cursor;
    this.changed(tile, false);
  }

  createTile(req: TileRequest): BrowserTile {
    const linked = req.linkedConsoleId ? this.manager.get(req.linkedConsoleId) : undefined;
    const existing = [...this.manager.list().map((c) => c.layout), ...this.tiles.map((t) => t.layout)];
    const placed = placeTile(linked?.layout, existing, {
      width: req.layout?.width ?? TILE_SIZE.width,
      height: req.layout?.height ?? TILE_SIZE.height,
    });
    const tile: BrowserTile = {
      id: `b-${crypto.randomUUID().slice(0, 8)}`,
      url: req.url ? normalizeUrl(req.url) : 'about:blank',
      title: '',
      layout: { ...placed, ...req.layout },
      linkedConsoleId: linked ? linked.id : null,
      cursor: null,
    };
    this.tiles.push(tile);
    this.changed(tile);
    return tile;
  }

  async updateTile(id: string, req: TileRequest): Promise<BrowserTile | undefined> {
    const tile = this.get(id);
    if (!tile) return undefined;
    if (req.layout) tile.layout = { ...tile.layout, ...req.layout };
    if (req.linkedConsoleId !== undefined) tile.linkedConsoleId = req.linkedConsoleId;
    if (req.url !== undefined) {
      const session = this.sessions.get(id);
      if (session) void session.navigate(req.url).catch(() => undefined);
      else tile.url = normalizeUrl(req.url);
    }
    this.changed(tile);
    return tile;
  }

  async deleteTile(id: string): Promise<boolean> {
    const index = this.tiles.findIndex((t) => t.id === id);
    if (index === -1) return false;
    this.tiles.splice(index, 1);
    this.attached.delete(id);
    this.manager.emit('browser-removed', id);
    this.manager.persist();
    const session = this.sessions.get(id) ?? (await this.starting.get(id)?.catch(() => undefined));
    if (session) await session.close();
    // The profile (cookies, cache) belongs to the tile; Windows may hold files briefly after exit
    fs.rm(this.profileDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, () => undefined);
    return true;
  }

  private profileDir(id: string): string {
    return path.join(this.home, 'browsers', id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  // Launches the tile's browser on first use
  session(id: string): Promise<Session> {
    const live = this.sessions.get(id);
    if (live && !live.dead) return Promise.resolve(live);
    const pending = this.starting.get(id);
    if (pending) return pending;
    const tile = this.get(id);
    if (!tile) return Promise.reject(new Error('Unknown browser tile'));
    // Settings > Browser tiles > executable path wins over auto-detection
    const override = activeSettings().browserPath;
    if (!override && this.executable === undefined) this.executable = findBrowser();
    const executable = override && fs.existsSync(override) ? override : override ? null : this.executable;
    if (!executable) {
      const message = override
        ? `Browser not found at ${override} (Settings > Browser tiles).`
        : 'No Chrome, Edge or Chromium found. Install one or set its path in Settings > Browser tiles.';
      tile.error = message;
      this.changed(tile, false);
      return Promise.reject(new Error(message));
    }
    const session = new Session(tile, this);
    const promise = session
      .start(executable, this.profileDir(id))
      .then(async () => {
        this.sessions.set(id, session);
        if (tile.error) {
          tile.error = null;
          this.changed(tile, false);
        }
        if (!this.get(id)) {
          await session.close(); // deleted while starting
          throw new Error('Browser tile was closed');
        }
        if (this.attached.get(id)?.size) await session.startScreencast();
        return session;
      })
      .catch((err: unknown) => {
        tile.error = `Could not start the browser: ${err instanceof Error ? err.message : String(err)}`;
        this.changed(tile, false);
        throw err;
      })
      .finally(() => this.starting.delete(id));
    this.starting.set(id, promise);
    return promise;
  }

  onSessionDead(session: Session): void {
    if (this.sessions.get(session.tile.id) === session) this.sessions.delete(session.tile.id);
  }

  broadcastFrame(id: string, frame: Frame): void {
    for (const send of this.attached.get(id) ?? []) send(frame);
  }

  attach(id: string, send: Send): void {
    if (!this.get(id)) return;
    let set = this.attached.get(id);
    if (!set) {
      set = new Set();
      this.attached.set(id, set);
    }
    set.add(send);
    const live = this.sessions.get(id);
    if (live?.lastFrame) send(live.lastFrame);
    this.session(id)
      .then((s) => s.startScreencast())
      .catch(() => undefined);
  }

  detach(id: string, send: Send): void {
    const set = this.attached.get(id);
    if (!set) return;
    set.delete(send);
    if (set.size) return;
    this.attached.delete(id);
    void this.sessions.get(id)?.stopScreencast().catch(() => undefined);
  }

  async input(id: string, event: BrowserInputEvent): Promise<void> {
    // Auto previews must not yank a tile away from a page the user is looking at
    if (event.kind !== 'viewport') this.lastUserInput.set(id, { at: Date.now(), nav: event.kind === 'navigate' || event.kind === 'history' });
    const session = await this.session(id);
    await session.input(event);
  }

  forSocket(send: (msg: unknown) => void) {
    const mine = new Set<string>();
    return {
      onMessage: (raw: unknown): boolean => {
        if (!raw || typeof raw !== 'object') return false;
        const msg = raw as { type?: unknown; id?: unknown; event?: unknown };
        if (typeof msg.type !== 'string' || !msg.type.startsWith('browser-')) return false;
        if (typeof msg.id !== 'string') return true;
        if (msg.type === 'browser-attach') {
          if (!mine.has(msg.id)) {
            mine.add(msg.id);
            this.attach(msg.id, send);
          }
        } else if (msg.type === 'browser-detach') {
          mine.delete(msg.id);
          this.detach(msg.id, send);
        } else if (msg.type === 'browser-input' && msg.event && typeof msg.event === 'object') {
          void this.input(msg.id, msg.event as BrowserInputEvent).catch(() => undefined);
        }
        return true;
      },
      onClose: (): void => {
        for (const id of mine) this.detach(id, send);
        mine.clear();
      },
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close().catch(() => undefined)));
    this.sessions.clear();
  }
}
