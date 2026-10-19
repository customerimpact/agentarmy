import fs from 'node:fs';
import { buildSpawnCommand, resolveClaudeExecutable } from '../claude-path.js';
import { removeSettingsFile, writeSettingsFile } from '../hook-settings.js';
import { writeMcpConfigFile } from '../mcp-bridge.js';
import { claudeLaunchArgs } from '../settings.js';
import type { AgentAdapter } from './types.js';
import { readVersion } from './resolve.js';

// Claude Code: the CLI AgentArmy was built around. We pick the session id up front (--session-id),
// resume with --resume, get status from HTTP hooks (--settings) and add the agentarmy MCP tools.
// Resolved once per setting value (and AGENTARMY_CLAUDE_PATH), not at every launch
let cached: { key: string; path: string } | null = null;

function claudePath(override: string): string {
  const key = `${override}|${process.env.AGENTARMY_CLAUDE_PATH ?? ''}`;
  if (cached?.key !== key) {
    const env = override ? { ...process.env, AGENTARMY_CLAUDE_PATH: override } : process.env;
    cached = { key, path: resolveClaudeExecutable({ env }) };
  }
  return cached.path;
}

// Tests swap the executable between runs
export function resetClaudePathCache(): void {
  cached = null;
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  supportsResume: true,
  supportsHooks: true,
  supportsMcp: true,

  async detect(settings) {
    try {
      const override = settings?.claudePath ?? '';
      const env = override ? { ...process.env, AGENTARMY_CLAUDE_PATH: override } : process.env;
      const file = resolveClaudeExecutable({ env });
      const version = await readVersion({ file, prefixArgs: [], display: file });
      return { installed: true, path: file, ...(version ? { version } : {}) };
    } catch (err) {
      return { installed: false, error: (err as Error).message };
    }
  },

  buildLaunch(info, mode, ctx) {
    const { settings } = ctx;
    const executable = claudePath(settings?.claudePath ?? '');
    if (!fs.existsSync(info.cwd)) throw new Error(`Folder no longer exists: ${info.cwd}`);
    const settingsFile = writeSettingsFile(info.id, ctx.port, ctx.token);
    const mcpFile = writeMcpConfigFile(info.id, ctx.port, ctx.token);
    const sessionFlag = mode === 'new' ? '--session-id' : '--resume';
    const command = buildSpawnCommand(executable, [
      sessionFlag,
      info.sessionId,
      '--settings',
      settingsFile,
      // Adds the agentarmy MCP tools; no --strict-mcp-config, so the user's own servers still load
      '--mcp-config',
      mcpFile,
      // Settings tab: --model, --permission-mode and the user's extra flags
      ...(settings ? claudeLaunchArgs(settings) : []),
    ]);
    return { ...command, env: { ...ctx.baseEnv, ...ctx.accountEnv?.() } };
  },

  removeConsoleFiles(consoleId) {
    removeSettingsFile(consoleId);
  },
};
