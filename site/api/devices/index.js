import { currentUser } from '../_auth.js';
import { deviceForSecret, listDevices, removeDevice } from '../_devices.js';
import { db, fail, sameOrigin, send } from '../_http.js';

// GET    /api/devices            (website session) -> { devices }
// GET    /api/devices?me=1       (Authorization: Bearer <device secret>) -> { device } for the app
// DELETE /api/devices?id=<uuid>  (website session) -> { ok }
export default async function handler(req, res) {
  try {
    const sql = db();
    if (req.method === 'GET' && req.query.me) {
      const device = await deviceForSecret(req.headers.authorization, sql);
      return device ? send(res, { json: { device } }) : res.status(401).json({ error: 'Unknown device' });
    }
    const user = await currentUser(req.headers.cookie, sql);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    if (req.method === 'GET') return send(res, { json: { devices: await listDevices(user, sql) } });
    if (req.method === 'DELETE') {
      if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden origin' });
      return (await removeDevice(user, req.query.id, sql)) ? send(res, { json: { ok: true } }) : res.status(404).json({ error: 'Unknown device' });
    }
    return res.status(405).json({ error: 'Use GET or DELETE' });
  } catch (err) {
    return fail(res, err, 'devices');
  }
}
