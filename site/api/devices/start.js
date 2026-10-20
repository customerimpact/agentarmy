import { startLink } from '../_devices.js';
import { db, fail, send, SITE_URL } from '../_http.js';

// POST /api/devices/start { name } -> { deviceCode, userCode, verifyUrl, interval, expiresIn }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  try {
    return send(res, await startLink(req.body, { sql: db(), siteUrl: SITE_URL }));
  } catch (err) {
    return fail(res, err, 'devices start');
  }
}
