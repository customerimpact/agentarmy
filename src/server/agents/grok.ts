import { providerKey } from '../settings.js';
import { spawnFor } from './resolve.js';
import { assertCwd, detectExecutable, modelArgs, pathOverride, requireExecutable } from './common.js';
import type { AgentAdapter } from './types.js';

// xAI Grok Build (`grok`), xAI's official coding-agent CLI/TUI (early beta since 2026-05; source
// github.com/xai-org/grok-build, Apache-2.0). Not installed on the dev machine, so nothing here was run;
// flags come from docs.x.ai/build (headless-scripting, settings/reference, mcp-servers, hooks), 2026-10:
// - Auth: browser sign-in on first run (SuperGrok / X Premium+ subscription), or XAI_API_KEY
//   ("API key when not using browser/session login"). AgentArmy only sets XAI_API_KEY when the user
//   saved a key in Settings (providerKeys.grok); otherwise the CLI's own login (or an XAI_API_KEY the
//   user already exports) is used.
// - `-m, --model <MODEL>` picks the model; `-c, --continue` continues the most recent session in the
//   current directory (used for restart, like OpenCode). `-r <id>` / `-s <id>` exist but we never
//   learn the session id from the TUI.
// - MCP servers and hooks are only read from config files (~/.grok/config.toml [mcp_servers.*],
//   .grok/config.toml, ~/.grok/hooks/*.json, plus Claude/Cursor compat files). There is no per-run flag
//   or env var to add one, and AgentArmy never writes the user's or the project's config, so Grok
//   consoles get no agentarmy MCP tools and status comes from terminal output heuristics.
//   (GROK_HOME would relocate config but also the login, sessions and skills.)
// - The community `grok-dev` / @vibe-kit/grok-cli (superagent-ai) also installs a `grok` binary; it
//   takes GROK_API_KEY and different flags. We also set GROK_API_KEY so a fresh start works there too,
//   but only Grok Build is supported.
export const GROK_KEY_ENV = 'XAI_API_KEY';
export const GROK_COMMUNITY_KEY_ENV = 'GROK_API_KEY';

export function grokArgs(info: { launchModel?: string }, mode: 'new' | 'resume'): string[] {
  return [...(mode === 'resume' ? ['--continue'] : []), ...modelArgs(info)];
}

// The saved key (if any) goes into the env of this console only
export function grokEnv(baseEnv: Record<string, string>, key: string): Record<string, string> {
  const env = { ...baseEnv };
  if (key) {
    env[GROK_KEY_ENV] = key;
    env[GROK_COMMUNITY_KEY_ENV] = key;
  }
  return env;
}

export const grokAdapter: AgentAdapter = {
  id: 'grok',
  label: 'Grok Build',
  supportsResume: true,
  supportsHooks: false,
  heuristics: 'agent',
  supportsMcp: false,
  notes:
    'xAI Grok Build (flags from docs.x.ai, not tested here): --continue resumes the newest session in the folder. ' +
    'Uses your Grok login, or the xAI API key from Settings (pay per token at xAI). No agentarmy MCP tools.',

  detect(settings) {
    return detectExecutable('grok', pathOverride(settings, 'grok'), 'Grok Build');
  },

  buildLaunch(info, mode, ctx) {
    const exe = requireExecutable('grok', pathOverride(ctx.settings, 'grok'), 'Grok Build');
    assertCwd(info.cwd);
    return { ...spawnFor(exe, grokArgs(info, mode)), env: grokEnv(ctx.baseEnv, providerKey(ctx.settings, 'grok')) };
  },
};
