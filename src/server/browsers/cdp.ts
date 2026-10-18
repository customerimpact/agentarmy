import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// Minimal Chrome DevTools Protocol client over one browser-level WebSocket.
// Page commands go to a flat session (Target.attachToTarget { flatten: true }).

export interface CdpEvent {
  method: string;
  params: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  sessionId?: string;
}

interface Pending {
  resolve: (value: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  reject: (err: Error) => void;
  method: string;
}

export class CdpConnection extends EventEmitter<{ event: [CdpEvent]; close: [] }> {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    super();
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', () => this.onClose());
    ws.on('error', () => this.onClose());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out connecting to the browser'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private onMessage(text: string): void {
    let msg: { id?: number; method?: string; params?: any; sessionId?: string; result?: any; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) this.emit('event', { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('Browser connection closed'));
    this.pending.clear();
    this.emit('close');
  }
}

export interface LaunchedBrowser {
  process: ChildProcess;
  wsUrl: string;
}

export function chromeArgs(userDataDir: string, width: number, height: number): string[] {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    '--hide-crash-restore-bubble',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
}

// Starts a headless Chromium and resolves with its DevTools WebSocket URL (printed on stderr)
export function launchChrome(executable: string, args: string[], timeoutMs = 20_000): Promise<LaunchedBrowser> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, wsUrl?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else resolve({ process: child, wsUrl: wsUrl! });
    };
    const timer = setTimeout(
      () => finish(new Error(`The browser did not start in time. ${stderr.slice(-300)}`)),
      timeoutMs,
    );
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      if (settled) return; // keep draining so the pipe never blocks Chrome
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) finish(null, match[1]);
    });
    child.once('error', (err) => finish(err));
    child.once('exit', (code) => finish(new Error(`The browser exited (code ${code}). ${stderr.slice(-300)}`)));
  });
}
