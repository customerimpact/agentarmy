import { describe, expect, it } from 'vitest';
import {
  isAllowedHost,
  isAllowedOrigin,
  isValidToken,
  readCookie,
  TOKEN_COOKIE,
  tokenCookie,
} from './security.js';

const prod = { port: 4317, token: 'secret', dev: false };
const dev = { ...prod, dev: true };

describe('isAllowedHost', () => {
  it('accepts loopback hosts on our port', () => {
    expect(isAllowedHost('127.0.0.1:4317', prod)).toBe(true);
    expect(isAllowedHost('LOCALHOST:4317', prod)).toBe(true);
  });

  it('rejects rebinding hosts, other ports and missing hosts', () => {
    expect(isAllowedHost('evil.example:4317', prod)).toBe(false);
    expect(isAllowedHost('127.0.0.1', prod)).toBe(false);
    expect(isAllowedHost('127.0.0.1:5173', prod)).toBe(false);
    expect(isAllowedHost(undefined, prod)).toBe(false);
  });

  it('accepts the Vite host in dev, since its proxy forwards the original Host', () => {
    expect(isAllowedHost('localhost:5173', dev)).toBe(true);
  });
});

describe('isAllowedOrigin', () => {
  it('allows requests without an Origin (Claude Code hooks, curl)', () => {
    expect(isAllowedOrigin(undefined, prod)).toBe(true);
  });

  it('allows our own origins', () => {
    expect(isAllowedOrigin('http://127.0.0.1:4317', prod)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4317', prod)).toBe(true);
  });

  it('rejects other websites, the null origin and https lookalikes', () => {
    expect(isAllowedOrigin('https://evil.example', prod)).toBe(false);
    expect(isAllowedOrigin('null', prod)).toBe(false);
    expect(isAllowedOrigin('https://127.0.0.1:4317', prod)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173', prod)).toBe(false);
  });

  it('allows the Vite dev server only in dev', () => {
    expect(isAllowedOrigin('http://localhost:5173', dev)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', dev)).toBe(true);
  });
});

describe('isValidToken', () => {
  it('compares tokens exactly', () => {
    expect(isValidToken('secret', 'secret')).toBe(true);
    expect(isValidToken('secreT', 'secret')).toBe(false);
    expect(isValidToken('sec', 'secret')).toBe(false);
    expect(isValidToken(undefined, 'secret')).toBe(false);
    expect(isValidToken(['secret'], 'secret')).toBe(false);
  });
});

describe('auth cookie', () => {
  it('builds an HttpOnly, SameSite=Strict, site-wide cookie without Secure', () => {
    expect(tokenCookie('a/b')).toBe(`${TOKEN_COOKIE}=a%2Fb; HttpOnly; SameSite=Strict; Path=/`);
  });

  it('reads one cookie out of a Cookie header', () => {
    const header = `theme=dark; ${TOKEN_COOKIE}=a%2Fb; other=1`;
    expect(readCookie(header, TOKEN_COOKIE)).toBe('a/b');
    expect(readCookie('x_agentarmy_token=zzz', TOKEN_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, TOKEN_COOKIE)).toBeUndefined();
  });
});
