import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from './hook-status.js';

const HOOK_TIMEOUT_SECONDS = 5;
// Covers node start-up plus two forwarder attempts on a loaded machine
const SESSION_START_TIMEOUT_SECONDS = 20;
// Allows every tool of the 'agentarmy' MCP server (see mcp-bridge.ts)
export const AGENTARMY_MCP_PERMISSION = 'mcp__agentarmy';

// SessionStart only runs command hooks (not http), so a tiny Node script relays its payload.
// Never fails, never prints: Claude Code would show stdout or errors in the session.
const FORWARDER_SOURCE = `const url = process.argv[2];
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  // A busy machine can delay our server; retry once so the console doesn't stay 'starting'
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
  post()
    .catch(() => post())
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
): { hooks: Record<string, unknown[]>; permissions: { allow: string[] } } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const hook =
      event === 'SessionStart'
        ? {
            type: 'command',
            // exec form (args) bypasses the shell, so no quoting issues with spaces on Windows
            command: forwarder.node,
            args: [forwarder.script, url],
            timeout: SESSION_START_TIMEOUT_SECONDS,
          }
        : { type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS };
    hooks[event] = [{ matcher: '', hooks: [hook] }];
  }
  // Our own MCP tools (list_agents, send_job, ...) should never stop an agent with a permission prompt
  return { hooks, permissions: { allow: [AGENTARMY_MCP_PERMISSION] } };
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
  fs.rmSync(path.join(settingsDir(), `${consoleId}.mcp.json`), { force: true });
}
