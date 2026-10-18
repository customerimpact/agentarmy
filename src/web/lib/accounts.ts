import { create } from 'zustand';
import type { Account, AccountsPatch, AccountsState, ConsoleInfo } from '../../shared/protocol';
import { getToken } from './auth';

// Claude Code accounts (config dirs). Loaded when the socket opens, kept fresh by 'accounts' messages.

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['x-agentarmy-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      message = data.error || message;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const accountPath = (id: string) => `/api/accounts/${encodeURIComponent(id)}`;

export const accountsApi = {
  list: () => request<AccountsState>('GET', '/api/accounts'),
  create: (name: string) => request<Account>('POST', '/api/accounts', { name }),
  patch: (patch: AccountsPatch) => request<AccountsState>('PATCH', '/api/accounts', patch),
  rename: (id: string, name: string) => request<Account>('PATCH', accountPath(id), { name }),
  remove: (id: string) => request<{ ok: true }>('DELETE', accountPath(id)),
  login: (id: string) => request<ConsoleInfo>('POST', `${accountPath(id)}/login`),
  clearLimit: (id: string) => request<Account>('POST', `${accountPath(id)}/clear-limit`),
};

interface AccountsStore {
  state: AccountsState | null;
  load: () => Promise<void>;
  receive: (state: AccountsState) => void;
  patch: (patch: AccountsPatch) => Promise<void>;
}

export const useAccounts = create<AccountsStore>((set) => ({
  state: null,
  load: async () => {
    try {
      set({ state: await accountsApi.list() });
    } catch {
      // older server; the panel shows a loading line
    }
  },
  receive: (state) => set({ state }),
  patch: async (patch) => set({ state: await accountsApi.patch(patch) }),
}));

export function useAccountList(): Account[] {
  return useAccounts((s) => s.state?.accounts) ?? EMPTY;
}
const EMPTY: Account[] = [];

// The account Auto would pick right now (first ok one), like the server's pickAvailable
export function autoAccount(accounts: Account[]): Account | undefined {
  return accounts.find((a) => a.status === 'ok') ?? accounts.find((a) => a.isDefault);
}

// What a new agent gets: the "new agents use" choice, or Auto
export function newAgentAccount(state: AccountsState | null): Account | undefined {
  if (!state) return undefined;
  if (state.newAgentAccount !== 'auto') {
    const chosen = state.accounts.find((a) => a.id === state.newAgentAccount);
    if (chosen) return chosen;
  }
  return autoAccount(state.accounts);
}

export function accountFor(accounts: Account[], c: Pick<ConsoleInfo, 'accountId'>): Account | undefined {
  const id = c.accountId && c.accountId !== 'auto' ? c.accountId : 'default';
  return accounts.find((a) => a.id === id);
}

export function formatReset(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true })
    .replace(/\s?([AP]M)/, (_m, x: string) => x.toLowerCase());
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

// The highest of the two plan windows, for compact chips
export function peakUtilization(a: Account): number | undefined {
  const u = a.utilization;
  if (!u) return undefined;
  const values = [u.fiveHour, u.sevenDay].filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : undefined;
}
