// Shared boards (live sharing, phase 1: Viewer). gridhive.dev only knows who may join which share
// and until when; the board itself travels end-to-end encrypted through the relay (key in the link
// after "#"). The owner's app enforces the level on every guest message.
import crypto from 'node:crypto';

export const LEVELS = ['viewer']; // collaborator and copilot come in later phases
export const MAX_SHARE_HOURS = 24 * 30;
export const RELAY_TOKEN_SECONDS = 600;

export const SHARE_SCHEMA = [
  `create table if not exists shares (
    id text primary key,
    owner_user_id uuid not null references users(id) on delete cascade,
    device_id uuid not null references devices(id) on delete cascade,
    level text not null,
    title text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz
  )`,
  `create table if not exists share_guests (
    share_id text not null references shares(id) on delete cascade,
    dev text not null,
    user_id uuid not null references users(id) on delete cascade,
    joined_at timestamptz not null default now(),
    primary key (share_id, dev)
  )`,
];

async function ensureSchema(sql) {
  for (const statement of SHARE_SCHEMA) await sql.query(statement);
}

const cleanTitle = (raw) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '') || 'GridHive board';
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);

// Stable per person per share, so a guest reconnecting keeps their pointer color and name
export function guestDev(shareId, userId) {
  return `g_${crypto.createHash('sha256').update(`${shareId}:${userId}`).digest('base64url').slice(0, 20)}`;
}

export async function createShare(device, body, { sql, siteUrl }) {
  await ensureSchema(sql);
  const level = LEVELS.includes(body?.level) ? body.level : 'viewer';
  const hours = Number(body?.expiresInHours);
  const expires = Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + Math.min(hours, MAX_SHARE_HOURS) * 3_600_000).toISOString() : null;
  const id = crypto.randomBytes(9).toString('base64url');
  await sql`insert into shares (id, owner_user_id, device_id, level, title, expires_at)
            values (${id}, ${device.user_id}, ${device.id}, ${level}, ${cleanTitle(body?.title)}, ${expires})`;
  return { status: 200, json: { id, level, url: `${siteUrl}/s/${id}`, expiresAt: expires } };
}

export async function listShares(device, sql) {
  await ensureSchema(sql);
  return sql`select id, level, title, created_at, expires_at from shares
             where device_id = ${device.id} and revoked_at is null and (expires_at is null or expires_at > now())
             order by created_at desc`;
}

export async function revokeShare(device, id, sql) {
  if (!validId(id)) return false;
  await ensureSchema(sql);
  const rows = await sql`update shares set revoked_at = now() where id = ${id} and device_id = ${device.id} and revoked_at is null returning id`;
  return rows.length > 0;
}

export async function shareGuests(device, id, sql) {
  if (!validId(id)) return null;
  await ensureSchema(sql);
  const [share] = await sql`select id from shares where id = ${id} and device_id = ${device.id}`;
  if (!share) return null;
  return sql`select g.dev, u.name, u.email, u.image from share_guests g join users u on u.id = g.user_id where g.share_id = ${id}`;
}

async function activeShare(id, sql) {
  if (!validId(id)) return null;
  await ensureSchema(sql);
  const [share] = await sql`select s.id, s.level, s.title, s.device_id, s.owner_user_id, s.expires_at, u.name as owner_name, u.email as owner_email
                            from shares s join users u on u.id = s.owner_user_id
                            where s.id = ${id} and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())`;
  return share ?? null;
}

// What a guest sees before joining (no secrets: the encryption key stays in the link)
export async function shareInfo(id, sql) {
  const share = await activeShare(id, sql);
  if (!share) return { status: 404, json: { error: 'This share link has expired or was turned off' } };
  return {
    status: 200,
    json: { id: share.id, level: share.level, title: share.title, owner: share.owner_name || share.owner_email, ownerDevice: share.device_id, expiresAt: share.expires_at },
  };
}

// Claims for a relay token in the share's room; the caller signs them
export async function shareRelayClaims({ shareId, device, user }, sql) {
  const share = await activeShare(shareId, sql);
  if (!share) return null;
  const exp = Math.floor(Date.now() / 1000) + RELAY_TOKEN_SECONDS;
  if (device) {
    if (share.device_id !== device.id) return null;
    return { sub: `s_${share.id}`, dev: device.id, kind: 'computer', exp };
  }
  if (!user) return null;
  const dev = guestDev(share.id, user.id);
  await sql`insert into share_guests (share_id, dev, user_id) values (${share.id}, ${dev}, ${user.id}) on conflict (share_id, dev) do nothing`;
  return { sub: `s_${share.id}`, dev, kind: 'guest', exp, level: share.level, ownerDevice: share.device_id };
}
