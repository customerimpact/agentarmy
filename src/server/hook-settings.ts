import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from './hook-status.js';

const HOOK_TIMEOUT_SECONDS = 5;

// SessionStart only runs command hooks (not http), so a tiny Node script relays its payload.
// Never fails, never prints: Claude Code would show stdout or errors in the session.
const FORWARDER_SOURCE = `const url = process.argv[2];
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) })
    .catch(() => {})
    .finally(() => process.exit(0));
});
`;

export function hookUrl(port: number, consoleId: string, token: string): string {
  return `http://127.0.0.1:${port}/hook/${encodeURIComponent(consoleId)}?token=${encodeURIComponent(token)}`;
}

export function buildHookSettings(
  url: string,
  forwarder: { node: string; script: string },
): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const hook =
      event === 'SessionStart'
        ? {
            type: 'command',
            // exec form (args) bypasses the shell, so no quoting issues with spaces on Windows
            command: forwarder.node,
            args: [forwarder.script, url],
            timeout: HOOK_TIMEOUT_SECONDS,
          }
        : { type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS };
    hooks[event] = [{ matcher: '', hooks: [hook] }];
  }
  return { hooks };
}

export function settingsDir(): string {
  return path.join(os.tmpdir(), 'agentarmy');
}

function ensureForwarder(dir: string): string {
  const script = path.join(dir, 'forward-hook.cjs');
  let current: string | null = null;
  try {
    current = fs.readFileSync(script, 'utf8');
  } catch {
    // not written yet
  }
  if (current !== FORWARDER_SOURCE) fs.writeFileSync(script, FORWARDER_SOURCE);
  return script;
}

// A file path instead of inline JSON sidesteps Windows command-line quoting entirely
export function writeSettingsFile(consoleId: string, port: number, token: string): string {
  const dir = settingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const script = ensureForwarder(dir);
  const file = path.join(dir, `${consoleId}.settings.json`);
  const settings = buildHookSettings(hookUrl(port, consoleId, token), {
    node: process.execPath,
    script,
  });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return file;
}

export function removeSettingsFile(consoleId: string): void {
  fs.rmSync(path.join(settingsDir(), `${consoleId}.settings.json`), { force: true });
}
