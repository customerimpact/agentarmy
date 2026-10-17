import fs from 'node:fs';
import path from 'node:path';
import { generateToken } from './security.js';
import { agentArmyHome } from './store.js';

export function tokenFilePath(): string {
  return path.join(agentArmyHome(), 'token');
}

// Stable across restarts so the auth cookie (and an installed PWA window) keeps working
export function loadOrCreateToken(options: { rotate?: boolean } = {}): string {
  const file = tokenFilePath();
  if (!options.rotate) {
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    } catch {
      // first run
    }
  }
  const token = generateToken();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  // mode only applies on create; tighten an existing file too (a no-op on Windows)
  fs.chmodSync(file, 0o600);
  return token;
}
