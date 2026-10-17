import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FAKE_CLAUDE_DIR = path.join(REPO_ROOT, 'tests', 'fake-claude');
export const FAKE_CLAUDE_SHIM = path.join(
  FAKE_CLAUDE_DIR,
  process.platform === 'win32' ? 'claude.cmd' : 'claude',
);

// Temp "home" so ~/.agentarmy/state.json and the folder picker's start dir are isolated
export function makeTempHome(label: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `agentarmy-e2e-${label}-`));
  return fs.realpathSync.native(home);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface StartOptions {
  home: string;
  port?: number;
  env?: Record<string, string>;
}

export class AgentArmyServer {
  port = 0;
  token = '';
  url = '';
  output = '';
  private proc: ChildProcess | null = null;

  constructor(readonly home: string) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get stateFile(): string {
    return path.join(this.home, '.agentarmy', 'state.json');
  }

  static async start(options: StartOptions): Promise<AgentArmyServer> {
    const server = new AgentArmyServer(options.home);
    await server.launch(options);
    return server;
  }

  private async launch(options: StartOptions): Promise<void> {
    const port = options.port ?? (await freePort());
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENTARMY_CLAUDE_PATH: FAKE_CLAUDE_SHIM,
      AGENTARMY_HOME: path.join(options.home, '.agentarmy'),
      HOME: options.home,
      USERPROFILE: options.home,
      FAKE_CLAUDE_DELAY_MS: '1500',
      ...options.env,
    };
    // We may be running inside a Claude Code session; don't leak it into the server
    delete env.CLAUDECODE;
    delete env.AGENTARMY_TOKEN;

    // `node --import tsx` keeps it a single process, so stopping it is reliable
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', path.join('src', 'server', 'cli.ts'), '--no-open', '--port', String(port)],
      { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.proc = proc;
    proc.stdout!.setEncoding('utf8');
    proc.stderr!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => (this.output += d));
    proc.stderr!.on('data', (d: string) => (this.output += d));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Server did not print its URL within 30s. Output:\n${this.output}`));
      }, 30_000);
      const check = () => {
        const match = /AgentArmy is running: (http:\/\/[^\s]+)/.exec(this.output);
        if (!match) return;
        clearTimeout(timer);
        proc.stdout!.off('data', check);
        const url = new URL(match[1]);
        this.url = match[1];
        this.port = Number(url.port);
        this.token = url.searchParams.get('token') ?? '';
        resolve();
      };
      proc.stdout!.on('data', check);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}. Output:\n${this.output}`));
      });
      check();
    });
  }

  // Hard stop (like a crash or closing the terminal on Windows); kills the PTY children too
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    if (process.platform === 'win32') {
      // Server only: killing its tree first would let it see PTY exits and persist them as
      // 'exited'. Closing the server closes the ConPTYs, which ends the fake CLIs.
      spawnSync('taskkill', ['/pid', String(proc.pid), '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }

  async api<T = unknown>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.origin}${urlPath}`, {
      method,
      headers: {
        'x-agentarmy-token': this.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 15_000, interval = 100, message = 'condition' } = {},
): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for ${message}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
