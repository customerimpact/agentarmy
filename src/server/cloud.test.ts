import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudLink } from './cloud';

function fakeSite(sequence: { status: number; body: unknown }[]) {
  const calls: string[] = [];
  let poll = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/devices/start')) {
      return new Response(JSON.stringify({ deviceCode: 'dc', userCode: 'ABCD-EFGH', verifyUrl: 'https://site.test/link?code=ABCD-EFGH', interval: 3, expiresIn: 600 }));
    }
    const next = sequence[Math.min(poll++, sequence.length - 1)];
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('CloudLink', () => {
  it('opens the link page, polls until confirmed, and stores the secret privately', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridhive-cloud-')), 'cloud.json');
    const opened: string[] = [];
    const { fetchImpl } = fakeSite([
      { status: 200, body: { pending: true } },
      { status: 200, body: { deviceId: 'd1', deviceSecret: 'secret', user: { email: 'tim@example.dev', name: 'Tim' } } },
    ]);
    const cloud = new CloudLink({ filePath: file, baseUrl: 'https://site.test', fetchImpl, openUrl: (u) => opened.push(u) });
    const started = await cloud.start('Tims PC');
    cloud.cancel(false); // drive the polls by hand
    expect(opened).toEqual(['https://site.test/link?code=ABCD-EFGH']);
    expect(started.pending?.userCode).toBe('ABCD-EFGH');

    // Re-arm the pending state that cancel() cleared, then poll twice
    const again = new CloudLink({ filePath: file, baseUrl: 'https://site.test', fetchImpl, openUrl: () => undefined });
    await again.start();
    again.cancel(false);
    (again as unknown as { pending: unknown }).pending = { deviceCode: 'dc', userCode: 'ABCD-EFGH', verifyUrl: '', expiresAt: Date.now() + 60_000, timer: null };
    await again.poll();
    expect(again.status().linked).toBe(false); // still pending
    await again.poll();
    expect(again.status().linked).toBe(true);
    expect(again.status().user).toEqual({ email: 'tim@example.dev', name: 'Tim' });
    expect(JSON.stringify(again.status())).not.toContain('secret');
    expect(again.credentials()).toEqual({ deviceId: 'd1', deviceSecret: 'secret' });
    expect(new CloudLink({ filePath: file }).status().linked).toBe(true);

    again.unlink();
    expect(fs.existsSync(file)).toBe(false);
    expect(again.status().linked).toBe(false);
  });

  it('reports an expired code and an unreachable site', async () => {
    const { fetchImpl } = fakeSite([{ status: 410, body: { error: 'expired' } }]);
    const cloud = new CloudLink({ filePath: null, baseUrl: 'https://site.test', fetchImpl, openUrl: () => undefined });
    await cloud.start();
    cloud.cancel(false);
    (cloud as unknown as { pending: unknown }).pending = { deviceCode: 'dc', userCode: 'X', verifyUrl: '', expiresAt: Date.now() + 60_000, timer: null };
    await cloud.poll();
    expect(cloud.status()).toMatchObject({ linked: false, error: 'The code expired. Try again.' });

    const offline = new CloudLink({
      filePath: null,
      baseUrl: 'https://site.test',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      openUrl: () => undefined,
    });
    expect((await offline.start()).error).toMatch(/Could not reach site.test/);
  });
});
