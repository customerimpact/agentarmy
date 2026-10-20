import os from 'node:os';

// The phone server listens on every interface, so it cannot rely on 127.0.0.1 alone.
// Host must be one of this computer's own IP addresses with the phone port (no hostnames, so
// DNS rebinding from a web page cannot reach it), and a browser Origin must match that Host.

export const PHONE_COOKIE = 'gridhive_phone';

// IPv4 addresses of this computer, local network first (the QR code uses the first one)
export function localAddresses(interfaces = os.networkInterfaces()): string[] {
  const all: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' && (info.family as unknown) !== 4) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local: no DHCP answer
      all.push(info.address);
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const rank = (ip: string) => (isPrivate(ip) ? 0 : ip.startsWith('127.') ? 2 : 1);
  return [...new Set(all)].sort((a, b) => rank(a) - rank(b));
}

export function isAllowedPhoneHost(host: string | undefined, port: number, addresses: string[]): boolean {
  if (!host) return false;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(host);
  return !!match && Number(match[2]) === port && addresses.includes(match[1]);
}

export function isAllowedPhoneOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  return !!host && origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

// A year; the phone stays paired until it is removed on the computer
export function phoneCookie(token: string): string {
  return `${PHONE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}
