import { startSignIn } from '../../_auth.js';
import { send, SITE_URL } from '../../_http.js';

// GET /api/auth/signin/github|google?next=/account -> redirect to the provider
export default function handler(req, res) {
  return send(res, startSignIn(req.query.provider, { env: process.env, siteUrl: SITE_URL, next: req.query.next }));
}
