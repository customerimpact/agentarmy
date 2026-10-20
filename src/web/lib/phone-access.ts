import { create } from 'zustand';
import type { DeviceTarget, PhonePairInfo, PhoneStatus } from '../../shared/protocol';
import { request } from './api';
import { flyTo } from './board-actions';
import { desktop } from './desktop';
import { useBoard } from './store';

// Phone on this Wi-Fi (src/server/phone): Settings > Integrations > Phone, plus
// "Continue on phone / on computer" for a console.

export const phoneAccessApi = {
  status: () => request<PhoneStatus>('GET', '/api/phone'),
  setEnabled: (enabled: boolean) => request<PhoneStatus>('PUT', '/api/phone', { enabled }),
  pair: () => request<PhonePairInfo>('POST', '/api/phone/pair'),
  removeDevice: (id: string) => request<PhoneStatus>('DELETE', `/api/phone/devices/${encodeURIComponent(id)}`),
  handoff: (consoleId: string, to: DeviceTarget) => request<{ ok: true }>('POST', '/api/device-handoff', { consoleId, to }),
};

interface PhoneAccessState {
  status: PhoneStatus | null;
  load: () => Promise<void>;
  receive: (status: PhoneStatus) => void;
}

export const usePhoneAccess = create<PhoneAccessState>((set) => ({
  status: null,
  load: async () => {
    try {
      set({ status: await phoneAccessApi.status() });
    } catch {
      // older server without phone access: the row says so
    }
  },
  receive: (status) => set({ status }),
}));

export function phonesOnline(status: PhoneStatus | null): number {
  return status?.devices.filter((d) => d.online).length ?? 0;
}

// A phone said "On computer" (or launched agents): bring the window up and fly to the console
export function receiveDeviceHandoff(consoleId: string, to: DeviceTarget): void {
  if (to !== 'desktop' || !useBoard.getState().consoles[consoleId]) return;
  desktop?.focusWindow();
  void flyTo(consoleId);
  useBoard.getState().toast(`${useBoard.getState().consoles[consoleId].name} continued from your phone`);
}

export async function continueOnPhone(consoleId: string): Promise<void> {
  try {
    await phoneAccessApi.handoff(consoleId, 'phone');
    useBoard.getState().toast('Opened on your phone');
  } catch (e) {
    useBoard.getState().toast(`Could not open it on your phone: ${(e as Error).message}`);
  }
}
