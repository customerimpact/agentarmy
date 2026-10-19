import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../../shared/protocol.js';
import type { CliAgentKind } from '../../shared/agents.js';
import { settingsDir } from '../hook-settings.js';
import { buildMcpConfig, mcpScriptPath, writeMcpConfigFile } from '../mcp-bridge.js';
import { readVersion, resolveAgentExecutable, type ResolvedExecutable } from './resolve.js';
import type { DetectResult } from './types.js';

// The agentarmy MCP proxy (stdio) as { command, args, env? }, for CLIs that take MCP servers in their
// own config format. Writing the Claude config file also makes sure the proxy script is on disk.
export function agentarmyMcpServer(consoleId: string, port: number, token: string): { command: string; args: string[]; env?: Record<string, string> } {
  writeMcpConfigFile(consoleId, port, token);
  return buildMcpConfig(process.execPath, mcpScriptPath(), `http://127.0.0.1:${port}`, consoleId, token).mcpServers.agentarmy;
}

export function consoleFile(consoleId: string, suffix: string): string {
  fs.mkdirSync(settingsDir(), { recursive: true });
  return path.join(settingsDir(), `${consoleId}.${suffix}`);
}

export function removeConsoleFile(consoleId: string, suffix: string): void {
  fs.rmSync(path.join(settingsDir(), `${consoleId}.${suffix}`), { force: true });
  fs.rmSync(path.join(settingsDir(), `${consoleId}.mcp.json`), { force: true });
}

export function writeOnce(file: string, source: string): string {
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // not written yet
  }
  if (current !== source) fs.writeFileSync(file, source);
  return file;
}

export function pathOverride(settings: AppSettings | undefined, agent: Exclude<CliAgentKind, 'claude'>): string {
  return settings?.agentPaths?.[agent] ?? '';
}

export function requireExecutable(command: string, override: string, label: string): ResolvedExecutable {
  const exe = resolveAgentExecutable(command, override);
  if (exe) return exe;
  throw new Error(
    override
      ? `${label} path in Settings > Agents points to a missing file: ${override}`
      : `Could not find "${command}" on PATH. Install ${label} or set its path in Settings > Agents.`,
  );
}

export async function detectExecutable(command: string, override: string, label: string): Promise<DetectResult> {
  try {
    const exe = requireExecutable(command, override, label);
    const version = await readVersion(exe);
    return { installed: true, path: exe.display, ...(version ? { version } : {}) };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}

export function assertCwd(cwd: string): void {
  if (!fs.existsSync(cwd)) throw new Error(`Folder no longer exists: ${cwd}`);
}

// The CLI's model flag for a console created with a model (CreateConsoleRequest.model)
export function modelArgs(info: { launchModel?: string }, flag = '-m'): string[] {
  return info.launchModel ? [flag, info.launchModel] : [];
}
