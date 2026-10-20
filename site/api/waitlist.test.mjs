import { describe, expect, it } from 'vitest';
import { handleSignup, parseSignup } from './_waitlist.js';

function fakeSql() {
  const rows = [];
  const sql = (strings, ...values) => {
    rows.push(values);
    return Promise.resolve([]);
  };
  sql.query = () => Promise.resolve([]);
  return { sql, rows };
}

describe('waitlist', () => {
  it('stores a valid email once, lowercased, with its source', async () => {
    const { sql, rows } = fakeSql();
    expect(await handleSignup({ email: '  Tim@Example.dev ', source: 'hero' }, sql)).toEqual({ status: 200, json: { ok: true } });
    expect(rows).toEqual([['tim@example.dev', 'hero']]);
  });

  it('rejects bad emails and ignores bots quietly', async () => {
    const { sql, rows } = fakeSql();
    expect((await handleSignup({ email: 'nope' }, sql)).status).toBe(400);
    expect((await handleSignup({ email: 'a@b.c' }, sql)).status).toBe(400);
    expect((await handleSignup(null, sql)).status).toBe(400);
    expect(await handleSignup({ email: 'bot@spam.io', company: 'ACME' }, sql)).toEqual({ status: 200, json: { ok: true } });
    expect(rows).toEqual([]);
  });

  it('cleans the source tag', () => {
    expect(parseSignup({ email: 'x@y.io', source: '<script>' })).toEqual({ email: 'x@y.io', source: 'script' });
    expect(parseSignup({ email: 'x@y.io' }).source).toBe('site');
  });
});
