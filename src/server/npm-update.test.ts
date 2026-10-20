import { describe, expect, it } from 'vitest';
import { npmUpdateNotice, ownVersion } from './npm-update';

const answer = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('npmUpdateNotice', () => {
  it('names the newer version', async () => {
    expect(await npmUpdateNotice('0.0.3', answer(200, { version: '0.1.0' }))).toBe(
      'GridHive 0.1.0 is available (you have 0.0.3). Run: npx gridhive@latest',
    );
  });

  it('stays quiet when up to date, not published or offline', async () => {
    expect(await npmUpdateNotice('0.1.0', answer(200, { version: '0.1.0' }))).toBeNull();
    expect(await npmUpdateNotice('0.1.0', answer(404, { error: 'Not found' }))).toBeNull();
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await npmUpdateNotice('0.1.0', offline)).toBeNull();
  });
});

describe('ownVersion', () => {
  it('reads the package version', () => {
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
