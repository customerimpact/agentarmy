import type { AppSettings } from '../../shared/protocol.js';
import { isAgentKind, PATH_OVERRIDE_AGENTS } from '../../shared/agents.js';

const MAX_PATH = 1000;

// Settings > Agents: default agent for new consoles and executable path overrides
export function validateAgentSetting(
  key: 'defaultAgent' | 'agentPaths',
  value: unknown,
  error: (message: string) => Error,
): Partial<AppSettings> {
  if (key === 'defaultAgent') {
    if (!isAgentKind(value)) throw error('defaultAgent must be claude, codex, gemini, opencode or custom');
    return { defaultAgent: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('agentPaths must be an object');
  const out: AppSettings['agentPaths'] = {};
  for (const [agent, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(PATH_OVERRIDE_AGENTS as string[]).includes(agent)) throw error(`agentPaths: unknown agent ${agent}`);
    if (typeof raw !== 'string' || raw.length > MAX_PATH) throw error(`agentPaths.${agent} must be a path`);
    const trimmed = raw.trim();
    if (trimmed) out[agent as keyof AppSettings['agentPaths']] = trimmed;
  }
  return { agentPaths: out };
}
