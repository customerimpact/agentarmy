import { pollLink } from '../_devices.js';
import { db, fail, send } from '../_http.js';

// POST /api/devices/token { deviceCode } -> { pending } | { deviceId, deviceSecret, user } once | 410
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  try {
    return send(res, await pollLink(req.body, { sql: db() }));
  } catch (err) {
    return fail(res, err, 'devices token');
  }
}
