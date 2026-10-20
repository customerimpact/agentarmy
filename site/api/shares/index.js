import { deviceForSecret } from '../_devices.js';
import { db, fail, send, SITE_URL } from '../_http.js';
import { createShare, listShares, revokeShare, shareGuests } from '../_shares.js';

// The owner's app (Authorization: Bearer <device secret>):
// POST   /api/shares { title, level, expiresInHours } -> { id, url, level, expiresAt }
// GET    /api/shares                 -> { shares }
// GET    /api/shares?guests=<id>     -> { guests: [{ dev, name, email, image }] }
// DELETE /api/shares?id=<id>         -> { ok }
export default async function handler(req, res) {
  try {
    const sql = db();
    const device = await deviceForSecret(req.headers.authorization, sql);
    if (!device) return res.status(401).json({ error: 'Sign in to GridHive on this computer first' });
    if (req.method === 'POST') return send(res, await createShare(device, req.body, { sql, siteUrl: SITE_URL }));
    if (req.method === 'GET' && req.query.guests) {
      const guests = await shareGuests(device, req.query.guests, sql);
      return guests ? send(res, { json: { guests } }) : res.status(404).json({ error: 'Unknown share' });
    }
    if (req.method === 'GET') return send(res, { json: { shares: await listShares(device, sql) } });
    if (req.method === 'DELETE') {
      return (await revokeShare(device, req.query.id, sql)) ? send(res, { json: { ok: true } }) : res.status(404).json({ error: 'Unknown share' });
    }
    return res.status(405).json({ error: 'Use GET, POST or DELETE' });
  } catch (err) {
    return fail(res, err, 'shares');
  }
}
