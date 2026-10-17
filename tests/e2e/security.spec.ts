import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { AgentArmyServer, REPO_ROOT, makeTempHome } from './helpers/server';

// ws ships with @fastify/websocket; resolve it from the repo so we don't add a dependency
const WebSocket = createRequire(`${REPO_ROOT}/package.json`)('ws') as typeof import('ws').default;

let home: string;
let server: AgentArmyServer;

test.beforeAll(async () => {
  home = makeTempHome('security');
  server = await AgentArmyServer.start({ home });
});

test.afterAll(async () => {
  await server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path, method: 'GET', headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function wsStatus(path: string, headers: Record<string, string> = {}): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

test('f1. /api/state requires the token', async () => {
  expect((await fetch(`${server.origin}/api/state`)).status).toBe(401);
  expect((await fetch(`${server.origin}/api/state?token=wrong`)).status).toBe(401);
  expect(
    (await fetch(`${server.origin}/api/state`, { headers: { 'x-agentarmy-token': 'wrong' } })).status,
  ).toBe(401);
  expect((await fetch(`${server.origin}/api/state?token=${server.token}`)).status).toBe(200);
  expect(
    (await fetch(`${server.origin}/api/state`, { headers: { 'x-agentarmy-token': server.token } })).status,
  ).toBe(200);
});

test('f2. a foreign Origin is rejected even with the token', async () => {
  const res = await fetch(`${server.origin}/api/state`, {
    headers: { 'x-agentarmy-token': server.token, origin: 'http://evil.example' },
  });
  expect(res.status).toBe(403);
  const sameOrigin = await fetch(`${server.origin}/api/state`, {
    headers: { 'x-agentarmy-token': server.token, origin: server.origin },
  });
  expect(sameOrigin.status).toBe(200);
});

test('f3. a foreign Host (DNS rebinding) is rejected', async () => {
  expect(await rawGet(`/api/state?token=${server.token}`, { host: `evil.example:${server.port}` })).toBe(403);
  expect(await rawGet(`/api/state?token=${server.token}`, { host: `127.0.0.1:${server.port}` })).toBe(200);
});

test('f4. mutating endpoints and hooks require the token', async () => {
  const create = await fetch(`${server.origin}/api/consoles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: home }),
  });
  expect(create.status).toBe(401);
  const hook = await fetch(`${server.origin}/hook/whatever`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Stop' }),
  });
  expect(hook.status).toBe(401);
  expect((await fetch(`${server.origin}/api/fs/list`)).status).toBe(401);
});

test('f5. the WebSocket requires the token and a local Origin', async () => {
  expect(await wsStatus('/ws')).toBe(401);
  expect(await wsStatus('/ws?token=wrong')).toBe(401);
  expect(await wsStatus(`/ws?token=${server.token}`, { origin: 'http://evil.example' })).toBe(403);
  expect(await wsStatus(`/ws?token=${server.token}`, { origin: server.origin })).toBe('open');
});

test('f6. the UI explains a missing or invalid token', async ({ page }) => {
  await page.goto(`${server.origin}/`);
  await expect(page.getByRole('heading', { name: 'Open the link from your terminal' })).toBeVisible();
  await page.goto(`${server.origin}/?token=wrong`);
  await expect(page.getByRole('heading', { name: 'This link is no longer valid' })).toBeVisible();
});
