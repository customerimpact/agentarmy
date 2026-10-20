import type { DeviceKind } from './token';

// The forwarding rules of one account's relay, without Cloudflare APIs so they can be unit tested.
// Frames are { to, nonce, box }: the relay adds `from` and passes them on unchanged. It never
// decrypts anything; box is ciphertext made by the devices (end-to-end encryption).

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_DEVICES = 20;
export const MAX_FRAMES_PER_SECOND = 200;

export interface Peer {
  id: string;
  kind: DeviceKind;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface Presence {
  type: 'presence';
  devices: { id: string; kind: DeviceKind }[];
}

export class RelayHub {
  private peers = new Map<string, Peer>();
  private rate = new Map<string, { second: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  // A device connecting again replaces its older connection
  join(peer: Peer): boolean {
    const old = this.peers.get(peer.id);
    if (!old && this.peers.size >= MAX_DEVICES) {
      peer.close(4429, 'Too many devices on this account');
      return false;
    }
    if (old) old.close(4000, 'Connected elsewhere');
    this.peers.set(peer.id, peer);
    this.announce();
    return true;
  }

  leave(id: string, peer?: Peer): void {
    if (peer && this.peers.get(id) !== peer) return; // an old connection closing after a replace
    if (this.peers.delete(id)) this.announce();
    this.rate.delete(id);
  }

  revoke(id: string): void {
    this.peers.get(id)?.close(4401, 'Device removed');
    this.leave(id);
  }

  // Returns an error string for the sender, or null when forwarded
  forward(fromId: string, raw: string): string | null {
    if (raw.length > MAX_FRAME_BYTES) return 'Frame too large';
    const second = Math.floor(this.now() / 1000);
    const rate = this.rate.get(fromId);
    if (rate && rate.second === second) {
      if (++rate.count > MAX_FRAMES_PER_SECOND) return 'Rate limited';
    } else {
      this.rate.set(fromId, { second, count: 1 });
    }
    let frame: { to?: unknown; nonce?: unknown; box?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return 'Not JSON';
    }
    if (typeof frame.to !== 'string' || typeof frame.nonce !== 'string' || typeof frame.box !== 'string') {
      return 'Frames need to, nonce and box';
    }
    const target = this.peers.get(frame.to);
    if (!target) return 'Device offline';
    target.send(JSON.stringify({ from: fromId, nonce: frame.nonce, box: frame.box }));
    return null;
  }

  devices(): Presence['devices'] {
    return [...this.peers.values()].map((p) => ({ id: p.id, kind: p.kind }));
  }

  private announce(): void {
    const text = JSON.stringify({ type: 'presence', devices: this.devices() } satisfies Presence);
    for (const peer of this.peers.values()) peer.send(text);
  }
}
