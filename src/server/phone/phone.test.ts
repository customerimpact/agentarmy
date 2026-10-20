import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { PhonePairInfo, PhoneStatus, ServerMessage } from '../../shared/protocol.js';
import { ConsoleManager } from '../consoles.js';
import { buildServer } from '../server.js';
import { isAllowedPhoneHost, isAllowedPhoneOrigin, localAddresses, PHONE_COOKIE } from './phone-security.js';
import { isAllowedPhoneCall } from './phone-server.js';
import { PAIR_CODE_TTL_MS, PhoneStore } from './phone-store.js';

describe('phone security', () => {
  const ips = ['192.168.1.20', '127.0.0.1'];
  it('only accepts this computer\'s IP addresses on the phone port', () => {
    expect(isAllowedPhoneHost('192.168.1.20:4318', 4318, ips)).toBe(true);
    expect(isAllowedPhoneHost('192.168.1.20:4317', 4318, ips)).toBe(false);
    expect(isAllowedPhoneHost('192.168.1.99:4318', 4318, ips)).toBe(false);
    expect(isAllowedPhoneHost('evil.example:4318', 4318, ips)).toBe(false); // DNS rebinding
    expect(isAllowedPhoneHost(undefined, 4318, ips)).toBe(false);
  });

  it('wants a browser Origin to match the Host', () => {
    expect(isAllowedPhoneOrigin(undefined, '192.168.1.20:4318')).toBe(true);
    expect(isAllowedPhoneOrigin('http://192.168.1.20:4318', '192.168.1.20:4318')).toBe(true);
    expect(isAllowedPhoneOrigin('https://evil.example', '192.168.1.20:4318')).toBe(false);
  });

  it('lists local network addresses first and skips link-local ones', () => {
    const interfaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1' }],
      vpn: [{ family: 'IPv4', address: '100.64.1.2' }],
      wifi: [
        { family: 'IPv4', address: '192.168.1.20' },
        { family: 'IPv6', address: 'fe80::1' },
      ],
      dead: [{ family: 'IPv4', address: '169.254.3.4' }],
    } as unknown as ReturnType<typeof os.networkInterfaces>;
    expect(localAddresses(interfaces)).toEqual(['192.168.1.20', '100.64.1.2', '127.0.0.1']);
  });

  it('allows only the phone API, nothing that changes settings, files or accounts', () => {
    expect(isAllowedPhoneCall('GET', '/api/state')).toBe(true);
    expect(isAllowedPhoneCall('POST', '/api/templates/dev-hq/launch')).toBe(true);
    expect(isAllowedPhoneCall('POST', '/api/consoles/c1/send')).toBe(true);
    expect(isAllowedPhoneCall('POST', '/api/actions/a1/answer')).toBe(true);
    expect(isAllowedPhoneCall('POST', '/api/device-handoff')).toBe(true);
    expect(isAllowedPhoneCall('PATCH', '/api/settings')).toBe(false);
    expect(isAllowedPhoneCall('PUT', '/api/phone')).toBe(false);
    expect(isAllowedPhoneCall('POST', '/api/phone/pair')).toBe(false);
    expect(isAllowedPhoneCall('DELETE', '/api/consoles/c1')).toBe(false);
    expect(isAllowedPhoneCall('GET', '/api/state/../settings')).toBe(false);
  });
});

describe('PhoneStore', () => {
  it('trades a code once for a device token, stored only as a hash', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gridhive-phone-')), 'phone.json');
    let now = 1_000;
    const store = new PhoneStore(file, () => now);
    const { code } = store.newPairCode();
    const paired = store.pair(code, '  Tim\'s iPhone\n');
    if (typeof paired === 'string') throw new Error(paired);
    expect(paired.device.name).toBe('Tim\'s iPhone');
    expect(store.pair(code, 'again')).toBe('invalid');
    expect(store.deviceForToken(paired.token)?.id).toBe(paired.device.id);
    expect(store.deviceForToken('nope')).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).not.toContain(paired.token);

    const reloaded = new PhoneStore(file, () => now);
    expect(reloaded.deviceForToken(paired.token)?.name).toBe('Tim\'s iPhone');
    expect(reloaded.removeDevice(paired.device.id)).toBe(true);
    expect(reloaded.deviceForToken(paired.token)).toBeNull();

    const late = reloaded.newPairCode();
    now += PAIR_CODE_TTL_MS + 1;
    expect(reloaded.pair(late.code, 'x')).toBe('invalid');
  });

  it('only the newest code works, and guessing is rate limited', () => {
    const store = new PhoneStore(null);
    const first = store.newPairCode();
    const second = store.newPairCode();
    expect(store.pair(first.code, 'a')).toBe('invalid');
    for (let i = 0; i < 19; i++) store.pair(`guess-${i}`, 'x');
    expect(store.pair('guess', 'x')).toBe('rate-limited');
    expect(store.pair(second.code, 'a')).toBe('rate-limited');
  });
});

