import { describe, expect, it } from 'vitest';
import { currentUser, finishSignIn, hashToken, readCookie, safeNext, signOut, startSignIn } from './_auth.js';

const ENV = { AUTH_GITHUB_ID: 'gh-id', AUTH_GITHUB_SECRET: 'gh-secret', AUTH_GOOGLE_ID: 'g-id', AUTH_GOOGLE_SECRET: 'g-secret' };
const SITE = 'https://gridhive.dev';

// Records queries; returns a user row for the users upsert and a session lookup
function fakeSql({ sessionRow } = {}) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('insert into users')) return [{ id: 'u1', email: values[0], name: values[1] }];
    if (text.includes('from sessions s join users')) return sessionRow ? [sessionRow] : [];
    return [];
  };
  sql.query = async () => [];
  return { sql, calls };
}

function fakeFetch(map) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url: String(url), init });
    const body = map[String(url)];
    return { json: async () => (typeof body === 'function' ? body(init) : body) };
  };
  return { impl, seen };
}

function begin(provider, next) {
  const start = startSignIn(provider, { env: ENV, siteUrl: SITE, next });
  const url = new URL(start.location);
  const flowCookie = start.cookies[0].split(';')[0];
  return { start, url, cookieHeader: flowCookie, state: url.searchParams.get('state') };
}

describe('startSignIn', () => {
  it('redirects to GitHub with state, PKCE and our callback', () => {
    const { start, url } = begin('github', '/account?x=1');
    expect(start.status).toBe(302);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gridhive.dev/api/auth/callback/github');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.cookies[0]).toMatch(/^gh_oauth=.*HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
    expect(start.cookies[0]).not.toContain('gh-secret');
  });

  it('refuses unknown providers and providers without keys', () => {
    expect(startSignIn('evil', { env: ENV, siteUrl: SITE }).status).toBe(404);
    expect(startSignIn('google', { env: {}, siteUrl: SITE }).status).toBe(503);
  });

  it('only returns to paths on this site', () => {
    expect(safeNext('/account')).toBe('/account');
    expect(safeNext('//evil.example')).toBe('/account');
    expect(safeNext('https://evil.example')).toBe('/account');
    expect(safeNext(undefined)).toBe('/account');
  });
});

describe('finishSignIn', () => {
  it('GitHub: verified primary email -> user, account and a hashed session', async () => {
    const { cookieHeader, state } = begin('github', '/account');
    const { sql, calls } = fakeSql();
    const { impl, seen } = fakeFetch({
      'https://github.com/login/oauth/access_token': { access_token: 'tok' },
      'https://api.github.com/user': { id: 42, login: 'tim', name: null, avatar_url: 'https://a/x.png' },
      'https://api.github.com/user/emails': [
        { email: 'old@x.io', primary: false, verified: true },
        { email: 'Tim@Example.dev', primary: true, verified: true },
      ],
    });
    const result = await finishSignIn('github', { query: { code: 'c1', state }, cookieHeader, env: ENV, siteUrl: SITE, sql, fetchImpl: impl });
    expect(result.status).toBe(302);
    expect(result.location).toBe('/account');
    const session = readCookie(result.cookies[1].split(';')[0], 'gh_session');
    expect(session).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(calls.find((c) => c.text.includes('insert into users')).values).toEqual(['tim@example.dev', 'tim', 'https://a/x.png']);
    expect(calls.find((c) => c.text.includes('insert into auth_accounts')).values).toEqual(['github', '42', 'u1']);
    expect(calls.find((c) => c.text.includes('insert into sessions')).values[0]).toBe(hashToken(session));
    const tokenBody = new URLSearchParams(seen[0].init.body);
    expect(tokenBody.get('client_secret')).toBe('gh-secret');
    expect(tokenBody.get('code_verifier')).toBeTruthy();
  });

  it('Google: refuses an unverified email', async () => {
    const { cookieHeader, state } = begin('google');
    const { sql, calls } = fakeSql();
    const { impl } = fakeFetch({
      'https://oauth2.googleapis.com/token': { access_token: 'tok' },
      'https://openidconnect.googleapis.com/v1/userinfo': { sub: '7', email: 'x@y.io', email_verified: false },
    });
    const result = await finishSignIn('google', { query: { code: 'c', state }, cookieHeader, env: ENV, siteUrl: SITE, sql, fetchImpl: impl });
    expect(result.location).toBe('/account?error=Your%20account%20has%20no%20verified%20email%20address');
    expect(calls).toHaveLength(0);
  });

  it('refuses a wrong state, a missing flow cookie and another provider\'s flow', async () => {
    const { cookieHeader, state } = begin('github');
    const { sql } = fakeSql();
    const { impl, seen } = fakeFetch({});
    const args = { env: ENV, siteUrl: SITE, sql, fetchImpl: impl };
    const bad = [
      await finishSignIn('github', { ...args, query: { code: 'c', state: 'forged' }, cookieHeader }),
      await finishSignIn('github', { ...args, query: { code: 'c', state }, cookieHeader: '' }),
      await finishSignIn('google', { ...args, query: { code: 'c', state }, cookieHeader }),
      await finishSignIn('github', { ...args, query: { error: 'access_denied' }, cookieHeader }),
    ];
    for (const r of bad) expect(r.location).toMatch(/^\/account\?error=/);
    expect(seen).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('looks up the user by the hashed cookie and signs out', async () => {
    const { sql, calls } = fakeSql({ sessionRow: { id: 'u1', email: 'tim@example.dev' } });
    expect(await currentUser('gh_session=abc', sql)).toEqual({ id: 'u1', email: 'tim@example.dev' });
    expect(calls[0].values).toEqual([hashToken('abc')]);
    expect(await currentUser('', sql)).toBeNull();
    const cookies = await signOut('gh_session=abc', sql);
    expect(cookies[0]).toMatch(/^gh_session=; .*Max-Age=0/);
    expect(calls.at(-1).text).toContain('delete from sessions');
  });
});
