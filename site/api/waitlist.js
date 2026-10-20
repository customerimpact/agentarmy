import { neon } from '@neondatabase/serverless';
import { handleSignup } from './_waitlist.js';

// POST /api/waitlist { email, source?, company? (honeypot) } -> { ok: true }
// DATABASE_URL comes from the Neon integration on the Vercel project.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'The waitlist is not open yet' });
  try {
    const { status, json } = await handleSignup(req.body, neon(process.env.DATABASE_URL));
    return res.status(status).json(json);
  } catch (err) {
    console.error('waitlist', err);
    return res.status(500).json({ error: 'Something went wrong. Try again in a minute.' });
  }
}
