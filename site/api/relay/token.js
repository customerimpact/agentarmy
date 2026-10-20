import { currentUser } from '../_auth.js';
import { deviceForSecret } from '../_devices.js';
import { db, fail, sameOrigin, send } from '../_http.js';
import { RELAY_URL, signRelayClaims } from '../_relay.js';
import { shareRelayClaims } from '../_shares.js';

// POST /api/relay/token { share } -> { token, relayUrl, expiresAt, dev, kind, level?, ownerDevice? }
// The owner's app sends its device secret (Bearer); a guest's browser sends its gridhive.dev session.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  try {
    const sql = db();
    const device = req.headers.authorization ? await deviceForSecret(req.headers.authorization, sql) : null;
    if (req.headers.authorization && !device) return res.status(401).json({ error: 'Unknown device' });
    if (!device && !sameOrigin(req)) return res.status(403).json({ error: 'Forbidden origin' });
    const user = device ? null : await currentUser(req.headers.cookie, sql);
    if (!device && !user) return res.status(401).json({ error: 'Sign in first' });
    const claims = await shareRelayClaims({ shareId: req.body?.share, device, user }, sql);
    if (!claims) return res.status(404).json({ error: 'This share link has expired or was turned off' });
    const token = await signRelayClaims(claims);
    return send(res, {
      json: {
        token,
        relayUrl: RELAY_URL,
        expiresAt: claims.exp * 1000,
        dev: claims.dev,
        kind: claims.kind,
        ...(claims.level ? { level: claims.level, ownerDevice: claims.ownerDevice } : {}),
      },
    });
  } catch (err) {
    return fail(res, err, 'relay token');
  }
}
