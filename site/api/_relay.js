// Signs relay tokens with RELAY_PRIVATE_KEY (Ed25519, PKCS#8, base64url; set by npm run relay:keys).
// Same format as relay/src/token.ts: base64url(JSON) + "." + base64url(signature).

export const RELAY_URL = process.env.RELAY_URL || 'wss://gridhive-relay.gridhive-relay.workers.dev/v1/connect';

let cached = null;
async function privateKey(raw) {
  if (cached?.raw !== raw) {
    cached = { raw, key: crypto.subtle.importKey('pkcs8', Buffer.from(raw, 'base64url'), { name: 'Ed25519' }, false, ['sign']) };
  }
  return cached.key;
}

export async function signRelayClaims(claims, raw = process.env.RELAY_PRIVATE_KEY) {
  if (!raw) throw Object.assign(new Error('Relay key not configured'), { status: 503 });
  const { sub, dev, kind, exp } = claims;
  const payload = Buffer.from(JSON.stringify({ sub, dev, kind, exp })).toString('base64url');
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, await privateKey(raw), new TextEncoder().encode(payload));
  return `${payload}.${Buffer.from(signature).toString('base64url')}`;
}
