import { create } from 'zustand';
import type { PublicSettings, SettingsPatch } from '../../shared/protocol';
import { api } from './api';

// Server-side settings (Claude Code launch options, startup, webhooks, browser path).
// Loaded on demand by the Settings tab and kept fresh by the 'settings' socket message.

interface ServerSettingsStore {
  data: PublicSettings | null;
  error: string | null;
  load: () => Promise<void>;
  receive: (data: PublicSettings) => void;
  patch: (patch: SettingsPatch) => Promise<PublicSettings>;
  reset: () => Promise<void>;
}

export const useServerSettings = create<ServerSettingsStore>((set) => ({
  data: null,
  error: null,
  load: async () => {
    try {
      set({ data: await api.getSettings(), error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  receive: (data) => set({ data, error: null }),
  patch: async (patch) => {
    const data = await api.patchSettings(patch);
    set({ data, error: null });
    return data;
  },
  reset: async () => set({ data: await api.resetSettings(), error: null }),
}));
