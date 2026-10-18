import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPortOpen, waitForPort } from './port-check';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(server: net.Server, host: string, port = 0): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r((probe.address() as net.AddressInfo).port)));
  await new Promise((r) => probe.close(r));
  return port;
}

describe('port check', () => {
  it('sees a listening HTTP server', async () => {
    const port = await listen(http.createServer((_q, s) => s.end('ok')), '127.0.0.1');
    expect(await isPortOpen('127.0.0.1', port)).toBe(true);
    expect(await isPortOpen('localhost', port)).toBe(true);
  });

  it('reports a closed port', async () => {
    expect(await isPortOpen('localhost', await closedPort(), 500)).toBe(false);
  });

  it('tries IPv6 for localhost (servers that bind ::1 only)', async (ctx) => {
    let port: number;
    try {
      port = await listen(net.createServer(), '::1');
    } catch {
      ctx.skip(); // no IPv6 loopback on this machine
      return;
    }
    expect(await isPortOpen('localhost', port)).toBe(true);
  });

  it('waits until a server starts listening', async () => {
    const port = await closedPort();
    setTimeout(() => void listen(net.createServer(), '127.0.0.1', port), 600);
    const started = Date.now();
    expect(await waitForPort('localhost', port, { timeoutMs: 5000, intervalMs: 100 })).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it('gives up after the timeout', async () => {
    const port = await closedPort();
    expect(await waitForPort('127.0.0.1', port, { timeoutMs: 400, intervalMs: 100 })).toBe(false);
  });
});
