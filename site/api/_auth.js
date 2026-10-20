// Sign-in for gridhive.dev with GitHub or Google (OAuth 2 + PKCE), no framework.
// Sessions are random tokens: the browser keeps the token in an HttpOnly cookie, Neon keeps only
// its SHA-256 hash. Users are matched by verified email, so GitHub and Google with the same email
// end up in one account. Pure logic (fetch and sql injected) so it can be unit tested.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'gh_session';
export const SESSION_DAYS = 30;
const FLOW_COOKIE = 'gh_oauth';
const FLOW_MINUTES = 10;

export const PROVIDERS = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    idEnv: 'AUTH_GITHUB_ID',
    secretEnv: 'AUTH_GITHUB_SECRET',
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    idEnv: 'AUTH_GOOGLE_ID',
    secretEnv: 'AUTH_GOOGLE_SECRET',
  },
};

export const SCHEMA = [
  `create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    name text,
    image text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists auth_accounts (
    provider text not null,
    provider_account_id text not null,
    user_id uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (provider, provider_account_id)
  )`,
  `create table if not exists sessions (
    token_hash text primary key,
    user_id uuid not null references users(id) on delete cascade,
    expires_at timestamptz not null
  )`,
];

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

const cookie = (name, value, maxAge, path = '/') =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// Only same-site paths, so a sign-in link cannot bounce people to another site
export function safeNext(raw) {
  return typeof raw === 'string' && /^\/(?!\/)[A-Za-z0-9/_.?=&#-]*$/.test(raw) ? raw : '/account';
}

// Step 1: redirect to the provider, remembering state + PKCE verifier + where to return
export function startSignIn(providerId, { env, siteUrl, next }) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { status: 404, json: { error: 'Unknown sign-in provider' } };
  const clientId = env[provider.idEnv];
  if (!clientId || !env[provider.secretEnv]) return { status: 503, json: { error: `${providerId} sign-in is not set up yet` } };
  const state = random(24);
  const verifier = random(48);
  const url = new URL(provider.authorize);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${siteUrl}/api/auth/callback/${providerId}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (providerId === 'google') url.searchParams.set('prompt', 'select_account');
  const flow = JSON.stringify({ p: providerId, s: state, v: verifier, n: safeNext(next) });
  return { status: 302, location: url.toString(), cookies: [cookie(FLOW_COOKIE, flow, FLOW_MINUTES * 60, '/api/auth')] };
}

async function postForm(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return res.json();
}

// The provider's verified email and profile, or null when it has no verified email
export async function fetchProfile(providerId, accessToken, fetchImpl) {
  const auth = { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'GridHive' };
  if (providerId === 'github') {
    const user = await (await fetchImpl('https://api.github.com/user', { headers: auth })).json();
    const emails = await (await fetchImpl('https://api.github.com/user/emails', { headers: auth })).json();
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
    if (!primary || !user?.id) return null;
    return { id: String(user.id), email: primary.email.toLowerCase(), name: user.name || user.login || null, image: user.avatar_url || null };
  }
  const info = await (await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: auth })).json();
  if (!info?.sub || !info.email || info.email_verified !== true) return null;
  return { id: String(info.sub), email: info.email.toLowerCase(), name: info.name || null, image: info.picture || null };
}

// Step 2: check state, swap the code for a token, read the verified email, open a session
export async function finishSignIn(providerId, { query, cookieHeader, env, siteUrl, sql, fetchImpl, now = Date.now() }) {
  const clearFlow = cookie(FLOW_COOKIE, '', 0, '/api/auth');
  const fail = (message) => ({ status: 302, location: `/account?error=${encodeURIComponent(message)}`, cookies: [clearFlow] });
  const provider = PROVIDERS[providerId];
  if (!provider) return fail('Unknown sign-in provider');
  if (query.error) return fail('Sign-in was cancelled');
  let flow;
  try {
    flow = JSON.parse(readCookie(cookieHeader, FLOW_COOKIE) ?? '');
  } catch {
    return fail('Sign-in expired. Try again.');
  }
  if (!flow || flow.p !== providerId || typeof query.state !== 'string' || flow.s !== query.state || typeof query.code !== 'string') {
    return fail('Sign-in expired. Try again.');
  }
  const token = await postForm(fetchImpl, provider.token, {
    client_id: env[provider.idEnv],
    client_secret: env[provider.secretEnv],
    code: query.code,
    redirect_uri: `${siteUrl}/api/auth/callback/${providerId}`,
    grant_type: 'authorization_code',
    code_verifier: flow.v,
  });
  if (!token?.access_token) return fail('The sign-in provider did not accept the request. Try again.');
  const profile = await fetchProfile(providerId, token.access_token, fetchImpl);
  if (!profile) return fail('Your account has no verified email address');

  for (const statement of SCHEMA) await sql.query(statement);
  const [user] = await sql`
    insert into users (email, name, image) values (${profile.email}, ${profile.name}, ${profile.image})
    on conflict (email) do update set name = coalesce(users.name, excluded.name), image = coalesce(excluded.image, users.image)
    returning id, email, name`;
  await sql`
    insert into auth_accounts (provider, provider_account_id, user_id) values (${providerId}, ${profile.id}, ${user.id})
    on conflict (provider, provider_account_id) do nothing`;
  const session = random(32);
  const expires = new Date(now + SESSION_DAYS * 86_400_000).toISOString();
  await sql`insert into sessions (token_hash, user_id, expires_at) values (${hashToken(session)}, ${user.id}, ${expires})`;
  return { status: 302, location: safeNext(flow.n), cookies: [clearFlow, cookie(SESSION_COOKIE, session, SESSION_DAYS * 86_400)] };
}

export async function currentUser(cookieHeader, sql) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const rows = await sql`
    select u.id, u.email, u.name, u.image from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${hashToken(token)} and s.expires_at > now()`;
  return rows[0] ?? null;
}

export async function signOut(cookieHeader, sql) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token) await sql`delete from sessions where token_hash = ${hashToken(token)}`;
  return [cookie(SESSION_COOKIE, '', 0)];
}
