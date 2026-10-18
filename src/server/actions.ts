import crypto from 'node:crypto';
import type { ActionItem, ActionKind, ConsoleInfo } from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import { NotFoundError } from './consoles.js';

// The action inbox: things waiting on the user.
// needs_you opens when a console starts waiting and resolves itself when it moves on;
// error opens on a failed turn and resolves once the console works (or restarts) again;
// request items are filed by agents (request_user_action) and closed by the user.

export const MAX_RESOLVED_ACTIONS = 200;
const MAX_TITLE = 120;
const MAX_DETAIL = 2000;
const STARTUP_SWEEP_MS = 1000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class ActionInbox {
  constructor(private readonly manager: ConsoleManager) {
    manager.on('console', (info) => this.onConsole(info));
    manager.on('removed', (id) => this.onRemoved(id));
    // Items restored from disk may describe a state the console is no longer in
    setTimeout(() => this.sweep(), STARTUP_SWEEP_MS).unref();
  }

  get actions(): ActionItem[] {
    return this.manager.actions;
  }

  private open(consoleId: string, kind: ActionKind): ActionItem | undefined {
    return this.actions.find((a) => a.consoleId === consoleId && a.kind === kind && !a.resolvedAt);
  }

  onConsole(info: ConsoleInfo): void {
    if (info.status === 'needs_you') {
      const existing = this.open(info.id, 'needs_you');
      if (!existing) this.add(info.id, 'needs_you', `${info.name} needs you`, info.statusDetail);
      else if (info.statusDetail && existing.detail !== info.statusDetail) {
        existing.detail = clip(info.statusDetail, MAX_DETAIL);
        this.changed(existing);
      }
    } else {
      this.resolveOpen(info.id, 'needs_you');
    }

    if (info.status === 'error') {
      if (!this.open(info.id, 'error')) {
        this.add(info.id, 'error', `${info.name} hit an error`, info.statusDetail);
      }
    } else if (info.status === 'working' || info.status === 'starting') {
      this.resolveOpen(info.id, 'error');
    }
  }

  request(consoleId: string | null, title: string, detail?: string): ActionItem {
    const text = typeof title === 'string' ? title.trim() : '';
    if (!text) throw new Error('title is required');
    return this.add(consoleId, 'request', text, typeof detail === 'string' ? detail : undefined);
  }

  setResolved(id: string, resolved: boolean): ActionItem {
    const item = this.actions.find((a) => a.id === id);
    if (!item) throw new NotFoundError(`Unknown action ${id}`);
    if (resolved) {
      item.resolvedAt = Date.now();
      item.resolvedBy = 'user';
    } else {
      delete item.resolvedAt;
      delete item.resolvedBy;
    }
    this.changed(item);
    if (resolved) this.cap();
    return item;
  }

  clearResolved(): number {
    const ids = this.actions.filter((a) => a.resolvedAt).map((a) => a.id);
    this.removeIds(ids);
    return ids.length;
  }

  private onRemoved(consoleId: string): void {
    for (const item of this.actions.filter((a) => a.consoleId === consoleId && !a.resolvedAt)) {
      this.resolve(item, 'auto');
    }
    this.cap();
  }

  private sweep(): void {
    for (const item of this.actions.filter((a) => !a.resolvedAt && a.kind !== 'request')) {
      const info = item.consoleId ? this.manager.get(item.consoleId) : undefined;
      const stillTrue =
        info && ((item.kind === 'needs_you' && info.status === 'needs_you') || (item.kind === 'error' && info.status === 'error'));
      if (!stillTrue) this.resolve(item, 'auto');
    }
    this.cap();
  }

  private resolveOpen(consoleId: string, kind: ActionKind): void {
    const item = this.open(consoleId, kind);
    if (!item) return;
    this.resolve(item, 'auto');
    this.cap();
  }

  private add(consoleId: string | null, kind: ActionKind, title: string, detail?: string): ActionItem {
    const item: ActionItem = {
      id: crypto.randomUUID(),
      consoleId,
      kind,
      title: clip(title, MAX_TITLE),
      createdAt: Date.now(),
    };
    if (detail?.trim()) item.detail = clip(detail.trim(), MAX_DETAIL);
    this.actions.push(item);
    this.changed(item);
    return item;
  }

  private resolve(item: ActionItem, by: 'auto' | 'user'): void {
    item.resolvedAt = Date.now();
    item.resolvedBy = by;
    this.changed(item);
  }

  private changed(item: ActionItem): void {
    this.manager.emit('action', item);
    this.manager.persist();
  }

  // Keeps at most MAX_RESOLVED_ACTIONS resolved items, dropping the oldest resolved first
  private cap(): void {
    const resolved = this.actions.filter((a) => a.resolvedAt);
    const excess = resolved.length - MAX_RESOLVED_ACTIONS;
    if (excess <= 0) return;
    const oldest = [...resolved].sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
    this.removeIds(oldest.slice(0, excess).map((a) => a.id));
  }

  private removeIds(ids: string[]): void {
    if (!ids.length) return;
    const drop = new Set(ids);
    for (let i = this.actions.length - 1; i >= 0; i--) {
      if (drop.has(this.actions[i].id)) this.actions.splice(i, 1);
    }
    this.manager.emit('actions-removed', ids);
    this.manager.persist();
  }
}
