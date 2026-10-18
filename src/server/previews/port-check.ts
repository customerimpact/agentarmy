import net from 'node:net';

// Is something accepting TCP connections on host:port? "localhost" is tried on both IPv4 and
// IPv6 because Node 17+ dev servers (Vite) often bind ::1 only.

export function canConnect(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function isPortOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const results = await Promise.all(hosts.map((h) => canConnect(h, port, timeoutMs)));
  return results.some(Boolean);
}

export interface WaitOptions {
  timeoutMs?: number; // give up after this long (dev servers can print the URL before listening)
  intervalMs?: number;
  signal?: { aborted: boolean };
}

export async function waitForPort(host: string, port: number, options: WaitOptions = {}): Promise<boolean> {
  const { timeoutMs = 20_000, intervalMs = 500, signal } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return false;
    if (await isPortOpen(host, port, Math.min(1000, intervalMs * 2))) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
