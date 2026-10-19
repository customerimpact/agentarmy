import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SHAPE_STYLE, MAX_IMAGE_BYTES, MAX_SHAPES, sniffImageType, validateShape, type Shape } from '../shared/drawings.js';
import { ConsoleManager } from './consoles.js';
import { applyDrawingOps, ImageStore } from './drawings.js';
import { buildServer } from './server.js';
import { StateStore } from './store.js';

const PORT = 4317; // never contacted: app.inject only
const TOKEN = 'test-token';
const HEADERS = { host: `127.0.0.1:${PORT}`, 'x-agentarmy-token': TOKEN };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function rect(id: string, extra: Partial<Shape> = {}): Shape {
  return { id, kind: 'rect', workspaceId: 'main', x: 0, y: 0, w: 100, h: 50, style: { ...DEFAULT_SHAPE_STYLE }, z: 1, createdAt: 1, updatedAt: 1, ...extra };
}

describe('validateShape', () => {
  it('accepts a well-formed shape and clamps style values', () => {
    const shape = validateShape({ ...rect('a'), w: -20, style: { ...DEFAULT_SHAPE_STYLE, opacity: 5 } });
    expect(shape).toMatchObject({ id: 'a', kind: 'rect', w: 20, style: { opacity: 1 } });
  });

  it('rejects bad ids, kinds, colours and coordinates', () => {
    expect(validateShape({ ...rect('a/../b') })).toBeNull();
    expect(validateShape({ ...rect('a'), kind: 'blob' })).toBeNull();
    expect(validateShape({ ...rect('a'), style: { ...DEFAULT_SHAPE_STYLE, color: 'red; x' } })).toBeNull();
    expect(validateShape({ ...rect('a'), x: Number.NaN })).toBeNull();
    expect(validateShape({ ...rect('a'), x: 1e12 })).toBeNull();
    expect(validateShape(null)).toBeNull();
  });

  it('needs points for pen / arrow and keeps clean anchors', () => {
    expect(validateShape({ ...rect('p'), kind: 'pen' })).toBeNull();
    expect(validateShape({ ...rect('l'), kind: 'arrow', points: [[0, 0]] })).toBeNull();
    const arrow = validateShape({
      ...rect('l'),
      kind: 'arrow',
      points: [[0, 0], [10, 10]],
      start: { nodeId: 'c1', fx: 2, fy: -1, evil: true },
      end: null,
    });
    expect(arrow?.start).toEqual({ nodeId: 'c1', fx: 1, fy: 0 });
    expect(arrow?.end).toBeNull();
    const tooLong = { ...rect('p'), kind: 'pen', points: Array.from({ length: 5000 }, () => [1, 1]) };
    expect(validateShape(tooLong)).toBeNull();
  });

  it('checks text and image ids', () => {
    expect(validateShape({ ...rect('t'), kind: 'text' })).toBeNull();
    expect(validateShape({ ...rect('t'), kind: 'text', text: 'hi' })?.text).toBe('hi');
    expect(validateShape({ ...rect('i'), kind: 'image', imageId: '../../secret.png' })).toBeNull();
    expect(validateShape({ ...rect('i'), kind: 'image', imageId: 'img_0123456789abcdef.png' })?.imageId).toBe('img_0123456789abcdef.png');
  });

  it('defaults a missing workspace', () => {
    const { workspaceId: _ws, ...rest } = rect('a');
    expect(validateShape(rest, 'ws2')?.workspaceId).toBe('ws2');
  });
});

describe('applyDrawingOps', () => {
  it('upserts, replaces and removes', () => {
    const list: Shape[] = [rect('a'), rect('b')];
    const res = applyDrawingOps(list, { upsert: [rect('a', { x: 5 }), rect('c')], remove: ['b', 'missing'] });
    expect(res.error).toBeUndefined();
    expect(res.removed).toEqual(['b']);
    expect(list.map((s) => [s.id, s.x])).toEqual([['a', 5], ['c', 0]]);
  });

  it('rejects the whole batch when one shape is invalid', () => {
    const list: Shape[] = [rect('a')];
    const res = applyDrawingOps(list, { upsert: [rect('b'), { id: 'x' }], remove: ['a'] });
    expect(res.error).toMatch(/invalid shape/);
    expect(list.map((s) => s.id)).toEqual(['a']);
  });

  it('caps the number of shapes on a board', () => {
    const list: Shape[] = Array.from({ length: MAX_SHAPES }, (_, i) => rect(`s${i}`));
    expect(applyDrawingOps(list, { upsert: [rect('one-more')] }).error).toMatch(/at most/);
    // replacing an existing one is fine
    expect(applyDrawingOps(list, { upsert: [rect('s1', { x: 9 })] }).error).toBeUndefined();
  });
});