describe('phone server', () => {
  const TOKEN = 'board-token';
  const HOST = { host: '127.0.0.1:4317', 'x-agentarmy-token': TOKEN };
  let app: FastifyInstance;
  let manager: ConsoleManager;
  let status: PhoneStatus;
  let base = '';
  let cookie = '';

  beforeAll(async () => {
    manager = new ConsoleManager({ port: 4317, token: TOKEN, onChange: () => {} });
    app = await buildServer({ port: 4317, token: TOKEN, dev: false, manager, phonePort: 0, phoneHost: '127.0.0.1' });
    await app.ready();
    status = (await app.inject({ method: 'PUT', url: '/api/phone', headers: HOST, payload: { enabled: true } })).json();
    base = `http://127.0.0.1:${status.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts only when switched on', () => {
    expect(status.enabled).toBe(true);
    expect(status.listening).toBe(true);
    expect(status.port).toBeGreaterThan(0);
  });

  it('refuses unpaired phones and foreign hosts', async () => {
    expect((await fetch(`${base}/m/api/state`)).status).toBe(401);
    // fetch cannot set Host, so ask with node:http like a rebinding page would arrive
    const foreign = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: status.port, path: '/m/api/me', headers: { host: `evil.example:${status.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(foreign).toBe(403);
  });

  it('pairs with the QR code, then forwards only allow-listed calls', async () => {
    const info: PhonePairInfo = (await app.inject({ method: 'POST', url: '/api/phone/pair', headers: HOST })).json();
    expect(info.qrSvg).toContain('<svg');
    const code = /#pair=([A-Za-z0-9_-]+)$/.exec(info.url)![1];

    const pair = await fetch(`${base}/m/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Test phone' }),
    });
    expect(pair.status).toBe(200);
    cookie = pair.headers.get('set-cookie')!.split(';')[0];
    expect(cookie.startsWith(`${PHONE_COOKIE}=`)).toBe(true);

    const state = await fetch(`${base}/m/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    expect(await state.json()).toHaveProperty('consoles');
    const settings = await fetch(`${base}/m/api/settings`, { headers: { cookie } });
    expect(settings.status).toBe(404);
    const phone = await fetch(`${base}/m/api/phone`, { headers: { cookie } });
    expect(phone.status).toBe(404);

    const devices: PhoneStatus = (await app.inject({ url: '/api/phone', headers: HOST })).json();
    expect(devices.devices.map((d) => d.name)).toEqual(['Test phone']);
  });

  it('sends "continue on phone" to the phone socket', async () => {
    const consoleId = manager.create({ cwd: os.tmpdir(), agent: 'custom', command: 'node -e "setInterval(()=>{},1000)"' }).id;
    const socket = new WebSocket(`ws://127.0.0.1:${status.port}/m/ws`, { headers: { cookie } });
    const messages: ServerMessage[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const res = await app.inject({ method: 'POST', url: '/api/device-handoff', headers: HOST, payload: { consoleId, to: 'phone' } });
    expect(res.statusCode).toBe(200);
    await expect.poll(() => messages.find((m) => m.type === 'device-handoff')).toEqual({ type: 'device-handoff', consoleId, to: 'phone' });
    const online: PhoneStatus = (await app.inject({ url: '/api/phone', headers: HOST })).json();
    expect(online.devices[0].online).toBe(true);
    socket.close();
    manager.remove(consoleId);
  });

  it('removing a phone locks it out, and switching off stops the listener', async () => {
    const before: PhoneStatus = (await app.inject({ url: '/api/phone', headers: HOST })).json();
    await app.inject({ method: 'DELETE', url: `/api/phone/devices/${before.devices[0].id}`, headers: HOST });
    expect((await fetch(`${base}/m/api/state`, { headers: { cookie } })).status).toBe(401);
    const off: PhoneStatus = (await app.inject({ method: 'PUT', url: '/api/phone', headers: HOST, payload: { enabled: false } })).json();
    expect(off.listening).toBe(false);
    await expect(fetch(`${base}/m/api/me`)).rejects.toThrow();
  });
});
