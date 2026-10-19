import { create } from 'zustand';
import type {
  ComposeRequest,
  ComposerRow,
  LaunchTemplateResponse,
  Loop,
  LoopInput,
  PauseResponse,
  SaveTemplateRequest,
  Template,
  TeamSendResponse,
} from '../../shared/protocol';
import { request } from './api';
import { useBoard } from './store';

// Loops, Pause/Resume all, team messages and the Composer: API calls and the small UI store.

const loopPath = (id: string) => `/api/loops/${encodeURIComponent(id)}`;

export const loopsApi = {
  list: () => request<Loop[]>('GET', '/api/loops'),
  create: (input: LoopInput) => request<Loop>('POST', '/api/loops', input),
  update: (id: string, patch: Partial<LoopInput> & { enabled?: boolean }) => request<Loop>('PATCH', loopPath(id), patch),
  remove: (id: string) => request<{ ok: true }>('DELETE', loopPath(id)),
  runNow: (id: string) => request<Loop>('POST', `${loopPath(id)}/run`),
};

export const teamApi = {
  pause: (projectId?: string) => request<PauseResponse>('POST', '/api/pause', projectId ? { projectId } : {}),
  resume: (projectId?: string) => request<PauseResponse>('POST', '/api/resume-paused', projectId ? { projectId } : {}),
  sendToProject: (projectId: string, text: string) =>
    request<TeamSendResponse>('POST', `/api/projects/${encodeURIComponent(projectId)}/send`, { text }),
  compose: (req: ComposeRequest) => request<LaunchTemplateResponse>('POST', '/api/compose', req),
  saveTemplate: (req: SaveTemplateRequest) => request<Template>('POST', '/api/templates/custom', req),
  deleteTemplate: (id: string) => request<{ ok: true }>('DELETE', `/api/templates/custom/${encodeURIComponent(id)}`),
};

export const agentsLabel = (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`;

interface LoopsStore {
  loops: Record<string, Loop>;
  loopsOpen: boolean;
  // Editing a loop in the modal: null = list, 'new' = blank form (preset target), or a loop id
  editing: { id: string | 'new'; projectId?: string; consoleIds?: string[] } | null;
  composerOpen: boolean;
  composerRows: ComposerRow[] | null; // prefill (e.g. from a custom template)
  load: () => Promise<void>;
  receive: (loops: Loop[]) => void;
  upsert: (loop: Loop) => void;
  remove: (id: string) => void;
  openLoops: (editing?: LoopsStore['editing']) => void;
  closeLoops: () => void;
  setEditing: (editing: LoopsStore['editing']) => void;
  openComposer: (rows?: ComposerRow[]) => void;
  closeComposer: () => void;
}

export const useLoops = create<LoopsStore>((set) => ({
  loops: {},
  loopsOpen: false,
  editing: null,
  composerOpen: false,
  composerRows: null,
  load: async () => {
    try {
      const list = await loopsApi.list();
      set({ loops: Object.fromEntries(list.map((l) => [l.id, l])) });
    } catch {
      // older server without loops
    }
  },
  receive: (list) => set({ loops: Object.fromEntries(list.map((l) => [l.id, l])) }),
  upsert: (loop) => set((s) => ({ loops: { ...s.loops, [loop.id]: loop } })),
  remove: (id) =>
    set((s) => {
      if (!s.loops[id]) return s;
      const loops = { ...s.loops };
      delete loops[id];
      return { loops };
    }),
  openLoops: (editing = null) => set({ loopsOpen: true, editing }),
  closeLoops: () => set({ loopsOpen: false, editing: null }),
  setEditing: (editing) => set({ editing }),
  openComposer: (rows) => set({ composerOpen: true, composerRows: rows ?? null }),
  closeComposer: () => set({ composerOpen: false, composerRows: null }),
}));

export function activeLoopCount(loops: Record<string, Loop>): number {
  return Object.values(loops).filter((l) => l.enabled).length;
}

// Pause all / Resume all (optionally one project), with a toast either way
export async function pauseAll(projectId?: string): Promise<void> {
  const { toast } = useBoard.getState();
  try {
    const res = await teamApi.pause(projectId);
    toast(res.count ? `Paused ${agentsLabel(res.count)}` : 'No agent is working right now');
  } catch (error) {
    toast(`Pause failed: ${(error as Error).message}`);
  }
}

export async function resumePaused(projectId?: string): Promise<void> {
  const { toast } = useBoard.getState();
  try {
    const res = await teamApi.resume(projectId);
    toast(res.count ? `Resumed ${agentsLabel(res.count)}` : 'Nothing to resume');
  } catch (error) {
    toast(`Resume failed: ${(error as Error).message}`);
  }
}