describe('images', () => {
  it('sniffs real image types', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });

  it('enforces the size limit and type in the store', () => {
    const store = new ImageStore(null);
    expect(store.save(Buffer.alloc(0))).toMatchObject({ status: 400 });
    expect(store.save(Buffer.from('hello'))).toMatchObject({ status: 415 });
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(store.save(big)).toMatchObject({ status: 413 });
    const ok = store.save(PNG);
    expect('id' in ok && store.read(ok.id)?.type).toBe('image/png');
    expect(store.read('../state.json')).toBeNull();
  });
});

describe('routes', () => {
  let app: FastifyInstance;
  let manager: ConsoleManager;
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-drawings-'));
    manager = new ConsoleManager({ port: PORT, token: TOKEN, onChange: () => {} });
    app = await buildServer({ port: PORT, token: TOKEN, dev: false, manager });
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores shapes, lists them, and includes them in the board state', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/drawings/ops', headers: HEADERS, payload: { upsert: [rect('r1')], origin: 'tab1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, upserted: 1 });
    const list = await app.inject({ url: '/api/drawings', headers: HEADERS });
    expect(list.json().shapes.map((s: Shape) => s.id)).toEqual(['r1']);
    const state = await app.inject({ url: '/api/state', headers: HEADERS });
    expect(state.json().drawings.map((s: Shape) => s.id)).toEqual(['r1']);
    const bad = await app.inject({ method: 'POST', url: '/api/drawings/ops', headers: HEADERS, payload: { upsert: [{ id: 'x' }] } });
    expect(bad.statusCode).toBe(400);
  });

  it('needs the token', async () => {
    const res = await app.inject({ url: '/api/drawings', headers: { host: HEADERS.host } });
    expect(res.statusCode).toBe(401);
    const img = await app.inject({ url: '/api/images/img_0123456789abcdef.png', headers: { host: HEADERS.host } });
    expect(img.statusCode).toBe(401);
  });

  it('uploads and serves images with limits', async () => {
    const up = await app.inject({ method: 'POST', url: '/api/images', headers: { ...HEADERS, 'content-type': 'image/png' }, payload: PNG });
    expect(up.statusCode).toBe(200);
    const { id, url } = up.json() as { id: string; url: string };
    const get = await app.inject({ url, headers: HEADERS });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.rawPayload.equals(PNG)).toBe(true);
    expect(id).toMatch(/^img_[a-f0-9]+\.png$/);

    const svg = await app.inject({ method: 'POST', url: '/api/images', headers: { ...HEADERS, 'content-type': 'image/png' }, payload: Buffer.from('<svg/>') });
    expect(svg.statusCode).toBe(415);
    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/images',
      headers: { ...HEADERS, 'content-type': 'image/png' },
      payload: Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]),
    });
    expect(tooBig.statusCode).toBe(413);
    const missing = await app.inject({ url: '/api/images/img_ffffffffffffffff.png', headers: HEADERS });
    expect(missing.statusCode).toBe(404);
  });

  it('persists drawings through the state file', () => {
    const file = path.join(tmp, 'state.json');
    const store = new StateStore(file);
    store.saveSync(manager.getState());
    const loaded = store.load();
    expect(loaded.drawings?.map((s) => s.id)).toEqual(['r1']);
    const restored = new ConsoleManager({ port: PORT, token: TOKEN, onChange: () => {} });
    restored.restore(loaded, { resumeAll: false });
    expect(restored.drawings.map((s) => s.id)).toEqual(['r1']);
  });
});
