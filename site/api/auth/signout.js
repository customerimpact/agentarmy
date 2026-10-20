import { signOut } from '../_auth.js';
import { db, fail, sameOrigin, send } from '../_http.js';

// POST /api/auth/signout -> ends this browser's session
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden origin' });
  try {
    return send(res, { json: { ok: true }, cookies: await signOut(req.headers.cookie, db()) });
  } catch (err) {
    return fail(res, err, 'auth signout');
  }
}
