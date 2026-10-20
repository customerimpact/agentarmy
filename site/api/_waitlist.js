// Waitlist for "GridHive from anywhere" (phone relay + accounts). Pure logic, tested in
// waitlist.test.mjs; api/waitlist.js wires it to Neon. Emails are stored lowercase, once.

const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

export const CREATE_TABLE = `
  create table if not exists waitlist (
    email text primary key,
    source text,
    created_at timestamptz not null default now()
  )`;

export function parseSignup(body) {
  if (!body || typeof body !== 'object') return { error: 'Send your email address' };
  // Bots fill every field; people never see this one
  if (typeof body.company === 'string' && body.company.trim()) return { ignore: true };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) return { error: 'That does not look like an email address' };
  const source = typeof body.source === 'string' ? body.source.slice(0, 40).replace(/[^a-z0-9_-]/gi, '') : '';
  return { email, source: source || 'site' };
}

// sql: a tagged-template query function (neon() in production, a fake in tests)
export async function handleSignup(body, sql) {
  const parsed = parseSignup(body);
  if (parsed.error) return { status: 400, json: { error: parsed.error } };
  // Same answer for bots and repeats, so the endpoint does not reveal who signed up
  if (!parsed.ignore) {
    await sql.query(CREATE_TABLE);
    await sql`insert into waitlist (email, source) values (${parsed.email}, ${parsed.source}) on conflict (email) do nothing`;
  }
  return { status: 200, json: { ok: true } };
}
