// Agent CLIs a console can run (see src/server/agents). Shared by the server and the browser UI.

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'custom';
// The CLIs we look for on PATH (custom commands run through the user's shell instead)
export type CliAgentKind = Exclude<AgentKind, 'custom'>;

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'gemini', 'opencode', 'custom'];
export const PATH_OVERRIDE_AGENTS: Exclude<CliAgentKind, 'claude'>[] = ['codex', 'gemini', 'opencode'];

export interface AgentMeta {
  label: string;
  short: string; // header chip
  installCommand?: string;
  installUrl?: string;
}

export const AGENT_META: Record<AgentKind, AgentMeta> = {
  claude: {
    label: 'Claude Code',
    short: 'Claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    installUrl: 'https://code.claude.com/docs/en/setup',
  },
  codex: {
    label: 'Codex CLI',
    short: 'Codex',
    installCommand: 'npm install -g @openai/codex',
    installUrl: 'https://github.com/openai/codex',
  },
  gemini: {
    label: 'Gemini CLI',
    short: 'Gemini',
    installCommand: 'npm install -g @google/gemini-cli',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  opencode: {
    label: 'OpenCode',
    short: 'OpenCode',
    installCommand: 'npm install -g opencode-ai',
    installUrl: 'https://opencode.ai/docs/',
  },
  custom: { label: 'Custom command', short: 'Command' },
};

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as string[]).includes(value);
}

// GET /api/agents/detect -> AgentsDetectResponse
export interface AgentDetection {
  id: AgentKind;
  label: string;
  installed: boolean;
  path?: string; // resolved executable (or the shell, for custom commands)
  version?: string;
  error?: string; // why it was not found
  supportsResume: boolean; // restart continues the conversation
  supportsHooks: boolean; // status from the CLI's own events (else from terminal output)
  supportsMcp: boolean; // gets the agentarmy MCP tools (list_agents, send_job, ...)
  notes?: string; // shown in Settings > Agents
}

export interface AgentsDetectResponse {
  agents: AgentDetection[];
}

// Quick picks in the New agent dialog for custom commands
export const CUSTOM_COMMAND_PRESETS = ['npm run dev', 'npm test -- --watch', 'aider', 'python manage.py shell', 'bash', 'pwsh'];
