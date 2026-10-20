import { db, fail, send } from '../_http.js';
import { shareInfo } from '../_shares.js';

// GET /api/shares/info?id=<id> -> title, owner name, level, expiry (for the guest page)
export default async function handler(req, res) {
  try {
    return send(res, await shareInfo(req.query.id, db()));
  } catch (err) {
    return fail(res, err, 'shares info');
  }
}
