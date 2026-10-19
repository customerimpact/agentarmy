import { create } from 'zustand';
import type { AgentKind } from '../../shared/agents';
import { request } from './api';
import { useAccounts } from './accounts';
import { useAgents } from './agents';
import { useBoard } from './store';
import { normalizeProviders, providersFromDetection, readinessOf, type ProviderInfo, type Readiness } from './provider-readiness';

// Provider readiness for the UI: GET /api/providers, or detection + Claude accounts on older servers

interface ProvidersStore {
  providers: ProviderInfo[] | null;
  hub: boolean; // the server has /api/providers
  loading: boolean;
  load: (fresh?: boolean) => Promise<void>;
}

export const useProviders = create<ProvidersStore>((set, get) => ({
  providers: null,
  hub: false,
  loading: false,
  load: async (fresh = false) => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const raw = await request<unknown>('GET', `/api/providers${fresh ? '?fresh=1' : ''}`);
      const providers = normalizeProviders(raw);
      if (providers.length) {
        set({ providers, hub: true, loading: false });
        return;
      }
    } catch {
      // older server: fall through to detection
    }
    await Promise.all([useAgents.getState().load(fresh), useAccounts.getState().state ? null : useAccounts.getState().load()]);
    set({
      providers: providersFromDetection(useAgents.getState().agents, useAccounts.getState().state),
      hub: false,
      loading: false,
    });
  },
}));

export function useProvider(kind: AgentKind): ProviderInfo | undefined {
  return useProviders((s) => s.providers?.find((p) => p.id === kind));
}

export function useReadiness(kind: AgentKind): Readiness {
  const p = useProvider(kind);
  return readinessOf(p, kind);
}

// "Install" / "Log in" quick links: Settings > Agents & accounts, scrolled to that provider
export const SETTINGS_AGENTS_CATEGORY = 'agents';
export function openProviderSettings(kind: AgentKind): void {
  try {
    sessionStorage.setItem('agentarmy.settingsProvider', kind);
  } catch {
    // convenience only
  }
  window.dispatchEvent(new CustomEvent('agentarmy:settings-provider', { detail: kind }));
  useBoard.getState().openSettings(SETTINGS_AGENTS_CATEGORY);
}
