import type { FastifyInstance } from 'fastify';
import type { AppSettings, ConsoleInfo } from '../../shared/protocol.js';
import { AGENT_KINDS, type AgentDetection, type AgentKind, type AgentsDetectResponse } from '../../shared/agents.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { customAdapter } from './custom.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';
import { AGENT_HEURISTICS, CUSTOM_HEURISTICS, OutputStatusTracker } from './output-status.js';
import type { AgentAdapter } from './types.js';

export type { AgentAdapter, LaunchContext, LaunchSpec } from './types.js';

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  custom: customAdapter,
};

export function adapterFor(agent: AgentKind | undefined): AgentAdapter {
  return ADAPTERS[agent ?? 'claude'] ?? claudeAdapter;
}

export function agentOf(info: Pick<ConsoleInfo, 'agent'>): AgentKind {
  return info.agent ?? 'claude';
}

// A fresh tracker per launch for CLIs without hooks; null for Claude Code
export function outputTrackerFor(adapter: AgentAdapter): OutputStatusTracker | null {
  if (!adapter.heuristics) return null;
  const base = adapter.heuristics === 'custom' ? CUSTOM_HEURISTICS : AGENT_HEURISTICS;
  return new OutputStatusTracker({ ...base, ...(adapter.statusFromOutput ? { fromOutput: adapter.statusFromOutput } : {}) });
}

const DETECT_TTL_MS = 30_000;
let cache: { key: string; at: number; result: Promise<AgentsDetectResponse> } | null = null;

export function detectAgents(settings?: AppSettings, options: { fresh?: boolean } = {}): Promise<AgentsDetectResponse> {
  const key = JSON.stringify([settings?.claudePath ?? '', settings?.agentPaths ?? {}]);
  const now = Date.now();
  if (!options.fresh && cache && cache.key === key && now - cache.at < DETECT_TTL_MS) return cache.result;
  const result = Promise.all(
    AGENT_KINDS.map(async (id): Promise<AgentDetection> => {
      const adapter = ADAPTERS[id];
      const found = await adapter.detect(settings);
      return {
        id,
        label: adapter.label,
        ...found,
        supportsResume: adapter.supportsResume,
        supportsHooks: adapter.supportsHooks,
        supportsMcp: adapter.supportsMcp,
        ...(adapter.notes ? { notes: adapter.notes } : {}),
      };
    }),
  ).then((agents) => ({ agents }));
  cache = { key, at: now, result };
  return result;
}

export function registerAgentRoutes(app: FastifyInstance, options: { settings: () => AppSettings }): void {
  // ?fresh=1 skips the 30 s cache (after installing a CLI or changing a path)
  app.get('/api/agents/detect', async (request) => {
    const { fresh } = request.query as { fresh?: string };
    return detectAgents(options.settings(), { fresh: fresh === '1' });
  });
}
