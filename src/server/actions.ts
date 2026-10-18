import crypto from 'node:crypto';
import type { ActionItem, ActionKind, AnswerActionRequest, ConsoleInfo } from '../shared/protocol.js';
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
const MAX_ANSWER = 4000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 'account' items ("Switch to Personal?") are answered by the accounts feature (account-switch.ts)
const accountActionHandlers = new WeakMap<ConsoleManager, (item: ActionItem, key: string) => void>();

export function setAccountActionHandler(manager: ConsoleManager, handler: (item: ActionItem, key: string) => void): void {
  accountActionHandlers.set(manager, handler);
}

export class ActionInbox {
  constructor(private readonly manager: ConsoleManager) {
    manager.on('console', (info) => this.onConsole(info));
    manager.on('removed', (id) => this.onRemoved(id));
    manager.on('dialog', (id) => this.onDialog(id));
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
      if (!existing) {
        const item = this.add(info.id, 'needs_you', `${info.name} needs you`, info.statusDetail, false);
        this.applyDialog(item);
        this.changed(item);
      } else if (info.statusDetail && existing.detail !== info.statusDetail) {
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

  // The dialog on screen changed while the console waits: refresh the answer buttons
  private onDialog(consoleId: string): void {
    const item = this.open(consoleId, 'needs_you');
    if (item && this.applyDialog(item)) this.changed(item);
  }

  // Copies the parsed dialog onto a needs_you item; returns true when something changed
  private applyDialog(item: ActionItem): boolean {
    const before = JSON.stringify([item.question, item.options, item.allowText, item.context]);
    const dialog = item.consoleId ? this.manager.dialogFor(item.consoleId) : null;
    delete item.question;
    delete item.options;
    delete item.allowText;
    delete item.context;
    if (dialog) {
      if (dialog.question) item.question = clip(dialog.question, MAX_TITLE * 2);
      item.options = dialog.options.map((o) => ({ key: o.key, label: clip(o.label, MAX_TITLE) }));
      if (dialog.allowText) item.allowText = true;
      if (dialog.context.length) item.context = dialog.context.map((l) => clip(l, 300));
    }
    return before !== JSON.stringify([item.question, item.options, item.allowText, item.context]);
  }

  // Answers a needs_you item from the inbox. The item resolves itself once the console moves on.
  answer(id: string, body: AnswerActionRequest): ActionItem {
    const item = this.actions.find((a) => a.id === id);
    if (!item) throw new NotFoundError(`Unknown action ${id}`);
    if (item.resolvedAt) throw new Error('This item is already resolved');
    if (item.kind === 'stuck') {
      if (!body.key || !this.stuckHandler) throw new Error('key is required');
      this.stuckHandler(item, body.key);
      return item;
    }
    const handler = item.kind === 'account' ? accountActionHandlers.get(this.manager) : undefined;
    if (handler) {
      if (!body.key) throw new Error('key is required');
      handler(item, body.key);
      return item;
    }
    if (item.kind !== 'needs_you' || !item.consoleId) throw new Error('Only waiting consoles can be answered');
    const key = typeof body.key === 'string' && body.key ? body.key : undefined;
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_ANSWER) : '';
    if (!key && !text) throw new Error('key or text is required');
    const options = item.options ?? [];
    if (key && key !== 'esc' && !options.some((o) => o.key === key)) throw new Error(`Unknown option ${key}`);
    if (text && !key && options.length && !item.allowText) throw new Error('This dialog does not take a typed answer');
    const textKey = text && !key && options.length ? this.manager.dialogFor(item.consoleId)?.textKey : undefined;
    const sent = this.manager.answerPrompt(item.consoleId, { key: key ?? textKey, ...(text ? { text } : {}) });
    if (!sent) throw new Error('The console is not running');
    return item;
  }

  // Set by StuckWatcher: handles Nudge / Interrupt / Ignore on 'stuck' items
  stuckHandler: ((item: ActionItem, key: string) => void) | null = null;

  openStuck(consoleId: string, title: string, detail: string): ActionItem {
    const existing = this.open(consoleId, 'stuck');
    if (existing) {
      existing.title = clip(title, MAX_TITLE);
      existing.detail = clip(detail, MAX_DETAIL);
      this.changed(existing);
      return existing;
    }
    const item = this.add(consoleId, 'stuck', title, detail, false);
    item.options = [
      { key: 'nudge', label: 'Nudge' },
      { key: 'interrupt', label: 'Interrupt' },
      { key: 'ignore', label: 'Ignore 30 min' },
    ];
    this.changed(item);
    return item;
  }

  openStuckFor(consoleId: string): ActionItem | undefined {
    return this.open(consoleId, 'stuck');
  }

  resolveStuck(consoleId: string, by: 'auto' | 'user' = 'auto'): void {
    const item = this.open(consoleId, 'stuck');
    if (!item) return;
    this.resolve(item, by);
    this.cap();
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
        // stuck items are never carried over a restart: the watcher re-opens them if still true
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

  private add(consoleId: string | null, kind: ActionKind, title: string, detail?: string, announce = true): ActionItem {
    const item: ActionItem = {
      id: crypto.randomUUID(),
      consoleId,
      kind,
      title: clip(title, MAX_TITLE),
      createdAt: Date.now(),
    };
    if (detail?.trim()) item.detail = clip(detail.trim(), MAX_DETAIL);
    this.actions.push(item);
    if (announce) this.changed(item);
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
