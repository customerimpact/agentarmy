import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { api } from './api';
import { getToken } from './auth';
import { useBoard } from './store';

export type TerminalStreamListener = (kind: 'replay' | 'output', data: string) => void;

const MIN_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 10_000;

// One multiplexed socket per tab; terminals subscribe by console id
class BoardSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private listeners = new Map<string, Set<TerminalStreamListener>>();

  start(): void {
    this.stopped = false;
    this.connect();
    // Wake up immediately when the laptop resumes or the tab comes back instead of waiting out backoff
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(message));
  }

  subscribe(id: string, listener: TerminalStreamListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    // Each subscriber needs its own replay to paint the screen, so attach on every subscribe
    this.send({ type: 'attach', id });
    return () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(id);
        this.send({ type: 'detach', id });
      }
    };
  }

  private reconnectNow(): void {
    if (this.stopped || this.ws) return;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private connect(): void {
    const token = getToken();
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Without a token the browser's same-origin auth cookie authenticates the upgrade
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const url = `${protocol}://${window.location.host}/ws${query}`;
    useBoard.getState().setSocketState('connecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      useBoard.getState().setSocketState('open');
      for (const id of this.listeners.keys()) this.send({ type: 'attach', id });
      // Statuses may have changed while we were away; resync the full list
      api
        .getState()
        .then((state) => useBoard.getState().loadState(state))
        .catch(() => undefined);
    };

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(message);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      useBoard.getState().setSocketState('closed');
      this.scheduleReconnect();
    };

    // onclose always follows onerror, so reconnection is handled there
    ws.onerror = () => undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempts);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'replay':
      case 'output': {
        const set = this.listeners.get(message.id);
        if (set) for (const listener of set) listener(message.type, message.data);
        break;
      }
      case 'console':
        useBoard.getState().upsertConsole(message.console);
        break;
      case 'removed':
        useBoard.getState().removeConsole(message.id);
        break;
    }
  }
}

export const socket = new BoardSocket();
