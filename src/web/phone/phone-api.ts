import { create } from 'zustand';
import type {
  ActionItem,
  BoardState,
  ConsoleInfo,
  CreateConsoleRequest,
  FsListResponse,
  LaunchTemplateRequest,
  LaunchTemplateResponse,
  PhoneDevice,
  Project,
  ServerMessage,
  Template,
} from '../../shared/protocol';

// The phone page talks only to the phone server: /m/api (allow-listed board API) and /m/ws.
// Auth is the HttpOnly device cookie set when the phone paired.

export class PhoneApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/m/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new PhoneApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const phoneApi = {
  me: () => call<{ device: PhoneDevice }>('GET', '/me'),
  pair: (code: string, name: string) => call<{ device: PhoneDevice }>('POST', '/pair', { code, name }),
  state: () => call<BoardState>('GET', '/state'),
  templates: () => call<Template[]>('GET', '/templates'),
  launchTemplate: (id: string, req: LaunchTemplateRequest) =>
    call<LaunchTemplateResponse>('POST', `/templates/${encodeURIComponent(id)}/launch`, req),
  newAgent: (req: CreateConsoleRequest) => call<ConsoleInfo>('POST', '/consoles', req),
  send: (id: string, text: string) => call<{ ok: true }>('POST', `/consoles/${encodeURIComponent(id)}/send`, { text }),
  answer: (id: string, answer: { key?: string; text?: string }) =>
    call<ActionItem>('POST', `/actions/${encodeURIComponent(id)}/answer`, answer),
  listDir: (path?: string) =>
    call<FsListResponse>('GET', `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  handoff: (consoleId: string, to: 'desktop' | 'phone') => call<{ ok: true }>('POST', '/device-handoff', { consoleId, to }),
};

// "Tim's iPhone" is nicer than nothing; the computer shows this name in Settings > Phone
export function guessDeviceName(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Browser';
}

type Screen = { kind: 'fleet' } | { kind: 'console'; id: string } | { kind: 'launch' };

interface PhoneState {
  consoles: Record<string, ConsoleInfo>;
  actions: Record<string, ActionItem>;
  projects: Record<string, Project>;
  connected: boolean;
  screen: Screen;
  load: (state: BoardState) => void;
  apply: (msg: ServerMessage) => void;
  setConnected: (connected: boolean) => void;
  go: (screen: Screen) => void;
}

const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

export const usePhone = create<PhoneState>((set) => ({
  consoles: {},
  actions: {},
  projects: {},
  connected: false,
  screen: { kind: 'fleet' },
  load: (state) => set({ consoles: byId(state.consoles), actions: byId(state.actions), projects: byId(state.projects) }),
  apply: (msg) =>
    set((s) => {
      switch (msg.type) {
        case 'console':
          return { consoles: { ...s.consoles, [msg.console.id]: msg.console } };
        case 'removed': {
          const { [msg.id]: _gone, ...consoles } = s.consoles;
          return { consoles, screen: s.screen.kind === 'console' && s.screen.id === msg.id ? { kind: 'fleet' } : s.screen };
        }
        case 'action':
          return { actions: { ...s.actions, [msg.action.id]: msg.action } };
        case 'actions-removed': {
          const actions = { ...s.actions };
          for (const id of msg.ids) delete actions[id];
          return { actions };
        }
        case 'project':
          return { projects: { ...s.projects, [msg.project.id]: msg.project } };
        case 'project-removed': {
          const { [msg.id]: _gone, ...projects } = s.projects;
          return { projects };
        }
        case 'device-handoff':
          if (msg.to !== 'phone' || !s.consoles[msg.consoleId]) return {};
          navigator.vibrate?.(80);
          return { screen: { kind: 'console', id: msg.consoleId } };
        default:
          return {};
      }
    }),
  setConnected: (connected) => set({ connected }),
  go: (screen) => set({ screen }),
}));

type OutputListener = (kind: 'replay' | 'output', data: string, size?: { cols: number; rows: number }) => void;

// One WebSocket for events and terminals; reconnects and reloads the state after a drop
class PhoneSocket {
  private ws: WebSocket | null = null;
  private attached = new Map<string, Set<OutputListener>>();
  private retry = 0;
  private stopped = false;

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/m/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      usePhone.getState().setConnected(true);
      void phoneApi.state().then((state) => usePhone.getState().load(state)).catch(() => undefined);
      for (const id of this.attached.keys()) this.sendRaw({ type: 'attach', id });
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      if (msg.type === 'replay' || msg.type === 'output') {
        const size = msg.type === 'replay' && msg.cols && msg.rows ? { cols: msg.cols, rows: msg.rows } : undefined;
        for (const listener of this.attached.get(msg.id) ?? []) listener(msg.type, msg.data, size);
        return;
      }
      usePhone.getState().apply(msg);
    };
    ws.onclose = (event) => {
      usePhone.getState().setConnected(false);
      if (this.stopped) return;
      // Removed on the computer: back to the pairing screen
      if (event.code === 4401) {
        location.reload();
        return;
      }
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      window.setTimeout(() => this.connect(), delay);
    };
  }

  private sendRaw(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  attach(id: string, listener: OutputListener): () => void {
    let set = this.attached.get(id);
    if (!set) {
      set = new Set();
      this.attached.set(id, set);
      this.sendRaw({ type: 'attach', id });
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.attached.delete(id);
        this.sendRaw({ type: 'detach', id });
      }
    };
  }

  input(id: string, data: string): void {
    this.sendRaw({ type: 'input', id, data });
  }
}

export const phoneSocket = new PhoneSocket();
