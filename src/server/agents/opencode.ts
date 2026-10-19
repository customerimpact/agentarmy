import fs from 'node:fs';
import path from 'node:path';
import { spawnFor } from './resolve.js';
import { agentarmyMcpServer, assertCwd, consoleFile, detectExecutable, pathOverride, removeConsoleFile, requireExecutable } from './common.js';
import type { AgentAdapter } from './types.js';

// OpenCode (`opencode`). Not installed on the dev machine, so nothing here was run; flags come from
// the official docs (opencode.ai/docs/cli, /config, /mcp-servers, 2026-10):
// - `--continue` (-c) continues the last session; `--session <id>` exists but we never learn the id.
// - OPENCODE_CONFIG points at an extra config file that is merged between the global and project
//   configs ("Configuration files are merged together, not replaced"), so a per-console file can add
//   the agentarmy MCP server ({"mcp": {"agentarmy": {"type": "local", "command": [...], ...}}}).
//   Skipped when the user already sets OPENCODE_CONFIG themselves.
// - No hook mechanism is used: status comes from terminal output heuristics.
export const OPENCODE_CONFIG_SUFFIX = 'opencode.json';

export function opencodeConfig(mcp: { command: string; args: string[]; env?: Record<string, string> }): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      agentarmy: {
        type: 'local',
        command: [mcp.command, ...mcp.args],
        enabled: true,
        ...(mcp.env ? { environment: mcp.env } : {}),
      },
    },
  };
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  supportsResume: true,
  supportsHooks: false,
  heuristics: 'agent',
  supportsMcp: true,
  notes: 'Flags from the OpenCode docs (not tested here): --continue resumes the last session.',

  detect(settings) {
    return detectExecutable('opencode', pathOverride(settings, 'opencode'), 'OpenCode');
  },

  buildLaunch(info, mode, ctx) {
    const exe = requireExecutable('opencode', pathOverride(ctx.settings, 'opencode'), 'OpenCode');
    assertCwd(info.cwd);
    const env = { ...ctx.baseEnv };
    if (!env.OPENCODE_CONFIG) {
      const file = consoleFile(info.id, OPENCODE_CONFIG_SUFFIX);
      fs.writeFileSync(file, JSON.stringify(opencodeConfig(agentarmyMcpServer(info.id, ctx.port, ctx.token)), null, 2), { mode: 0o600 });
      env.OPENCODE_CONFIG = path.resolve(file);
    }
    return { ...spawnFor(exe, mode === 'resume' ? ['--continue'] : []), env };
  },

  removeConsoleFiles(consoleId) {
    removeConsoleFile(consoleId, OPENCODE_CONFIG_SUFFIX);
  },
};
