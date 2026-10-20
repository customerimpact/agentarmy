import { create } from 'zustand';
import {
  importShareKey,
  open,
  seal,
  type GuestMessage,
  type OwnerMessage,
  type ShareConsole,
  type ShareCursor,
  type SharePeer,
  type ShareProject,
} from '../../shared/share-crypto';

// The guest side of a shared board (gridhive.dev/s/<id>#k=<key>): gets a relay token from
// gridhive.dev with the guest's session, joins the share's relay room and talks to the owner's
// computer, end-to-end encrypted with the key from the link.

export type Phase = 'loading' | 'expired' | 'no-key' | 'signin' | 'connecting' | 'waiting-owner' | 'live' | 'ended' | 'error';

interface ViewerState {
  phase: Phase;
  message: string;
  title: string;
  owner: string;
  consoles: Record<string, ShareConsole>;
  projects: Record<string, ShareProject>;
  you: SharePeer | null;
  peers: SharePeer[];
  cursors: Record<string, ShareCursor>;
  following: string | null;
  set: (patch: Partial<ViewerState>) => void;
}

export const useViewer = create<ViewerState>((set) => ({
  phase: 'loading',
  message: '',
  title: '',
  owner: '',
  consoles: {},
  projects: {},
  you: null,
  peers: [],
  cursors: {},
  following: null,
  set: (patch) => set(patch),
}));

type OutputListener = (kind: 'replay' | 'out', data: string, size?: { cols: number; rows: number }) => void;

export const shareId = (location.pathname.match(/^\/s\/([A-Za-z0-9_-]{12})/) ?? [])[1] ?? '';

// The key lives after "#" in the link; keep it for this tab (sign-in redirects drop the hash)
export function takeKey(): string | null {
  const store = `gridhive.share.${shareId}`;
  const fromHash = /#k=([A-Za-z0-9_-]{43})/.exec(location.hash)?.[1];
  try {
    if (fromHash) sessionStorage.setItem(store, fromHash);
    if (location.hash) history.replaceState(null, '', location.pathname);
    return fromHash ?? sessionStorage.getItem(store);
  } catch {
    return fromHash ?? null;
  }
}

class ViewerLink {
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private self = '';
  private owner = '';
  private attached = new Map<string, Set<OutputListener>>();
  private stopped = false;

  async start(rawKey: string): Promise<void> {
    this.key = await importShareKey(rawKey);
    await this.connect();
  }

  private async connect(): Promise<void> {
    const v = useViewer.getState();
    v.set({ phase: v.phase === 'live' ? 'live' : 'connecting' });
    const res = await fetch('/api/relay/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ share: shareId }),
    });
    const data = (await res.json().catch(() => ({}))) as { token?: string; relayUrl?: string; dev?: string; ownerDevice?: string; error?: string };
    if (res.status === 404) return v.set({ phase: 'expired', message: data.error ?? 'This share link has expired' });
    if (res.status === 401) return v.set({ phase: 'signin' });
    if (!res.ok || !data.token || !data.relayUrl || !data.dev || !data.ownerDevice) {
      return v.set({ phase: 'error', message: data.error ?? 'Could not join this board' });
    }
    this.self = data.dev;
    this.owner = data.ownerDevice;
    const ws = new WebSocket(`${data.relayUrl}?token=${encodeURIComponent(data.token)}`);
    this.ws = ws;
    ws.onmessage = (event) => void this.onFrame(String(event.data));
    ws.onclose = () => {
      if (this.stopped || useViewer.getState().phase === 'ended') return;
      window.setTimeout(() => void this.connect(), 2000);
    };
  }

  private async onFrame(raw: string): Promise<void> {
    const frame = JSON.parse(raw) as { type?: string; devices?: { id: string }[]; from?: string; nonce?: string; box?: string };
    const v = useViewer.getState();
    if (frame.type === 'presence') {
      const ownerHere = (frame.devices ?? []).some((d) => d.id === this.owner);
      if (!ownerHere) v.set({ phase: 'waiting-owner' });
      else if (v.phase !== 'live') this.greet();
      return;
    }
    if (!frame.from || !frame.nonce || !frame.box || !this.key) return;
    const msg = (await open(this.key, frame.from, this.self, frame.nonce, frame.box)) as OwnerMessage | null;
    if (!msg) return;
    switch (msg.t) {
      case 'snapshot':
        v.set({
          phase: 'live',
          title: msg.title,
          you: msg.you,
          peers: msg.peers,
          consoles: Object.fromEntries(msg.consoles.map((c) => [c.id, c])),
          projects: Object.fromEntries(msg.projects.map((p) => [p.id, p])),
        });
        for (const id of this.attached.keys()) await this.send({ t: 'attach', id });
        return;
      case 'console':
        v.set({ consoles: { ...v.consoles, [msg.console.id]: msg.console } });
        return;
      case 'removed': {
        const { [msg.id]: _gone, ...rest } = v.consoles;
        v.set({ consoles: rest });
        return;
      }
      case 'project':
        v.set({ projects: { ...v.projects, [msg.project.id]: msg.project } });
        return;
      case 'project-removed': {
        const { [msg.id]: _gone, ...rest } = v.projects;
        v.set({ projects: rest });
        return;
      }
      case 'peers':
        v.set({ peers: msg.peers });
        return;
      case 'cursor': {
        const cursors = { ...v.cursors };
        if (msg.c) cursors[msg.dev] = msg.c;
        else delete cursors[msg.dev];
        v.set({ cursors });
        return;
      }
      case 'replay':
        for (const l of this.attached.get(msg.id) ?? []) l('replay', msg.data, { cols: msg.cols, rows: msg.rows });
        return;
      case 'out':
        for (const l of this.attached.get(msg.id) ?? []) l('out', msg.data);
        return;
      case 'bye':
        this.stopped = true;
        v.set({ phase: 'ended', message: msg.reason });
        this.ws?.close();
        return;
    }
  }

  // Say hello until the board arrives (the owner may still be looking up who we are)
  private greetTimer: number | null = null;
  private greet(): void {
    if (this.greetTimer !== null) return;
    const tick = () => {
      if (useViewer.getState().phase === 'live' || this.ws?.readyState !== WebSocket.OPEN) {
        this.greetTimer = null;
        return;
      }
      void this.send({ t: 'hello' });
      this.greetTimer = window.setTimeout(tick, 2000);
    };
    tick();
  }

  async send(message: GuestMessage): Promise<void> {
    if (!this.key || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(await seal(this.key, this.self, this.owner, message)));
  }

  attach(id: string, listener: OutputListener): () => void {
    let set = this.attached.get(id);
    if (!set) {
      set = new Set();
      this.attached.set(id, set);
      void this.send({ t: 'attach', id });
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.attached.delete(id);
        void this.send({ t: 'detach', id });
      }
    };
  }
}

export const viewerLink = new ViewerLink();
