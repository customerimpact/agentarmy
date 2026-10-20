import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from './hook-status.js';
import { forwarderCommand, isElectron, POWERSHELL_FORWARDER_SOURCE } from './node-runtime.js';

const HOOK_TIMEOUT_SECONDS = 5;
// Covers node start-up plus two forwarder attempts on a loaded machine
const SESSION_START_TIMEOUT_SECONDS = 20;
// Allows every tool of the 'gridhive' MCP server (see mcp-bridge.ts)
export const AGENTARMY_MCP_PERMISSION = 'mcp__gridhive';

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

// Either node + script (CLI) or a ready command line (desktop app, see node-runtime.ts)
export type Forwarder = { node: string; script: string } | { command: string; args: string[] };

export function buildHookSettings(
  url: string,
  forwarder: Forwarder,
): { hooks: Record<string, unknown[]>; permissions: { allow: string[] } } {
  const relay = 'node' in forwarder ? { command: forwarder.node, args: [forwarder.script] } : forwarder;
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const hook =
      event === 'SessionStart'
        ? {
            type: 'command',
            // exec form (args) bypasses the shell, so no quoting issues with spaces on Windows
            command: relay.command,
            args: [...relay.args, url],
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

// Helper scripts live in a temp folder shared by every GridHive on this computer (CLI, app, tests,
// older versions). The name carries a hash of the content and the file is written via rename, so one
// version never rewrites another's script while an agent is running it.
export function scriptPath(dir: string, base: string, ext: string, source: string): string {
  return path.join(dir, `${base}-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}${ext}`);
}

export function ensureScript(dir: string, base: string, ext: string, source: string): string {
  const file = scriptPath(dir, base, ext, source);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, source);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Another process wrote the same content first
    fs.rmSync(tmp, { force: true });
  }
  return file;
}

function ensureForwarder(dir: string): string {
  return ensureScript(dir, 'forward-hook', '.cjs', FORWARDER_SOURCE);
}

// A file path instead of inline JSON sidesteps Windows command-line quoting entirely
export function writeSettingsFile(consoleId: string, port: number, token: string): string {
  const dir = settingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const script = ensureForwarder(dir);
  const file = path.join(dir, `${consoleId}.settings.json`);
  // Desktop app on Windows: GridHive.exe is not node, so PowerShell relays the payload instead
  const powershell =
    isElectron() && process.platform === 'win32'
      ? ensureScript(dir, 'forward-hook', '.ps1', POWERSHELL_FORWARDER_SOURCE)
      : undefined;
  const settings = buildHookSettings(hookUrl(port, consoleId, token), forwarderCommand({ node: script, powershell }));
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return file;
}

export function removeSettingsFile(consoleId: string): void {
  fs.rmSync(path.join(settingsDir(), `${consoleId}.settings.json`), { force: true });
  fs.rmSync(path.join(settingsDir(), `${consoleId}.mcp.json`), { force: true });
}
