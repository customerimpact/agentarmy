import { describe, expect, it } from 'vitest';
import { importPublicKey, verifyRelayToken } from '../../relay/src/token';
import { signRelayClaims } from './_relay.js';
import { guestDev } from './_shares.js';

describe('relay tokens from gridhive.dev', () => {
  it('are accepted by the relay with the matching public key, and only that key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const privateRaw = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64url');
    const publicRaw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const claims = { sub: 's_abcdefghijkl', dev: guestDev('abcdefghijkl', 'u1'), kind: 'guest', exp: 2_000_000_000, level: 'viewer' };
    const token = await signRelayClaims(claims, privateRaw);
    // Extra fields (level) are not signed into the token; the owner's app decides the level
    expect(await verifyRelayToken(token, await importPublicKey(publicRaw), 1_000)).toEqual({
      sub: 's_abcdefghijkl',
      dev: claims.dev,
      kind: 'guest',
      exp: 2_000_000_000,
    });
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const otherRaw = Buffer.from(await crypto.subtle.exportKey('raw', other.publicKey)).toString('base64url');
    expect(await verifyRelayToken(token, await importPublicKey(otherRaw), 1_000)).toBeNull();
  });

  it('gives each guest a stable, share-specific device id', () => {
    expect(guestDev('share1', 'u1')).toBe(guestDev('share1', 'u1'));
    expect(guestDev('share1', 'u1')).not.toBe(guestDev('share2', 'u1'));
    expect(guestDev('share1', 'u1')).toMatch(/^g_[A-Za-z0-9_-]{20}$/);
  });
});
