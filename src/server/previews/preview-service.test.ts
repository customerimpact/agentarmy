import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserTile, PreviewMode, ServerMessage } from '../../shared/protocol';
import type { ConsoleManager } from '../consoles';
import { PreviewService, USER_NAV_GRACE_MS, type PreviewBrowsers } from './preview-service';

function setup(options: { mode?: PreviewMode; open?: boolean } = {}) {
  const manager = Object.assign(new EventEmitter(), {
    get: (id: string) => (id === 'c1' ? { id: 'c1', name: 'Ada' } : undefined),
  }) as unknown as ConsoleManager;
  const tiles: BrowserTile[] = [];
  const activity = new Map<string, { at: number; nav: boolean }>();
  const browsers: PreviewBrowsers = {
    tileForConsole: (id) => tiles.find((t) => t.linkedConsoleId === id),
    createTile: vi.fn((req) => {
      const tile: BrowserTile = { id: `b${tiles.length}`, url: req.url ?? 'about:blank', title: '', layout: { x: 0, y: 0, width: 1, height: 1 }, linkedConsoleId: req.linkedConsoleId };
      tiles.push(tile);
      return tile;
    }),
    updateTile: vi.fn(async (id, req) => {
      const tile = tiles.find((t) => t.id === id)!;
      if (req.url) tile.url = req.url;
      return tile;
    }),
    userActivity: (id) => activity.get(id),
  };
  const messages: ServerMessage[] = [];
  const settings = { autoPreview: true, previewMode: options.mode ?? ('open' as PreviewMode) };
  let now = 1_000_000;
  const checks: string[] = [];
  const opened: string[] = [];
  const service = new PreviewService({
    manager,
    browsers,
    settings: () => settings,
    broadcast: (m) => messages.push(m),
    ignorePorts: [4317],
    portCheck: async (u) => {
      checks.push(u.origin);
      return options.open ?? true;
    },
    onOpened: (_c, url) => opened.push(url),
    now: () => now,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { manager, service, browsers, tiles, activity, messages, settings, checks, opened, flush, tick: (ms: number) => (now += ms) };
}

describe('PreviewService', () => {
  it('opens a tile linked to the console once the port is open, once per origin', async () => {
    const t = setup();
    t.service.onOutput('c1', '  ➜  Local:   http://localhost:5173/\r\n');
    t.service.scan('c1');
    await t.flush();
    expect(t.browsers.createTile).toHaveBeenCalledWith({ url: 'http://localhost:5173/', linkedConsoleId: 'c1' });
    expect(t.opened).toEqual(['http://localhost:5173/']);
    // The TUI redraws the same line many times
    t.service.onOutput('c1', 'Local: http://localhost:5173/\r\n');
    t.service.scan('c1');
    await t.flush();
    expect(t.checks).toEqual(['http://localhost:5173']);
    expect(t.browsers.createTile).toHaveBeenCalledTimes(1);
  });

  it('ignores URLs whose port is closed (plain prose), and our own port', async () => {
    const t = setup({ open: false });
    t.service.onOutput('c1', 'You could run it at http://localhost:3000 and POST http://127.0.0.1:4317/hook/x\n');
    t.service.scan('c1');
    await t.flush();
    expect(t.checks).toEqual(['http://localhost:3000']);
    expect(t.browsers.createTile).not.toHaveBeenCalled();
  });

  it('navigates an existing linked tile instead of opening another', async () => {
    const t = setup();
    t.tiles.push({ id: 'b9', url: 'https://docs.example.com/', title: '', layout: { x: 0, y: 0, width: 1, height: 1 }, linkedConsoleId: 'c1' });
    expect(await t.service.open('c1', 'http://localhost:3000/')).toBe('navigated');
    expect(t.tiles[0].url).toBe('http://localhost:3000/');
    expect(await t.service.open('c1', 'http://localhost:3000/other')).toBe('already-there');
    expect(t.browsers.createTile).not.toHaveBeenCalled();
  });

  it('leaves a tile alone that the user navigated in the last 2 minutes', async () => {
    const t = setup();
    t.tiles.push({ id: 'b9', url: 'https://github.com/', title: '', layout: { x: 0, y: 0, width: 1, height: 1 }, linkedConsoleId: 'c1' });
    t.activity.set('b9', { at: 1_000_000 - 1000, nav: true });
    expect(await t.service.open('c1', 'http://localhost:3000/')).toBe('user-busy');
    t.tick(USER_NAV_GRACE_MS);
    expect(await t.service.open('c1', 'http://localhost:3000/')).toBe('navigated');
  });

  it('clicking inside a preview we opened does not block the next one', async () => {
    const t = setup();
    expect(await t.service.open('c1', 'http://localhost:3000/')).toBe('created');
    t.activity.set('b0', { at: 1_000_000, nav: false });
    expect(await t.service.open('c1', 'http://localhost:5173/')).toBe('navigated');
  });

  it('never opens non-local hosts', async () => {
    const t = setup();
    expect(await t.service.open('c1', 'https://example.com/')).toBe('not-local');
  });

  it('asks first in ask mode, then opens on accept', async () => {
    const t = setup({ mode: 'ask' });
    t.service.onOutput('c1', 'ready on http://localhost:3000\n');
    t.service.scan('c1');
    await t.flush();
    expect(t.browsers.createTile).not.toHaveBeenCalled();
    const offer = t.messages.find((m) => m.type === 'preview-offer');
    expect(offer).toMatchObject({ offer: { consoleId: 'c1', consoleName: 'Ada', url: 'http://localhost:3000/' } });
    const id = (offer as Extract<ServerMessage, { type: 'preview-offer' }>).offer.id;
    expect(await t.service.accept(id)).toBe('created');
    expect(t.messages.at(-1)).toEqual({ type: 'preview-offer-removed', id });
    expect(await t.service.accept(id)).toBeNull();
  });

  it('does nothing when auto previews are off', async () => {
    const t = setup();
    t.settings.autoPreview = false;
    t.service.onOutput('c1', 'Local: http://localhost:5173/\n');
    t.service.scan('c1');
    await t.flush();
    expect(t.checks).toEqual([]);
  });

  it('debounces output and scans on its own', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const scan = vi.spyOn(t.service, 'scan');
      t.service.onOutput('c1', 'Local: http://local');
      t.service.onOutput('c1', 'host:5173/\r\n');
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(t.checks).toEqual(['http://localhost:5173']);
    } finally {
      vi.useRealTimers();
    }
  });
});
