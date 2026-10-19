import { create } from 'zustand';
import type { AgentDetection, AgentKind, AgentsDetectResponse } from '../../shared/agents';
import { request } from './api';

// Installed agent CLIs (GET /api/agents/detect). Loaded when the New agent dialog or Settings > Agents
// opens; the server caches detection for 30 s, `fresh` re-runs it.
interface AgentsStore {
  agents: AgentDetection[] | null;
  loading: boolean;
  error: string | null;
  load: (fresh?: boolean) => Promise<void>;
}

export const useAgents = create<AgentsStore>((set, get) => ({
  agents: null,
  loading: false,
  error: null,
  load: async (fresh = false) => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await request<AgentsDetectResponse>('GET', `/api/agents/detect${fresh ? '?fresh=1' : ''}`);
      set({ agents: res.agents, error: null, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
}));

export function detectionFor(agents: AgentDetection[] | null, id: AgentKind): AgentDetection | undefined {
  return agents?.find((a) => a.id === id);
}
