import fs from 'node:fs';
import path from 'node:path';
import { ensureScript, settingsDir } from './hook-settings.js';
import { isElectron, nodeScriptCommand } from './node-runtime.js';

// The gridhive MCP server that runs inside every console. Claude Code starts it over stdio
// (newline-delimited JSON-RPC 2.0). It is a thin, dependency-free proxy: tools are listed from
// and called on the GridHive server's /bridge routes, so all logic stays in the server.
// stdout carries JSON-RPC only; anything else would corrupt the protocol.
export const MCP_SCRIPT_SOURCE = `'use strict';
const [baseUrl, consoleId, token] = process.argv.slice(2);
const DEFAULT_PROTOCOL = '2025-06-18';
const INSTRUCTIONS = [
  'You are one of several Claude Code agents on an GridHive board: each agent runs in its own terminal,',
  'and the user watches all of them on a shared canvas.',
  'Use list_agents to see the other agents (nearest first) and send_job to hand one of them a task;',
  'the board draws a line from you to that agent. Results come back to you as a typed message.',
  'When a message starts with "[GridHive job ...]", do the job, then call report_job with its job_id and a short result.',
  'Use request_user_action when you need the human (an approval, a credential, a decision) so it shows in their inbox.',
].join(' ');

function endpoint(suffix) {
  return baseUrl.replace(/\\/+$/, '') + '/bridge/' + encodeURIComponent(consoleId) + suffix +
    '?token=' + encodeURIComponent(token);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function request(method, suffix, body) {
  const res = await fetch(endpoint(suffix), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const reason = data && (data.error || (data.content && data.content[0] && data.content[0].text));
    throw new Error(reason || ('GridHive answered HTTP ' + res.status));
  }
  return data;
}

function errorText(err) {
  const msg = err && err.message ? err.message : String(err);
  return 'GridHive bridge error: ' + msg;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return; // notifications (notifications/initialized, cancelled...) need no answer
  switch (method) {
    case 'initialize': {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      return reply(id, {
        protocolVersion: requested || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'gridhive', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list': {
      try {
        const data = await request('GET', '/tools');
        return reply(id, { tools: (data && data.tools) || [] });
      } catch {
        return reply(id, { tools: [] });
      }
    }
    case 'tools/call': {
      const name = params && params.name;
      if (typeof name !== 'string') return fail(id, -32602, 'Missing tool name');
      try {
        const data = await request('POST', '/tools/' + encodeURIComponent(name), (params && params.arguments) || {});
        return reply(id, {
          content: (data && data.content) || [],
          ...(data && data.isError ? { isError: true } : {}),
        });
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: errorText(err) }], isError: true });
      }
    }
    default:
      return fail(id, -32601, 'Method not found: ' + method);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg).catch((err) => {
      if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, errorText(err));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// Written on first use; Codex, Gemini and OpenCode configs point at it directly
export function mcpScriptPath(): string {
  return ensureMcpScript();
}

export function mcpConfigPath(consoleId: string): string {
  return path.join(settingsDir(), `${consoleId}.mcp.json`);
}

function ensureMcpScript(): string {
  return ensureScript(settingsDir(), 'gridhive-mcp', '.cjs', MCP_SCRIPT_SOURCE);
}

export function buildMcpConfig(
  node: string,
  script: string,
  baseUrl: string,
  consoleId: string,
  token: string,
  electron = isElectron(),
): { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } {
  return { mcpServers: { gridhive: nodeScriptCommand(script, [baseUrl, consoleId, token], node, electron) } };
}

// One config per console: the console id and token travel as argv to the proxy
export function writeMcpConfigFile(consoleId: string, port: number, token: string): string {
  fs.mkdirSync(settingsDir(), { recursive: true });
  const script = ensureMcpScript();
  const file = mcpConfigPath(consoleId);
  const config = buildMcpConfig(process.execPath, script, `http://127.0.0.1:${port}`, consoleId, token);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}
