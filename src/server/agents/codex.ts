import { settingsDir, hookUrl } from '../hook-settings.js';
import { isElectron } from '../node-runtime.js';
import path from 'node:path';
import fs from 'node:fs';
import { spawnFor } from './resolve.js';
import { agentarmyMcpServer, assertCwd, detectExecutable, pathOverride, requireExecutable, writeOnce } from './common.js';
import { osc9Messages } from './output-status.js';
import type { AgentAdapter } from './types.js';

// OpenAI Codex CLI (`codex`). Verified against codex-cli 0.142.5 (`codex --help`, `codex resume --help`,
// and config overrides checked with `codex -c ... mcp list`, which rejects unknown enum values/types):
// - `-c key=value` overrides ~/.codex/config.toml for this process only (value parsed as TOML), so
//   nothing in the user's own config is touched.
// - `-c mcp_servers.agentarmy.command=... -c mcp_servers.agentarmy.args=[...]` adds the agentarmy MCP server
//   (shows up in `codex mcp list`).
// - `-c tui.notifications=true -c tui.notification_method='osc9' -c tui.notification_condition='always'`
//   makes the TUI print OSC 9 notifications ("Approval requested: ...", turn complete), which we read
//   from the PTY for needs_you / resting.
// - `-c notify=[program, args...]`: Codex runs it after each turn with a JSON argument
//   {"type":"agent-turn-complete","thread-id",...,"cwd","last-assistant-message"} (field names found in the
//   codex binary; the "JSON as last argv" calling convention is from the Codex docs, not exercised here).
//   We relay it as a Stop hook carrying the thread id, which `codex resume <SESSION_ID>` takes.
// - `codex resume --last` continues the most recent session when no thread id was seen yet.
// Codex has its own hooks too, but they require persisted hook trust, so we do not use them.

// Relays Codex's notify JSON (last argv) to /hook/<consoleId> as a Stop event. Never prints.
export const CODEX_NOTIFY_SOURCE = `'use strict';
const url = process.argv[2];
let data = {};
try { data = JSON.parse(process.argv[process.argv.length - 1] || '{}'); } catch { data = {}; }
if (!url || data.type !== 'agent-turn-complete') process.exit(0);
const body = JSON.stringify({
  hook_event_name: 'Stop',
  agent: 'codex',
  agent_session_id: typeof data['thread-id'] === 'string' ? data['thread-id'] : undefined,
  last_assistant_message: data['last-assistant-message'],
});
const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
post().catch(() => post()).catch(() => {}).finally(() => process.exit(0));
`;

// TOML literal strings ('...') need no escaping, which also keeps them safe inside cmd.exe "..." quoting
export function tomlString(value: string): string {
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}

export function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([k, v]) => `${k}=${tomlString(v)}`)
    .join(',')}}`;
}

export interface CodexArgsInput {
  mode: 'new' | 'resume';
  threadId?: string;
  mcp?: { command: string; args: string[]; env?: Record<string, string> };
  notify?: string[]; // program + args
}

export function codexArgs(input: CodexArgsInput): string[] {
  const config: string[] = [
    'tui.notifications=true',
    `tui.notification_method=${tomlString('osc9')}`,
    `tui.notification_condition=${tomlString('always')}`,
  ];
  if (input.notify) config.push(`notify=${tomlArray(input.notify)}`);
  if (input.mcp) {
    config.push(`mcp_servers.agentarmy.command=${tomlString(input.mcp.command)}`);
    config.push(`mcp_servers.agentarmy.args=${tomlArray(input.mcp.args)}`);
    if (input.mcp.env) config.push(`mcp_servers.agentarmy.env=${tomlInlineTable(input.mcp.env)}`);
  }
  const resume = input.mode === 'resume' ? ['resume', input.threadId || '--last'] : [];
  return [...resume, ...config.flatMap((c) => ['-c', c])];
}

export function codexStatusFromOutput(chunk: string): { status: 'needs_you' | 'resting'; detail?: string } | null {
  const messages = osc9Messages(chunk);
  const last = messages[messages.length - 1];
  if (last === undefined) return null;
  if (/approv|permission|needs? your|confirm/i.test(last)) return { status: 'needs_you', detail: last.trim().slice(0, 160) || 'Approval requested' };
  return { status: 'resting' };
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  supportsResume: true,
  supportsHooks: true, // notify (turn complete) + OSC 9 notifications; working comes from output
  heuristics: 'agent',
  supportsMcp: true,
  notes: 'Resume uses the Codex thread id from its notify event, else `codex resume --last` in the folder.',

  detect(settings) {
    return detectExecutable('codex', pathOverride(settings, 'codex'), 'Codex CLI');
  },

  buildLaunch(info, mode, ctx) {
    const exe = requireExecutable('codex', pathOverride(ctx.settings, 'codex'), 'Codex CLI');
    assertCwd(info.cwd);
    let notify: string[] | undefined;
    // notify cannot set env vars, so inside the desktop app (Electron is not node) we rely on OSC 9 only
    if (!isElectron()) {
      fs.mkdirSync(settingsDir(), { recursive: true });
      const script = writeOnce(path.join(settingsDir(), 'codex-notify.cjs'), CODEX_NOTIFY_SOURCE);
      notify = [process.execPath, script, hookUrl(ctx.port, info.id, ctx.token)];
    }
    const args = codexArgs({
      mode,
      threadId: info.agentSessionId,
      mcp: agentarmyMcpServer(info.id, ctx.port, ctx.token),
      notify,
    });
    return { ...spawnFor(exe, args), env: { ...ctx.baseEnv } };
  },

  removeConsoleFiles(consoleId) {
    fs.rmSync(path.join(settingsDir(), `${consoleId}.mcp.json`), { force: true });
  },

  statusFromOutput: codexStatusFromOutput,
};
