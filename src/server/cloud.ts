import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import open from 'open';
import type { CloudStatus, ServerMessage } from '../shared/protocol.js';

// Link this computer to a gridhive.dev account (device code flow, site/api/_devices.js).
// The app never sees a password: it shows a code, opens gridhive.dev/link in the browser and
// polls until the signed-in user confirms. The device secret lands in <AGENTARMY_HOME>/cloud.json (0600).

export const CLOUD_URL = process.env.GRIDHIVE_CLOUD_URL || 'https://gridhive.dev';

interface CloudFile {
  version: 1;
  deviceId: string;
  deviceSecret: string;
  user: { email: string; name: string | null };
  linkedAt: number;
}

interface Pending {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
}

export interface CloudOptions {
  filePath: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => void;
  promptDisabled?: boolean; // tests: never show the first-start sign-in prompt
  now?: () => number;
}

export class CloudLink extends EventEmitter {
  private file: CloudFile | null;
  private pending: Pending | null = null;
  private error: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly openUrl: (url: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: CloudOptions) {
    super();
    this.baseUrl = options.baseUrl ?? CLOUD_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.openUrl = options.openUrl ?? ((url) => void open(url).catch(() => undefined));
    this.now = options.now ?? Date.now;
    this.file = this.load();
  }

  status(): CloudStatus {
    return {
      linked: !!this.file,
      ...(this.file ? { user: this.file.user, linkedAt: this.file.linkedAt } : {}),
      ...(this.pending ? { pending: { userCode: this.pending.userCode, verifyUrl: this.pending.verifyUrl, expiresAt: this.pending.expiresAt } } : {}),
      ...(this.error ? { error: this.error } : {}),
      promptDisabled: !!this.options.promptDisabled,
      site: this.baseUrl,
    };
  }

  // The device secret, for relay tokens later; never sent to the browser UI
  credentials(): { deviceId: string; deviceSecret: string } | null {
    return this.file ? { deviceId: this.file.deviceId, deviceSecret: this.file.deviceSecret } : null;
  }

  // provider: open GitHub or Google sign-in straight away; it returns to the link page with the code
  async start(name = os.hostname(), provider?: 'github' | 'google'): Promise<CloudStatus> {
    this.cancel(false);
    this.error = undefined;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/devices/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`gridhive.dev answered ${res.status}`);
      const data = (await res.json()) as { deviceCode: string; userCode: string; verifyUrl: string; interval: number; expiresIn: number };
      this.pending = {
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verifyUrl: data.verifyUrl,
        expiresAt: this.now() + data.expiresIn * 1000,
        timer: null,
      };
      const linkPath = new URL(data.verifyUrl).pathname + new URL(data.verifyUrl).search;
      this.openUrl(provider ? `${this.baseUrl}/api/auth/signin/${provider}?next=${encodeURIComponent(linkPath)}` : data.verifyUrl);
      this.schedule(Math.max(1, data.interval) * 1000);
    } catch (err) {
      this.error = `Could not reach ${new URL(this.baseUrl).host}: ${(err as Error).message}`;
    }
    this.changed();
    return this.status();
  }

  // One poll; exposed for tests
  async poll(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (this.now() > pending.expiresAt) {
      this.pending = null;
      this.error = 'The code expired. Try again.';
      this.changed();
      return;
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/devices/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: pending.deviceCode }),
        signal: AbortSignal.timeout(15_000),
      });
      if (this.pending !== pending) return; // cancelled meanwhile
      if (res.status === 410) {
        this.pending = null;
        this.error = 'The code expired. Try again.';
        this.changed();
        return;
      }
      const data = (await res.json()) as { pending?: boolean; deviceId?: string; deviceSecret?: string; user?: CloudFile['user'] };
      if (data.deviceId && data.deviceSecret && data.user) {
        this.file = { version: 1, deviceId: data.deviceId, deviceSecret: data.deviceSecret, user: data.user, linkedAt: this.now() };
        this.save();
        this.pending = null;
        this.changed();
        return;
      }
    } catch {
      // offline for a moment: keep polling until the code expires
    }
  }

  cancel(notify = true): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    if (notify) this.changed();
  }

  unlink(): CloudStatus {
    this.cancel(false);
    this.file = null;
    if (this.options.filePath) fs.rmSync(this.options.filePath, { force: true });
    this.changed();
    return this.status();
  }

  private schedule(ms: number): void {
    const pending = this.pending;
    if (!pending) return;
    pending.timer = setTimeout(() => {
      void this.poll().then(() => {
        if (this.pending === pending) this.schedule(ms);
      });
    }, ms);
    pending.timer.unref?.();
  }

  private changed(): void {
    this.emit('change', this.status());
  }

  private load(): CloudFile | null {
    if (!this.options.filePath) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.options.filePath, 'utf8')) as Partial<CloudFile>;
      if (typeof data.deviceId !== 'string' || typeof data.deviceSecret !== 'string' || !data.user?.email) return null;
      return data as CloudFile;
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.options.filePath || !this.file) return;
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    fs.writeFileSync(this.options.filePath, JSON.stringify(this.file, null, 2), { mode: 0o600 });
  }
}

export function registerCloudRoutes(
  app: FastifyInstance,
  options: { dataDir: string | null; broadcast: (msg: ServerMessage) => void },
): CloudLink {
  const cloud = new CloudLink({
    filePath: options.dataDir ? path.join(options.dataDir, 'cloud.json') : null,
    promptDisabled: process.env.AGENTARMY_NO_SIGNIN_PROMPT === '1',
  });
  cloud.on('change', (status: CloudStatus) => options.broadcast({ type: 'cloud', cloud: status }));
  app.addHook('onClose', async () => cloud.cancel(false));

  app.get('/api/cloud', async () => cloud.status());
  app.post('/api/cloud/link', async (request) => {
    const provider = (request.body as { provider?: unknown } | undefined)?.provider;
    return cloud.start(undefined, provider === 'github' || provider === 'google' ? provider : undefined);
  });
  app.post('/api/cloud/cancel', async () => {
    cloud.cancel();
    return cloud.status();
  });
  app.post('/api/cloud/unlink', async () => cloud.unlink());
  return cloud;
}
