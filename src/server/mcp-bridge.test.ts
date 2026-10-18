import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMcpConfig, MCP_SCRIPT_SOURCE } from './mcp-bridge.js';

let app: FastifyInstance;
let child: ChildProcessWithoutNullStreams;
let dir: string;
const calls: Array<{ name: string; body: unknown; token: unknown }> = [];
const stdoutLines: string[] = [];
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();

function rpc(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

beforeAll(async () => {
  app = Fastify();
  app.get('/bridge/:consoleId/tools', async (request) => {
    const { consoleId } = request.params as { consoleId: string };
    return { tools: [{ name: 'echo', description: `for ${consoleId}`, inputSchema: { type: 'object' } }] };
  });
  app.post('/bridge/:consoleId/tools/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    calls.push({ name, body: request.body, token: (request.query as Record<string, unknown>).token });
    if (name === 'boom') return reply.code(500).send({ error: 'exploded' });
    return { content: [{ type: 'text', text: `echo ${JSON.stringify(request.body)}` }] };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-mcp-'));
  const script = path.join(dir, 'agentarmy-mcp.cjs');
  fs.writeFileSync(script, MCP_SCRIPT_SOURCE);
  const config = buildMcpConfig(process.execPath, script, `http://127.0.0.1:${port}`, 'c 1', 't/k');
  const server = config.mcpServers.agentarmy;
  child = spawn(server.command, server.args);
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      stdoutLines.push(line);
      const msg = JSON.parse(line) as Record<string, unknown>;
      waiting.get(msg.id as number)?.(msg);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('agentarmy MCP stdio proxy', () => {
  it('answers initialize with the requested protocol version, tools capability and instructions', async () => {
    const reply = await rpc(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const result = reply.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-03-26');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toMatchObject({ name: 'agentarmy' });
    expect(result.instructions).toMatch(/send_job/);
    // Notifications get no reply
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    expect((await rpc(2, 'ping')).result).toEqual({});
  });

  it('lists tools from the bridge for its console', async () => {
    const reply = await rpc(3, 'tools/list', {});
    expect(reply.result).toEqual({
      tools: [{ name: 'echo', description: 'for c 1', inputSchema: { type: 'object' } }],
    });
  });

  it('forwards tools/call with the arguments and token, and turns failures into isError results', async () => {
    const ok = await rpc(4, 'tools/call', { name: 'echo', arguments: { a: 1 } });
    expect(ok.result).toEqual({ content: [{ type: 'text', text: 'echo {"a":1}' }] });
    expect(calls[0]).toEqual({ name: 'echo', body: { a: 1 }, token: 't/k' });
    const bad = await rpc(5, 'tools/call', { name: 'boom', arguments: {} });
    expect(bad.result).toMatchObject({ isError: true });
    expect(JSON.stringify(bad.result)).toContain('exploded');
    const unknown = await rpc(6, 'resources/list');
    expect(unknown.error).toMatchObject({ code: -32601 });
  });

  it('writes nothing but JSON-RPC lines to stdout', () => {
    expect(stdoutLines.length).toBeGreaterThan(0);
    for (const line of stdoutLines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  });
});
