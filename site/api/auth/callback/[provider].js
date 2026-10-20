import { finishSignIn } from '../../_auth.js';
import { db, fail, send, SITE_URL } from '../../_http.js';

// GET /api/auth/callback/github|google (registered as the OAuth redirect URI)
export default async function handler(req, res) {
  try {
    const result = await finishSignIn(req.query.provider, {
      query: req.query,
      cookieHeader: req.headers.cookie,
      env: process.env,
      siteUrl: SITE_URL,
      sql: db(),
      fetchImpl: fetch,
    });
    return send(res, result);
  } catch (err) {
    return fail(res, err, 'auth callback');
  }
}
