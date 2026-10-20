import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PhoneDevice } from '../../shared/protocol.js';

// Phone access on the local network (off by default). <AGENTARMY_HOME>/phone.json keeps the switch,
// the port and the paired phones. Device tokens are stored as SHA-256 hashes only; pairing codes
// live in memory, are single use and expire after PAIR_CODE_TTL_MS.

export const DEFAULT_PHONE_PORT = 4318;
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICES = 20;
const MAX_FAILED_PAIRS_PER_MINUTE = 20;

interface StoredDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

interface PhoneFile {
  version: 1;
  enabled: boolean;
  port: number;
  devices: StoredDevice[];
}

const hash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '';
  return name || 'Phone';
}

export class PhoneStore {
  private data: PhoneFile;
  private codes = new Map<string, number>(); // code -> expiry time
  private failures: number[] = [];

  constructor(
    readonly filePath: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
  }

  get enabled(): boolean {
    return this.data.enabled;
  }

  get port(): number {
    return this.data.port;
  }

  setEnabled(enabled: boolean): void {
    this.data.enabled = enabled;
    if (!enabled) this.codes.clear();
    this.save();
  }

  devices(): PhoneDevice[] {
    return this.data.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }));
  }

  // A fresh code replaces the older ones, so only the QR on screen works
  newPairCode(): { code: string; expiresAt: number } {
    this.codes.clear();
    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = this.now() + PAIR_CODE_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  // Trades a pairing code for a long-lived device token (returned once, never stored in clear)
  pair(code: unknown, name: unknown): { device: PhoneDevice; token: string } | 'invalid' | 'rate-limited' {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= MAX_FAILED_PAIRS_PER_MINUTE) return 'rate-limited';
    const expiresAt = typeof code === 'string' ? this.codes.get(code) : undefined;
    if (expiresAt === undefined || expiresAt < now) {
      this.failures.push(now);
      return 'invalid';
    }
    this.codes.delete(code as string);
    const token = crypto.randomBytes(32).toString('base64url');
    const device: StoredDevice = {
      id: crypto.randomUUID(),
      name: cleanName(name),
      tokenHash: hash(token),
      createdAt: now,
      lastSeenAt: now,
    };
    // Oldest phones drop off first
    this.data.devices = [...this.data.devices, device].slice(-MAX_DEVICES);
    this.save();
    const { tokenHash: _hash, ...visible } = device;
    return { device: visible, token };
  }

  deviceForToken(token: unknown): PhoneDevice | null {
    if (typeof token !== 'string' || !token) return null;
    const wanted = Buffer.from(hash(token), 'hex');
    const device = this.data.devices.find((d) => crypto.timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), wanted));
    if (!device) return null;
    // lastSeenAt is saved at most once a minute
    if (this.now() - device.lastSeenAt > 60_000) {
      device.lastSeenAt = this.now();
      this.save();
    }
    const { tokenHash: _hash, ...visible } = device;
    return visible;
  }

  removeDevice(id: string): boolean {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) return false;
    this.save();
    return true;
  }

  private load(): PhoneFile {
    const empty: PhoneFile = { version: 1, enabled: false, port: DEFAULT_PHONE_PORT, devices: [] };
    if (!this.filePath) return empty;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PhoneFile>;
      const port = Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : DEFAULT_PHONE_PORT;
      const devices = Array.isArray(raw.devices)
        ? raw.devices.filter(
            (d): d is StoredDevice =>
              !!d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash),
          )
        : [];
      return { version: 1, enabled: raw.enabled === true, port, devices };
    } catch {
      return empty;
    }
  }

  // 0600: the file holds device token hashes
  private save(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.filePath);
    } catch {
      fs.writeFileSync(this.filePath, json, { mode: 0o600 });
      fs.rmSync(tmp, { force: true });
    }
  }
}
