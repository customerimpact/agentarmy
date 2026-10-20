import { describe, expect, it } from 'vitest';
import { MAX_DEVICES, MAX_FRAMES_PER_SECOND, RelayHub, type Peer } from '../src/hub';
import { base64url, importPublicKey, signRelayToken, verifyRelayToken, type RelayClaims } from '../src/token';

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey: await importPublicKey(raw) };
}

const claims = (over: Partial<RelayClaims> = {}): RelayClaims => ({ sub: 'u1', dev: 'pc', kind: 'computer', exp: 2_000, ...over });

describe('relay tokens', () => {
  it('accepts a token signed with the private key until it expires', async () => {
    const { privateKey, publicKey } = await keys();
    const token = await signRelayToken(claims(), privateKey);
    expect(await verifyRelayToken(token, publicKey, 1_000)).toEqual(claims());
    expect(await verifyRelayToken(token, publicKey, 2_001)).toBeNull();
  });

  it('rejects tampered tokens, other keys and odd claims', async () => {
    const { privateKey, publicKey } = await keys();
    const other = await keys();
    const token = await signRelayToken(claims(), privateKey);
    const [payload, signature] = token.split('.');
    const forged = base64url(new TextEncoder().encode(JSON.stringify(claims({ sub: 'victim' }))));
    expect(await verifyRelayToken(`${forged}.${signature}`, publicKey, 1_000)).toBeNull();
    expect(await verifyRelayToken(token, other.publicKey, 1_000)).toBeNull();
    expect(await verifyRelayToken(`${payload}`, publicKey, 1_000)).toBeNull();
    expect(await verifyRelayToken('garbage', publicKey, 1_000)).toBeNull();
    const badKind = await signRelayToken(claims({ kind: 'admin' as never }), privateKey);
    expect(await verifyRelayToken(badKind, publicKey, 1_000)).toBeNull();
    const badId = await signRelayToken(claims({ dev: '../x' }), privateKey);
    expect(await verifyRelayToken(badId, publicKey, 1_000)).toBeNull();
  });
});

function peer(id: string, kind: 'computer' | 'phone' = 'phone') {
  const sent: string[] = [];
  const closed: number[] = [];
  const p: Peer = { id, kind, send: (t) => sent.push(t), close: (code) => closed.push(code) };
  return { p, sent, closed };
}

describe('RelayHub', () => {
  it('forwards ciphertext to the named device with the sender filled in', () => {
    const hub = new RelayHub(() => 0);
    const pc = peer('pc', 'computer');
    const phone = peer('phone');
    hub.join(pc.p);
    hub.join(phone.p);
    expect(hub.forward('phone', JSON.stringify({ to: 'pc', nonce: 'n1', box: 'cipher', from: 'spoofed' }))).toBeNull();
    expect(pc.sent.at(-1)).toBe(JSON.stringify({ from: 'phone', nonce: 'n1', box: 'cipher' }));
    expect(hub.forward('phone', JSON.stringify({ to: 'nobody', nonce: 'n', box: 'b' }))).toBe('Device offline');
    expect(hub.forward('phone', '{"to":"pc"}')).toBe('Frames need to, nonce and box');
    expect(hub.forward('phone', 'x'.repeat(1024 * 1024 + 1))).toBe('Frame too large');
  });

  it('announces who is online, replaces a reconnecting device, and revokes', () => {
    const hub = new RelayHub();
    const pc = peer('pc', 'computer');
    hub.join(pc.p);
    const phone1 = peer('phone');
    hub.join(phone1.p);
    expect(JSON.parse(pc.sent.at(-1)!)).toEqual({ type: 'presence', devices: [{ id: 'pc', kind: 'computer' }, { id: 'phone', kind: 'phone' }] });
    const phone2 = peer('phone');
    hub.join(phone2.p);
    expect(phone1.closed).toEqual([4000]);
    hub.leave('phone', phone1.p); // the replaced socket closing must not remove the new one
    expect(hub.devices()).toHaveLength(2);
    hub.revoke('phone');
    expect(phone2.closed).toEqual([4401]);
    expect(hub.devices()).toEqual([{ id: 'pc', kind: 'computer' }]);
  });

  it('limits devices per account and frames per second', () => {
    let now = 0;
    const hub = new RelayHub(() => now);
    for (let i = 0; i < MAX_DEVICES; i++) hub.join(peer(`d${i}`).p);
    const extra = peer('extra');
    expect(hub.join(extra.p)).toBe(false);
    expect(extra.closed).toEqual([4429]);
    const frame = JSON.stringify({ to: 'd1', nonce: 'n', box: 'b' });
    for (let i = 0; i < MAX_FRAMES_PER_SECOND; i++) expect(hub.forward('d0', frame)).toBeNull();
    expect(hub.forward('d0', frame)).toBe('Rate limited');
    now = 1_000;
    expect(hub.forward('d0', frame)).toBeNull();
  });
});
