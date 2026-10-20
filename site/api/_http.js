import { neon } from '@neondatabase/serverless';

// Shared bits for the Vercel functions: database, site URL and sending a result object
// ({ status, json?, location?, cookies? }) produced by the pure modules.

export const SITE_URL = process.env.SITE_URL || 'https://gridhive.dev';

export function db() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('Database not configured'), { status: 503 });
  return neon(process.env.DATABASE_URL);
}

export function send(res, result) {
  if (result.cookies?.length) res.setHeader('set-cookie', result.cookies);
  res.setHeader('cache-control', 'no-store');
  if (result.location) {
    res.setHeader('location', result.location);
    return res.status(result.status ?? 302).end();
  }
  return res.status(result.status ?? 200).json(result.json ?? {});
}

// Browsers send Origin on POST; only our own pages may sign out or change account data
export function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === SITE_URL || origin === `https://${req.headers.host}`;
}

export function fail(res, err, label) {
  console.error(label, err);
  return res.status(err.status ?? 500).json({ error: err.status === 503 ? err.message : 'Something went wrong. Try again in a minute.' });
}
