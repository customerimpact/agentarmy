import fs from 'node:fs';
import path from 'node:path';
import { spawnFor } from './resolve.js';
import { agentarmyMcpServer, assertCwd, consoleFile, detectExecutable, pathOverride, removeConsoleFile, requireExecutable } from './common.js';
import type { AgentAdapter } from './types.js';

// Google Gemini CLI (`gemini`). Not installed on the dev machine, so nothing here was run; flags come
// from the official docs (github.com/google-gemini/gemini-cli docs, 2026-10):
// - `--resume` with no value loads the most recent session for the project (docs: session-management).
//   A session id cannot be chosen up front, so restart continues the newest session in that folder.
// - GEMINI_CLI_SYSTEM_SETTINGS_PATH overrides the system settings file path (docs: configuration). We point
//   it at a per-console copy of the system settings (if any) plus mcpServers.agentarmy, so the user's
//   own files are untouched. Whether Gemini merges mcpServers across settings scopes is not verified.
// - Gemini CLI hooks exist (hooks.* in settings.json) but their entry format is undocumented on that
//   page, so status comes from terminal output heuristics.
export const GEMINI_SETTINGS_SUFFIX = 'gemini-settings.json';

function defaultSystemSettingsPath(platform = process.platform): string {
  if (platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  if (platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  return '/etc/gemini-cli/settings.json';
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function geminiSystemSettings(
  existing: Record<string, unknown>,
  mcp: { command: string; args: string[]; env?: Record<string, string> },
): Record<string, unknown> {
  const servers = existing.mcpServers && typeof existing.mcpServers === 'object' ? (existing.mcpServers as Record<string, unknown>) : {};
  // trust: our own tools never stop the agent with a confirmation
  return { ...existing, mcpServers: { ...servers, agentarmy: { ...mcp, trust: true } } };
}

export const geminiAdapter: AgentAdapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  supportsResume: true,
  supportsHooks: false,
  heuristics: 'agent',
  supportsMcp: true,
  notes: 'Flags from the Gemini CLI docs (not tested here): --resume continues the newest session in the folder.',

  detect(settings) {
    return detectExecutable('gemini', pathOverride(settings, 'gemini'), 'Gemini CLI');
  },

  buildLaunch(info, mode, ctx) {
    const exe = requireExecutable('gemini', pathOverride(ctx.settings, 'gemini'), 'Gemini CLI');
    assertCwd(info.cwd);
    const env = { ...ctx.baseEnv };
    const systemPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || defaultSystemSettingsPath();
    const file = consoleFile(info.id, GEMINI_SETTINGS_SUFFIX);
    const settings = geminiSystemSettings(readJson(systemPath), agentarmyMcpServer(info.id, ctx.port, ctx.token));
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = path.resolve(file);
    return { ...spawnFor(exe, mode === 'resume' ? ['--resume'] : []), env };
  },

  removeConsoleFiles(consoleId) {
    removeConsoleFile(consoleId, GEMINI_SETTINGS_SUFFIX);
  },
};
