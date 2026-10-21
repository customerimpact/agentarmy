import crypto from 'node:crypto';

export const DEV_UI_PORT = 5173;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

export interface SecurityConfig {
  port: number;
  token: string;
  dev: boolean;
}

function allowedPorts(config: SecurityConfig): number[] {
  return config.dev ? [config.port, DEV_UI_PORT] : [config.port];
}

// DNS rebinding makes evil.example resolve to 127.0.0.1, but the browser still sends its own Host
export function isAllowedHost(host: string | undefined, config: SecurityConfig): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase();
  return allowedPorts(config).some((port) =>
    LOOPBACK_HOSTS.some((h) => normalized === `${h}:${port}`),
  );
}

// Absent Origin means a non-browser client (Claude Code's hook POSTs, curl); those still need the token
export function isAllowedOrigin(origin: string | undefined, config: SecurityConfig): boolean {
  if (origin === undefined) return true;
  const normalized = origin.toLowerCase();
  return allowedPorts(config).some((port) =>
    LOOPBACK_HOSTS.some((h) => normalized === `http://${h}:${port}`),
  );
}

export function isValidToken(candidate: unknown, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export const TOKEN_COOKIE = 'agentarmy_token';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

// No Secure flag: the app is served over plain http://127.0.0.1. SameSite=Strict plus the
// Origin/Host checks keep other sites from riding on the cookie. It outlives the browser session
// (400 days, the browser maximum) so a bookmarked 127.0.0.1:4317 opens; the token file is stable too.
export const TOKEN_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE}`;
}
