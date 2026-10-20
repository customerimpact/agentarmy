// End-to-end encryption for shared boards: AES-256-GCM with the key from the share link
// (gridhive.dev/s/<id>#k=<key>; the part after "#" never reaches a server). Works in Node 22 and
// browsers (WebCrypto). Sender and receiver ids are bound as associated data, so the relay cannot
// redirect a message to someone else.

export interface SealedFrame {
  to: string;
  nonce: string;
  box: string;
}

const toB64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

export function newShareKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function importShareKey(raw: string): Promise<CryptoKey> {
  const bytes = fromB64(raw);
  if (bytes.length !== 32) throw new Error('Share key must be 32 bytes');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const aad = (from: string, to: string) => new TextEncoder().encode(`${from}>${to}`);

export async function seal(key: CryptoKey, from: string, to: string, message: unknown): Promise<SealedFrame> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(from, to) }, key, plain));
  return { to, nonce: toB64(nonce), box: toB64(box) };
}

// null when the frame was not sealed with this key for this sender and receiver
export async function open(key: CryptoKey, from: string, to: string, nonce: string, box: string): Promise<unknown> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(nonce), additionalData: aad(from, to) }, key, fromB64(box));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

// ---------- Messages inside the encrypted channel ----------
// Guest -> owner: hello, attach/detach a console, cursor. The owner's app ignores anything a
// guest's level does not allow (phase 1: viewers only watch, point and follow).

export type ShareLevel = 'viewer';

export interface SharePeer {
  dev: string;
  name: string;
  color: string;
  owner?: boolean;
}

export interface ShareCursor {
  x: number; // board (flow) coordinates
  y: number;
  vx?: number; // the sender's viewport, for "follow"
  vy?: number;
  vz?: number;
}

export type GuestMessage =
  | { t: 'hello' }
  | { t: 'attach'; id: string }
  | { t: 'detach'; id: string }
  | { t: 'cursor'; c: ShareCursor | null };

export interface ShareConsole {
  id: string;
  name: string;
  status: string;
  statusDetail?: string;
  activity?: string;
  agent?: string;
  role?: string;
  model?: string;
  projectId?: string | null;
  folder: string; // last path segment only
  layout: { x: number; y: number; width: number; height: number };
  todos?: { content: string; status: string }[];
}

export interface ShareProject {
  id: string;
  name: string;
  color?: string;
  consoleIds: string[];
}

export type OwnerMessage =
  | { t: 'snapshot'; title: string; level: ShareLevel; consoles: ShareConsole[]; projects: ShareProject[]; you: SharePeer; peers: SharePeer[] }
  | { t: 'console'; console: ShareConsole }
  | { t: 'removed'; id: string }
  | { t: 'project'; project: ShareProject }
  | { t: 'project-removed'; id: string }
  | { t: 'replay'; id: string; data: string; cols: number; rows: number }
  | { t: 'out'; id: string; data: string }
  | { t: 'peers'; peers: SharePeer[] }
  | { t: 'cursor'; dev: string; c: ShareCursor | null }
  | { t: 'bye'; reason: string };

// Pointer colors, picked from the device id so everyone sees the same color for a person
const COLORS = ['#f472b6', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc'];
export function peerColor(dev: string): string {
  let h = 0;
  for (const ch of dev) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
