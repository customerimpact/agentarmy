import { currentUser } from '../_auth.js';
import { confirmLink } from '../_devices.js';
import { db, fail, sameOrigin, send } from '../_http.js';

// POST /api/devices/confirm { userCode } (signed in on gridhive.dev/link)
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden origin' });
  try {
    const sql = db();
    return send(res, await confirmLink(req.body, { sql, user: await currentUser(req.headers.cookie, sql) }));
  } catch (err) {
    return fail(res, err, 'devices confirm');
  }
}
