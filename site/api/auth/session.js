import { currentUser } from '../_auth.js';
import { db, fail, send } from '../_http.js';

// GET /api/auth/session -> { user: { id, email, name, image } | null }
export default async function handler(req, res) {
  try {
    return send(res, { json: { user: await currentUser(req.headers.cookie, db()) } });
  } catch (err) {
    return fail(res, err, 'auth session');
  }
}
