import { create } from 'zustand';
import type { Account, ConsoleInfo } from '../../shared/protocol';
import type { ProviderEvent, ProviderId, ProviderStatus, ProvidersResponse } from '../../shared/providers';
import { request } from './api';
import { flyTo } from './board-actions';
import { useAgents } from './agents';
import { useBoard } from './store';

// Agents & accounts hub (GET /api/providers): installed / logged in / accounts per agent CLI, plus
// the Install and Log in actions. Both open a terminal on the board; the server tells us when they
// finished with a 'provider-event' message.

export const providersApi = {
  list: (fresh = false) => request<ProvidersResponse>('GET', `/api/providers${fresh ? '?fresh=1' : ''}`),
  install: (id: ProviderId) => request<ConsoleInfo>('POST', `/api/providers/${id}/install`),
  login: (id: ProviderId, accountId?: string) =>
    request<ConsoleInfo>('POST', `/api/providers/${id}/login`, accountId ? { accountId } : {}),
  addAccount: (id: ProviderId, name: string) => request<Account>('POST', `/api/providers/${id}/accounts`, { name }),
};

interface HubStore {
  data: ProvidersResponse | null;
  loading: boolean;
  error: string | null;
  load: (fresh?: boolean) => Promise<void>;
}

export const useProviderHub = create<HubStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  load: async (fresh = false) => {
    if (get().loading && !fresh) return;
    set({ loading: true });
    try {
      set({ data: await providersApi.list(fresh), error: null, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
}));

export function useProviderStatus(id: ProviderId | string | undefined): ProviderStatus | undefined {
  return useProviderHub((s) => s.data?.providers.find((p) => p.id === id));
}

const toast = (message: string) => useBoard.getState().toast(message);

// Show a console the server just opened (install / login) and fly to it
function showConsole(info: ConsoleInfo): void {
  useBoard.getState().upsertConsole(info);
  useBoard.getState().closeSettings?.();
  window.setTimeout(() => flyTo(info.id), 120);
}

export function installProvider(p: ProviderStatus): void {
  if (!p.installCommand) return;
  useBoard.getState().askConfirm({
    title: `Install ${p.label}?`,
    message: `This runs \`${p.installCommand}\` on your computer, in a terminal on the board.${p.installNote ? ` ${p.installNote}` : ''}`,
    confirmLabel: 'Install',
    onConfirm: async () => {
      try {
        const info = await providersApi.install(p.id);
        showConsole(info);
        toast(`Installing ${p.label}…`);
        void useProviderHub.getState().load();
      } catch (e) {
        toast(`Install failed: ${(e as Error).message}`);
      }
    },
  });
}

export async function loginProvider(p: ProviderStatus, accountId?: string): Promise<void> {
  const open = p.accounts.find((a) => a.id === accountId || (!accountId && a.isDefault))?.loginConsoleId;
  if (open) {
    useBoard.getState().closeSettings?.();
    flyTo(open);
    return;
  }
  try {
    const info = await providersApi.login(p.id, accountId);
    showConsole(info);
    toast(`Finish the ${p.label} login in the terminal "${info.name}"`);
    void useProviderHub.getState().load();
  } catch (e) {
    toast(`Login failed: ${(e as Error).message}`);
  }
}

// Server message: an install or login finished
export function receiveProviderEvent(event: ProviderEvent): void {
  if (event.kind === 'installed') toast(`${event.label} installed`);
  else if (event.kind === 'install-failed') toast(`${event.label} install failed${event.exitCode !== undefined ? ` (exit code ${event.exitCode})` : ''}. See its terminal.`);
  else toast(`${event.label}: ${event.accountName === 'Default' ? 'logged in' : `${event.accountName} logged in`}`);
  void useProviderHub.getState().load(true);
  void useAgents.getState().load(true);
}
