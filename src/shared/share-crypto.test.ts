import { describe, expect, it } from 'vitest';
import { importShareKey, newShareKey, open, peerColor, seal } from './share-crypto';

describe('share encryption', () => {
  it('round-trips between the named sender and receiver only', async () => {
    const raw = newShareKey();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = await importShareKey(raw);
    const frame = await seal(key, 'owner', 'g_tim', { t: 'out', id: 'c1', data: 'hello' });
    expect(frame.to).toBe('g_tim');
    expect(frame.box).not.toContain('hello');
    expect(await open(key, 'owner', 'g_tim', frame.nonce, frame.box)).toEqual({ t: 'out', id: 'c1', data: 'hello' });
    // Redirected or spoofed frames do not open
    expect(await open(key, 'owner', 'g_eve', frame.nonce, frame.box)).toBeNull();
    expect(await open(key, 'g_eve', 'g_tim', frame.nonce, frame.box)).toBeNull();
    // Another share's key does not open it
    expect(await open(await importShareKey(newShareKey()), 'owner', 'g_tim', frame.nonce, frame.box)).toBeNull();
  });

  it('rejects keys of the wrong size and gives stable pointer colors', async () => {
    await expect(importShareKey('abc')).rejects.toThrow(/32 bytes/);
    expect(peerColor('g_tim')).toBe(peerColor('g_tim'));
    expect(peerColor('g_tim')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
