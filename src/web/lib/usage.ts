import { create } from 'zustand';
import type { UsageBroadcast, UsageRange, UsageReport } from '../../shared/usage';
import { getToken } from './auth';

// Usage numbers: the compact live snapshot (socket 'usage' messages, used by the console token
// chips and the jobs-paused banner) and the detailed report the Usage section fetches per range.

async function get<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: token ? { 'x-agentarmy-token': token } : {},
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchUsageReport = (range: UsageRange) => get<UsageReport>(`/api/usage?range=${range}`);

interface UsageStore {
  live: UsageBroadcast | null;
  receive: (live: UsageBroadcast) => void;
  load: () => Promise<void>;
}

export const useUsage = create<UsageStore>((set) => ({
  live: null,
  receive: (live) => set({ live }),
  load: async () => {
    try {
      set({ live: await get<UsageBroadcast>('/api/usage/live') });
    } catch {
      // older server or not reachable yet; the next broadcast fills it in
    }
  },
}));
