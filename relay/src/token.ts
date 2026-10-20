// Relay tokens: base64url(JSON payload) + "." + base64url(Ed25519 signature over the payload part).
// gridhive.dev signs them with the private key (Vercel env); the relay only holds the public key,
// so a leaked Worker config cannot mint tokens. Tokens live 10 minutes.

// guest: someone following a shared board (sub = s_<shareId>); the owner's app enforces their level
export type DeviceKind = 'computer' | 'phone' | 'guest';

export interface RelayClaims {
  sub: string; // account id, or s_<shareId> for a shared board: one Durable Object each
  dev: string; // device id
  kind: DeviceKind;
  exp: number; // unix seconds
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function importPublicKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64url(raw), { name: 'Ed25519' }, false, ['verify']);
}

// Used by gridhive.dev (and tests); the private key is a PKCS#8 export in base64url
export async function signRelayToken(claims: RelayClaims, privateKey: CryptoKey): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyRelayToken(token: string, publicKey: CryptoKey, nowSeconds: number): Promise<RelayClaims | null> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, fromBase64url(signature), new TextEncoder().encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  let claims: Partial<RelayClaims>;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Partial<RelayClaims>;
  } catch {
    return null;
  }
  if (typeof claims.sub !== 'string' || !ID.test(claims.sub)) return null;
  if (typeof claims.dev !== 'string' || !ID.test(claims.dev)) return null;
  if (claims.kind !== 'computer' && claims.kind !== 'phone' && claims.kind !== 'guest') return null;
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds) return null;
  return { sub: claims.sub, dev: claims.dev, kind: claims.kind, exp: claims.exp };
}
