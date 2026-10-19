import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAccountId, isProviderId, PROVIDER_IDS, providerOfAgent } from '../../shared/providers.js';
import {
  accountEnvFor,
  agentForProvider,
  defaultProviderDir,
  detectLogin,
  installCommandFor,
  installRunFor,
  loginFiles,
  PROVIDERS,
} from './providers.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-providers-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content = '{"x":1}'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('provider registry', () => {
  it('has one complete entry per provider id', () => {
    expect(PROVIDER_IDS).toEqual(['claude', 'codex', 'gemini', 'opencode', 'grok']);
    for (const id of PROVIDER_IDS) {
      const def = PROVIDERS[id];
      expect(def.id).toBe(id);
      expect(def.label && def.vendor && def.billing && def.loginCommand).toBeTruthy();
      expect(def.signupUrl).toMatch(/^https:\/\//);
      expect(def.website).toMatch(/^https:\/\//);
      expect(installCommandFor(def, 'linux')).toBeTruthy();
      expect(installCommandFor(def, 'win32')).toBeTruthy();
    }
  });

  it('uses the verified npm packages and env vars', () => {
    expect(installCommandFor(PROVIDERS.claude, 'win32')).toBe('npm i -g @anthropic-ai/claude-code');
    expect(installCommandFor(PROVIDERS.codex, 'darwin')).toBe('npm i -g @openai/codex');
    expect(installCommandFor(PROVIDERS.gemini, 'linux')).toBe('npm i -g @google/gemini-cli');
    expect(installCommandFor(PROVIDERS.opencode, 'win32')).toBe('npm i -g opencode-ai');
    expect(PROVIDERS.claude.accountEnvVar).toBe('CLAUDE_CONFIG_DIR');
    expect(PROVIDERS.codex.accountEnvVar).toBe('CODEX_HOME');
    expect(PROVIDERS.gemini.accountEnvVar).toBe('GEMINI_CLI_HOME');
    expect(PROVIDERS.opencode.accountEnvVar).toBe('XDG_DATA_HOME');
    expect(PROVIDERS.grok.accountEnvVar).toBeNull(); // not verified: one account
    expect(PROVIDERS.codex.loginArgs).toEqual(['login']);
    expect(PROVIDERS.opencode.loginArgs).toEqual(['auth', 'login']);
    expect(PROVIDERS.gemini.loginArgs).toBeNull(); // the CLI itself asks how to sign in
  });

  it('runs PowerShell install lines through powershell on Windows', () => {
    expect(installCommandFor(PROVIDERS.grok, 'win32')).toBe('irm https://x.ai/cli/install.ps1 | iex');
    expect(installRunFor(PROVIDERS.grok, 'win32')).toMatch(/^powershell -NoProfile .*-Command "irm https:\/\/x\.ai\/cli\/install\.ps1 \| iex"$/);
    expect(installRunFor(PROVIDERS.grok, 'linux')).toBe('curl -fsSL https://x.ai/cli/install.sh | bash');
    expect(installRunFor(PROVIDERS.codex, 'win32')).toBe('npm i -g @openai/codex');
  });

  it('maps providers and agents', () => {
    expect(providerOfAgent(undefined)).toBe('claude');
    expect(providerOfAgent('codex')).toBe('codex');
    expect(providerOfAgent('custom')).toBeNull();
    expect(isProviderId('grok')).toBe(true);
    expect(isProviderId('custom')).toBe(false);
    expect(agentForProvider('opencode')).toBe('opencode');
    expect(defaultAccountId('claude')).toBe('default');
    expect(defaultAccountId('codex')).toBe('codex-default');
  });
});

describe('config dirs and env', () => {
  it('follows the CLIs own env vars for the default account', () => {
    const home = path.join(tmp, 'home');
    expect(defaultProviderDir('codex', {}, home)).toBe(path.join(home, '.codex'));
    expect(defaultProviderDir('codex', { CODEX_HOME: path.join(tmp, 'cx') }, home)).toBe(path.join(tmp, 'cx'));
    expect(defaultProviderDir('gemini', {}, home)).toBe(home);
    expect(defaultProviderDir('opencode', {}, home)).toBe(path.join(home, '.local', 'share'));
    expect(defaultProviderDir('claude', { CLAUDE_CONFIG_DIR: path.join(tmp, 'cl') }, home)).toBe(path.join(tmp, 'cl'));
  });

  it('injects the provider env var for an extra account', () => {
    const dir = path.join(tmp, 'acc');
    expect(accountEnvFor('claude', dir)).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect(accountEnvFor('codex', dir)).toEqual({ CODEX_HOME: dir });
    expect(accountEnvFor('gemini', dir)).toEqual({ GEMINI_CLI_HOME: dir });
    expect(accountEnvFor('opencode', dir)).toEqual({ XDG_DATA_HOME: dir });
    expect(accountEnvFor('grok', dir)).toEqual({});
  });
});

describe('logged-in detection (file presence)', () => {
  it('codex: auth.json in CODEX_HOME', () => {
    expect(detectLogin('codex', tmp, { env: {} }).loggedIn).toBe(false);
    write(loginFiles('codex', tmp)[0]);
    expect(loginFiles('codex', tmp)[0]).toBe(path.join(tmp, 'auth.json'));
    expect(detectLogin('codex', tmp, { env: {} })).toEqual({ loggedIn: true, method: 'login file' });
  });

  it('gemini: .gemini/oauth_creds.json, or an API key auth type in settings.json', () => {
    expect(detectLogin('gemini', tmp, { env: {} }).loggedIn).toBe(false);
    write(path.join(tmp, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }));
    expect(detectLogin('gemini', tmp, { env: {} }).loggedIn).toBe(false); // chose Google login, not finished
    write(path.join(tmp, '.gemini', 'oauth_creds.json'));
    expect(detectLogin('gemini', tmp, { env: {} }).method).toBe('login file');
    const other = path.join(tmp, 'other');
    write(path.join(other, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
    expect(detectLogin('gemini', other, { env: {} })).toEqual({ loggedIn: true, method: 'settings (gemini-api-key)' });
  });

  it('opencode: a non-empty opencode/auth.json under the data dir', () => {
    const file = loginFiles('opencode', tmp)[0];
    expect(file).toBe(path.join(tmp, 'opencode', 'auth.json'));
    write(file, '{}');
    expect(detectLogin('opencode', tmp, { env: {} }).loggedIn).toBe(false);
    write(file, '{"anthropic":{}}');
    expect(detectLogin('opencode', tmp, { env: {} }).loggedIn).toBe(true);
  });

  it('API keys in the environment or saved in Settings count, without reading their values', () => {
    expect(detectLogin('codex', tmp, { env: { OPENAI_API_KEY: 'x' } })).toEqual({ loggedIn: true, method: 'OPENAI_API_KEY in environment' });
    expect(detectLogin('grok', tmp, { env: { XAI_API_KEY: 'x' } }).loggedIn).toBe(true);
    expect(detectLogin('grok', tmp, { env: {}, savedKey: true })).toEqual({ loggedIn: true, method: 'API key in Settings' });
    expect(detectLogin('grok', tmp, { env: {} }).loggedIn).toBe(false);
    // Claude Code never gets API keys from the environment (it would bill API credits)
    expect(detectLogin('claude', tmp, { env: { ANTHROPIC_API_KEY: 'x' } }).loggedIn).toBe(false);
  });
});
