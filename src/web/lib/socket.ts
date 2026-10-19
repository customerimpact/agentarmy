import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { api } from './api';
import { getToken } from './auth';
import { useServerSettings } from './settings';
import { useUsage } from './usage';
import { useBoard } from './store';
import { usePreviewOffers } from './previews';
import { formatReset, useAccounts } from './accounts';
import { useLoops } from './loops';
import { receiveItem, useItems } from './items';
import { useDrawings } from './drawing/store';
import { receiveProviderEvent, useProviderHub } from './providers-hub';
import { useProviders } from './provider-store';

export type TerminalStreamListener = (kind: 'replay' | 'output', data: string) => void;
export type BrowserFrameListener = (
  frame: Extract<ServerMessage, { type: 'browser-frame' }>,
) => void;

const MIN_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 10_000;

// One multiplexed socket per tab; terminals subscribe by console id
class BoardSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private listeners = new Map<string, Set<TerminalStreamListener>>();
  private frameListeners = new Map<string, Set<BrowserFrameListener>>();

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

  // Browser tiles: frames only stream while at least one listener is attached
  subscribeFrames(id: string, listener: BrowserFrameListener): () => void {
    let set = this.frameListeners.get(id);
    if (!set) {
      set = new Set();
      this.frameListeners.set(id, set);
    }
    set.add(listener);
    this.send({ type: 'browser-attach', id });
    return () => {
      const current = this.frameListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.frameListeners.delete(id);
        this.send({ type: 'browser-detach', id });
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
      for (const id of this.frameListeners.keys()) this.send({ type: 'browser-attach', id });
      // Statuses may have changed while we were away; resync the full list
      api
        .getState()
        .then((state) => {
          useBoard.getState().loadState(state);
          useItems.getState().load(state);
        })
        .catch(() => undefined);
      void useUsage.getState().load();
      void useAccounts.getState().load();
      void useLoops.getState().load();
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
      case 'job':
        useBoard.getState().upsertJob(message.job);
        break;
      case 'job-removed':
        useBoard.getState().removeJob(message.id);
        break;
      case 'action':
        useBoard.getState().upsertAction(message.action);
        break;
      case 'actions-removed':
        useBoard.getState().removeActions(message.ids);
        break;
      case 'project':
        useBoard.getState().upsertProject(message.project);
        break;
      case 'project-removed':
        useBoard.getState().removeProject(message.id);
        break;
      case 'browser':
        useBoard.getState().upsertBrowser(message.browser);
        break;
      case 'browser-removed':
        useBoard.getState().removeBrowser(message.id);
        break;
      case 'item':
        receiveItem(message.item);
        break;
      case 'item-removed':
        useItems.getState().removeItem(message.id);
        break;
      case 'workspaces':
        useItems.getState().setWorkspaces(message.workspaces, message.activeWorkspaceId);
        break;
      case 'settings':
        useServerSettings.getState().receive(message.settings);
        break;
      case 'usage':
        useUsage.getState().receive(message.usage);
        break;
      case 'browser-frame':
        for (const listener of this.frameListeners.get(message.id) ?? []) listener(message);
        break;
      case 'preview-offer':
        usePreviewOffers.getState().add(message.offer);
        break;
      case 'preview-offer-removed':
        usePreviewOffers.getState().remove(message.id);
        break;
      case 'loop':
        useLoops.getState().upsert(message.loop);
        break;
      case 'loop-removed':
        useLoops.getState().remove(message.id);
        break;
      case 'drawings':
        useDrawings.getState().applyRemote(message.upsert, message.remove, message.origin);
        break;
      case 'accounts':
        useAccounts.getState().receive(message.accounts);
        if (useProviderHub.getState().data) void useProviderHub.getState().load();
        break;
      case 'provider-event':
        receiveProviderEvent(message.event);
        void useProviders.getState().load(true);
        break;
      case 'account-switch': {
        const e = message.event;
        useBoard.getState().toast(`${e.consoleName} switched from ${e.fromName} to ${e.toName}${e.resetsAt ? ` (${e.fromName} limited until ${formatReset(e.resetsAt)})` : ''}`);
        break;
      }
    }
  }
}

export const socket = new BoardSocket();
