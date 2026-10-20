import { describe, expect, it } from 'vitest';
import { hashToken } from './_auth.js';
import { confirmLink, deviceForSecret, newUserCode, normalizeUserCode, pollLink, startLink } from './_devices.js';

// Just enough of Neon to run the device flow: device_codes, devices, users
function fakeDb() {
  const codes = new Map(); // hash -> row
  const devices = [];
  const users = new Map([['u1', { email: 'tim@example.dev', name: 'Tim' }]]);
  const sql = async (strings, ...v) => {
    const q = strings.join('?');
    if (q.startsWith('delete from device_codes where expires_at')) return [];
    if (q.startsWith('insert into device_codes')) {
      codes.set(v[0], { user_code: v[1], name: v[2], expires_at: v[3], user_id: null });
      return [];
    }
    if (q.startsWith('update device_codes set user_id')) {
      const row = [...codes.values()].find((c) => c.user_code === v[1] && !c.user_id && new Date(c.expires_at) > new Date());
      if (!row) return [];
      row.user_id = v[0];
      return [{ name: row.name }];
    }
    if (q.startsWith('select user_id, name, expires_at from device_codes')) {
      const row = codes.get(v[0]);
      return row ? [row] : [];
    }
    if (q.startsWith('delete from device_codes where device_code_hash')) {
      const row = codes.get(v[0]);
      codes.delete(v[0]);
      return row ? [{ user_id: row.user_id }] : [];
    }
    if (q.startsWith('insert into devices')) {
      const device = { id: `d${devices.length + 1}`, user_id: v[0], name: v[1], secret_hash: v[2] };
      devices.push(device);
      return [{ id: device.id }];
    }
    if (q.startsWith('select email, name from users')) return [users.get(v[0])];
    if (q.startsWith('update devices set last_seen_at')) {
      const d = devices.find((x) => x.secret_hash === v[0]);
      return d ? [{ id: d.id, user_id: d.user_id, name: d.name, kind: 'computer' }] : [];
    }
    throw new Error(`unexpected query: ${q}`);
  };
  sql.query = async () => [];
  return { sql, codes, devices };
}

const SITE = 'https://gridhive.dev';

describe('user codes', () => {
  it('are 8 characters without look-alikes, in two groups', () => {
    expect(newUserCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe('ABCD-EFGH');
    for (let i = 0; i < 50; i++) expect(newUserCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeUserCode(' abcd efgh ')).toBe('ABCD-EFGH');
    expect(normalizeUserCode('ABCD-EFG0')).toBeNull();
    expect(normalizeUserCode('short')).toBeNull();
  });
});

describe('linking a computer', () => {
  it('start -> confirm by the signed-in user -> one secret, stored hashed', async () => {
    const { sql, devices } = fakeDb();
    const started = (await startLink({ name: 'Tims PC\n' }, { sql, siteUrl: SITE })).json;
    expect(started.verifyUrl).toBe(`${SITE}/link?code=${started.userCode}`);
    expect((await pollLink({ deviceCode: started.deviceCode }, { sql })).json).toEqual({ pending: true });

    expect((await confirmLink({ userCode: started.userCode }, { sql, user: null })).status).toBe(401);
    const ok = await confirmLink({ userCode: started.userCode.toLowerCase() }, { sql, user: { id: 'u1' } });
    expect(ok.json).toEqual({ ok: true, name: 'Tims PC' });

    const linked = (await pollLink({ deviceCode: started.deviceCode }, { sql })).json;
    expect(linked.user).toEqual({ email: 'tim@example.dev', name: 'Tim' });
    expect(devices[0].secret_hash).toBe(hashToken(linked.deviceSecret));
    expect(devices[0].secret_hash).not.toBe(linked.deviceSecret);
    // Handed out once only
    expect((await pollLink({ deviceCode: started.deviceCode }, { sql })).status).toBe(410);

    expect(await deviceForSecret(`Bearer ${linked.deviceSecret}`, sql)).toMatchObject({ id: 'd1', user_id: 'u1' });
    expect(await deviceForSecret('Bearer nope', sql)).toBeNull();
    expect(await deviceForSecret(undefined, sql)).toBeNull();
  });

  it('a code cannot be confirmed twice or by guessing', async () => {
    const { sql } = fakeDb();
    const started = (await startLink({}, { sql, siteUrl: SITE })).json;
    await confirmLink({ userCode: started.userCode }, { sql, user: { id: 'u1' } });
    expect((await confirmLink({ userCode: started.userCode }, { sql, user: { id: 'u2' } })).status).toBe(404);
    expect((await confirmLink({ userCode: 'ZZZZ-ZZZZ' }, { sql, user: { id: 'u1' } })).status).toBe(404);
    expect((await pollLink({ deviceCode: 'unknown' }, { sql })).status).toBe(410);
  });
});
