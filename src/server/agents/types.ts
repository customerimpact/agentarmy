import type { AppSettings, ConsoleInfo } from '../../shared/protocol.js';
import type { AgentDetection, AgentKind } from '../../shared/agents.js';
import type { SpawnCommand } from '../claude-path.js';

export type LaunchMode = 'new' | 'resume';

export interface LaunchContext {
  port: number;
  token: string;
  settings?: AppSettings;
  baseEnv: Record<string, string>; // childEnv(): process env minus parent-session vars and API keys
  accountEnv?: () => Record<string, string>; // Claude accounts (CLAUDE_CONFIG_DIR); Claude only
}

export interface LaunchSpec extends SpawnCommand {
  env: Record<string, string>;
}

export type DetectResult = Pick<AgentDetection, 'installed' | 'path' | 'version' | 'error'>;

// One CLI that a console can run. Everything CLI-specific (flags, config injection, resume,
// status source) lives behind this interface so ConsoleManager stays agent-agnostic.
export interface AgentAdapter {
  id: AgentKind;
  label: string;
  supportsResume: boolean;
  supportsHooks: boolean; // status comes from the CLI's own events; false = PTY output heuristics only
  supportsMcp: boolean;
  // Status guessed from PTY output (src/server/agents/output-status.ts); missing = hooks only (Claude Code)
  heuristics?: 'agent' | 'custom';
  notes?: string;
  detect(settings?: AppSettings): Promise<DetectResult>;
  // Throws with a user-facing message when the CLI cannot be started
  buildLaunch(info: ConsoleInfo, mode: LaunchMode, ctx: LaunchContext): LaunchSpec;
  // Per-console config files the CLI reads (never the user's global config); removed with the console
  removeConsoleFiles?(consoleId: string): void;
  // Full-screen TUIs can mark a turn in their output (e.g. Codex OSC 9 notifications)
  statusFromOutput?(chunk: string): { status: 'needs_you' | 'resting'; detail?: string } | null;
}
