import { create } from 'zustand';
import type { CloudStatus } from '../../shared/protocol';
import { request } from './api';

// GridHive account link (src/server/cloud.ts): status, sign in (device code in the browser), sign out

const SKIP_KEY = 'gridhive.signinPrompt';

export const cloudApi = {
  status: () => request<CloudStatus>('GET', '/api/cloud'),
  link: () => request<CloudStatus>('POST', '/api/cloud/link'),
  cancel: () => request<CloudStatus>('POST', '/api/cloud/cancel'),
  unlink: () => request<CloudStatus>('POST', '/api/cloud/unlink'),
};

interface CloudState {
  status: CloudStatus | null;
  load: () => Promise<void>;
  receive: (status: CloudStatus) => void;
}

export const useCloud = create<CloudState>((set) => ({
  status: null,
  load: async () => {
    try {
      set({ status: await cloudApi.status() });
    } catch {
      // older server: no account features
    }
  },
  receive: (status) => set({ status }),
}));

export function promptSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === 'skipped';
  } catch {
    return false;
  }
}

export function skipPrompt(): void {
  try {
    localStorage.setItem(SKIP_KEY, 'skipped');
  } catch {
    // private window: the prompt shows again next time
  }
}
