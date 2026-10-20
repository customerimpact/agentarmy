// Linking the GridHive app on a computer to an account (device code flow, like `gh auth login`).
// 1. The app calls start and shows/open gridhive.dev/link?code=ABCD-EFGH.
// 2. The signed-in user presses "Link this computer" there (confirm).
// 3. The app polls token and receives a device secret once; Neon keeps only its hash.
// The app never sees a password or the user's web session.
import crypto from 'node:crypto';
import { hashToken, SCHEMA as AUTH_SCHEMA } from './_auth.js';

export const CODE_MINUTES = 10;
export const POLL_SECONDS = 3;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_NAME = 60;

export const DEVICE_SCHEMA = [
  `create table if not exists devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    kind text not null check (kind in ('computer', 'phone')),
    name text not null,
    secret_hash text not null unique,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz
  )`,
  `create table if not exists device_codes (
    device_code_hash text primary key,
    user_code text not null unique,
    name text not null,
    user_id uuid references users(id) on delete cascade,
    expires_at timestamptz not null
  )`,
];

export function newUserCode(bytes = crypto.randomBytes(8)) {
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function normalizeUserCode(raw) {
  const clean = typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  return clean.length === 8 && [...clean].every((c) => ALPHABET.includes(c)) ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null;
}

function cleanName(raw) {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME) : '';
  return name || 'Computer';
}

// Devices point at users, so the users table has to exist first
async function ensureSchema(sql) {
  for (const statement of [...AUTH_SCHEMA, ...DEVICE_SCHEMA]) await sql.query(statement);
}

export async function startLink(body, { sql, siteUrl, now = Date.now() }) {
  await ensureSchema(sql);
  const deviceCode = crypto.randomBytes(32).toString('base64url');
  const userCode = newUserCode();
  const expires = new Date(now + CODE_MINUTES * 60_000).toISOString();
  await sql`delete from device_codes where expires_at < now()`;
  await sql`insert into device_codes (device_code_hash, user_code, name, expires_at)
            values (${hashToken(deviceCode)}, ${userCode}, ${cleanName(body?.name)}, ${expires})`;
  return {
    status: 200,
    json: { deviceCode, userCode, verifyUrl: `${siteUrl}/link?code=${userCode}`, interval: POLL_SECONDS, expiresIn: CODE_MINUTES * 60 },
  };
}

// The signed-in user approves the code shown by their app
export async function confirmLink(body, { sql, user }) {
  if (!user) return { status: 401, json: { error: 'Sign in first' } };
  const userCode = normalizeUserCode(body?.userCode);
  if (!userCode) return { status: 400, json: { error: 'That code does not look right' } };
  await ensureSchema(sql);
  const rows = await sql`update device_codes set user_id = ${user.id}
                         where user_code = ${userCode} and user_id is null and expires_at > now()
                         returning name`;
  if (!rows.length) return { status: 404, json: { error: 'This code is used or expired. Start again in the app.' } };
  return { status: 200, json: { ok: true, name: rows[0].name } };
}

// The app polls until the user confirmed; the secret is handed out exactly once
export async function pollLink(body, { sql }) {
  const deviceCode = typeof body?.deviceCode === 'string' ? body.deviceCode : '';
  if (!deviceCode) return { status: 400, json: { error: 'deviceCode is required' } };
  await ensureSchema(sql);
  const [code] = await sql`select user_id, name, expires_at from device_codes where device_code_hash = ${hashToken(deviceCode)}`;
  if (!code) return { status: 410, json: { error: 'expired' } };
  if (!code.user_id) {
    if (new Date(code.expires_at).getTime() < Date.now()) return { status: 410, json: { error: 'expired' } };
    return { status: 200, json: { pending: true } };
  }
  const deleted = await sql`delete from device_codes where device_code_hash = ${hashToken(deviceCode)} returning user_id`;
  if (!deleted.length) return { status: 410, json: { error: 'expired' } }; // another poll won the race
  const secret = crypto.randomBytes(32).toString('base64url');
  const [device] = await sql`insert into devices (user_id, kind, name, secret_hash)
                             values (${code.user_id}, 'computer', ${code.name}, ${hashToken(secret)}) returning id`;
  const [user] = await sql`select email, name from users where id = ${code.user_id}`;
  return { status: 200, json: { deviceId: device.id, deviceSecret: secret, user: { email: user.email, name: user.name } } };
}

export async function deviceForSecret(authorization, sql) {
  const secret = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!secret) return null;
  await ensureSchema(sql);
  const rows = await sql`update devices set last_seen_at = now() where secret_hash = ${hashToken(secret)}
                         returning id, user_id, name, kind`;
  return rows[0] ?? null;
}

export async function listDevices(user, sql) {
  await ensureSchema(sql);
  return sql`select id, kind, name, created_at, last_seen_at from devices where user_id = ${user.id} order by created_at`;
}

export async function removeDevice(user, id, sql) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return false;
  const rows = await sql`delete from devices where id = ${id} and user_id = ${user.id} returning id`;
  return rows.length > 0;
}
