import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConsoleManager } from './consoles.js';
import { buildServer } from './server.js';
import { TOKEN_COOKIE } from './security.js';
import { loadOrCreateToken } from './token-file.js';

const PORT = 4317;
const TOKEN = 'test-token';
const HOST = { host: `127.0.0.1:${PORT}` };
let app: FastifyInstance;

beforeAll(async () => {
  const manager = new ConsoleManager({ port: PORT, token: TOKEN, onChange: () => {} });
  app = await buildServer({ port: PORT, token: TOKEN, dev: false, manager });
});

afterAll(async () => {
  await app.close();
});

describe('auth', () => {
  it('sets the auth cookie when a page is opened with a valid ?token', async () => {
    const res = await app.inject({ url: `/?token=${TOKEN}`, headers: HOST });
    expect(res.headers['set-cookie']).toBe(
      `${TOKEN_COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`,
    );
  });

  it('does not set a cookie for a wrong token or when it is already present', async () => {
    const wrong = await app.inject({ url: '/?token=nope', headers: HOST });
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const again = await app.inject({
      url: `/?token=${TOKEN}`,
      headers: { ...HOST, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
    });
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the cookie, query or header token on /api', async () => {
    const cookie = await app.inject({
      url: '/api/state',
      headers: { ...HOST, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
    });
    expect(cookie.statusCode).toBe(200);
    const query = await app.inject({ url: `/api/state?token=${TOKEN}`, headers: HOST });
    expect(query.statusCode).toBe(200);
    const header = await app.inject({
      url: '/api/state',
      headers: { ...HOST, 'x-agentarmy-token': TOKEN },
    });
    expect(header.statusCode).toBe(200);
    const none = await app.inject({ url: '/api/state', headers: HOST });
    expect(none.statusCode).toBe(401);
    const bad = await app.inject({
      url: '/api/state',
      headers: { ...HOST, cookie: `${TOKEN_COOKIE}=nope` },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('accepts only the query token on /hook', async () => {
    const viaCookie = await app.inject({
      method: 'POST',
      url: '/hook/x',
      headers: { ...HOST, cookie: `${TOKEN_COOKIE}=${TOKEN}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(viaCookie.statusCode).toBe(401);
    const viaQuery = await app.inject({
      method: 'POST',
      url: `/hook/x?token=${TOKEN}`,
      headers: { ...HOST, 'content-type': 'application/json' },
      payload: '{"hook_event_name":"Stop"}',
    });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.body).toBe('');
    expect(viaQuery.headers['set-cookie']).toBeUndefined();
  });

  it('still rejects foreign origins and hosts even with a valid cookie', async () => {
    const cookie = `${TOKEN_COOKIE}=${TOKEN}`;
    const origin = await app.inject({
      url: '/api/state',
      headers: { ...HOST, cookie, origin: 'https://evil.example' },
    });
    expect(origin.statusCode).toBe(403);
    const host = await app.inject({
      url: '/api/state',
      headers: { host: `evil.example:${PORT}`, cookie },
    });
    expect(host.statusCode).toBe(403);
  });
});

describe('loadOrCreateToken', () => {
  let dir: string;
  const previous = process.env.AGENTARMY_HOME;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-token-'));
    process.env.AGENTARMY_HOME = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.AGENTARMY_HOME;
    else process.env.AGENTARMY_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists the token and reuses it, rotating only on request', () => {
    const first = loadOrCreateToken();
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(fs.readFileSync(path.join(dir, 'token'), 'utf8')).toBe(first);
    expect(loadOrCreateToken()).toBe(first);
    const rotated = loadOrCreateToken({ rotate: true });
    expect(rotated).not.toBe(first);
    expect(loadOrCreateToken()).toBe(rotated);
  });
});
