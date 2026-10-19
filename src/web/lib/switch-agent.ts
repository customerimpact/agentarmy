import { create } from 'zustand';
import type { AgentKind } from '../../shared/agents';
import type { ConsoleInfo, Job, SwitchAgentRequest, SwitchAgentResponse } from '../../shared/protocol';
import { request } from './api';

// "Switch agent…": move a running console to another AI CLI. The server builds a handoff brief,
// starts the new CLI in the same folder and spot, types the brief in and (by default) closes the old one.

export const switchAgentApi = {
  switch: (id: string, req: SwitchAgentRequest) =>
    request<SwitchAgentResponse>('POST', `/api/consoles/${encodeURIComponent(id)}/switch-agent`, req),
};

interface SwitchAgentUi {
  ids: string[] | null; // consoles to switch (one from a header, several from the selection bar)
  open: (ids: string[]) => void;
  close: () => void;
}

export const useSwitchAgent = create<SwitchAgentUi>((set) => ({
  ids: null,
  open: (ids) => set({ ids: ids.length ? ids : null }),
  close: () => set({ ids: null }),
}));

export const openSwitchAgent = (ids: string | string[]): void =>
  useSwitchAgent.getState().open(Array.isArray(ids) ? ids : [ids]);

export const agentOf = (c: Pick<ConsoleInfo, 'agent'>): AgentKind => c.agent ?? 'claude';

// Only real CLIs can be switched (a custom command has no conversation to hand off)
export const canSwitch = (c: Pick<ConsoleInfo, 'agent' | 'status'>): boolean => c.agent !== 'custom';

export type SwitchStep = 'queued' | 'brief' | 'starting' | 'sending' | 'done' | 'error';

export const STEP_ORDER: SwitchStep[] = ['brief', 'starting', 'sending', 'done'];

// Progress after the server answered: the new console starts, then the brief job is picked up
export function stepAfterResponse(
  newConsole: Pick<ConsoleInfo, 'status'> | undefined,
  job: Pick<Job, 'status'> | undefined,
  oldGone: boolean,
  closeOld: boolean,
): SwitchStep {
  if (job && job.status !== 'sent') return 'done';
  if (closeOld && oldGone && newConsole && newConsole.status !== 'starting') return 'done';
  if (!newConsole || newConsole.status === 'starting') return 'starting';
  if (newConsole.status === 'exited' || newConsole.status === 'error') return 'error';
  return 'sending';
}

export function stepLabel(step: SwitchStep, target: string): string {
  switch (step) {
    case 'queued':
      return 'Waiting';
    case 'brief':
      return 'Building brief';
    case 'starting':
      return `Starting ${target}`;
    case 'sending':
      return 'Sending brief';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
  }
}
