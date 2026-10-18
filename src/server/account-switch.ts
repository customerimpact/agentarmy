import crypto from 'node:crypto';
import type { Account, AccountSwitchEvent, ActionItem, ConsoleInfo, ServerMessage } from '../shared/protocol.js';
import { DEFAULT_ACCOUNT_ID, copyTranscript, type AccountStore } from './accounts.js';
import { setAccountActionHandler } from './actions.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import { formatReset, limitFromHook, parseLimitText, type LimitInfo } from './limit-parser.js';
import { stripAnsi } from './prompt-detector.js';

// Automatic account switching when a console hits its plan limit.
//
// A limit counts when the console itself hits it: a StopFailure / Notification hook that says so,
// or a "You've hit your ... limit" banner printed while it works (or within a couple of minutes of
// its last prompt). Banners in the replayed history of a resumed conversation never count.
// Then: its account is marked limited (until the reset time), and with auto-switch 'on' the console
// moves to the highest-priority account that is ok: its transcript is copied into that account's
// projects/ folder, it restarts with --resume on the new CLAUDE_CONFIG_DIR, and the interrupted
// prompt (or "Continue where you left off.") is sent again once it is ready. 'ask' files an Actions
// item with a Switch button instead; 'off' only marks the account.
// Other consoles on a limited account are left alone until they hit the limit themselves, so
// nothing restarts behind the user's back. 'needs_login' accounts are never switched to.

const TAIL_LIMIT = 3000;
const RECENT_PROMPT_MS = 2 * 60 * 1000;
const HIT_DEBOUNCE_MS = 10_000;
const RESEND_DELAY_MS = 1500;
// Let the failing turn's last hooks (StopFailure) land before the process is replaced
const SWITCH_DELAY_MS = 800;
const MAX_TITLE = 120;
export const CONTINUE_PROMPT = 'Continue where you left off.';

export interface SwitcherOptions {
  manager: ConsoleManager;
  store: AccountStore;
  broadcast: (msg: ServerMessage) => void;
  now?: () => number;
  resendDelayMs?: number;
  switchDelayMs?: number;
}

interface PendingResend {
  text: string | null; // null = nothing to send (fresh conversation, prompt unknown)
  oldSessionId: string;
  from: Account;
  to: Account;
}

export type SwitchPlan =
  | { action: 'switch'; to: Account }
  | { action: 'ask'; to: Account }
  | { action: 'none'; reason: 'off' | 'no-account' };

// Pure decision: what to do for a console whose account just hit its limit
export function planSwitch(mode: 'on' | 'ask' | 'off', candidates: Account[], fromId: string): SwitchPlan {
  if (mode === 'off') return { action: 'none', reason: 'off' };
  const to = candidates.find((a) => a.id !== fromId && a.status === 'ok');
  if (!to) return { action: 'none', reason: 'no-account' };
  return { action: mode === 'ask' ? 'ask' : 'switch', to };
}

export class AccountSwitcher {
  private readonly now: () => number;
  private tails = new Map<string, string>();
  private prompts = new Map<string, { text: string; at: number; done: boolean }>();
  private transcripts = new Map<string, string>();
  private lastHit = new Map<string, number>();
  private lastWarning = new Map<string, string>();
  private pending = new Map<string, PendingResend>();
  private switching = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: SwitcherOptions) {
    this.now = options.now ?? Date.now;
    const { manager } = options;
    manager.on('output', (id, data) => this.onOutput(id, data));
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('console', (info) => this.onConsole(info));
    manager.on('removed', (id) => this.forget(id));
    setAccountActionHandler(manager, (item, key) => this.answer(item, key));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private forget(id: string): void {
    this.tails.delete(id);
    this.prompts.delete(id);
    this.transcripts.delete(id);
    this.lastHit.delete(id);
    this.lastWarning.delete(id);
    this.pending.delete(id);
    this.switching.delete(id);
  }

  private accountOf(info: ConsoleInfo): string {
    return info.accountId && info.accountId !== 'auto' ? info.accountId : DEFAULT_ACCOUNT_ID;
  }

  // ---------- inputs ----------

  onOutput(id: string, data: string): void {
    const plain = stripAnsi(data);
    const tail = ((this.tails.get(id) ?? '') + plain).slice(-TAIL_LIMIT);
    this.tails.set(id, tail);
    if (!/limit/i.test(tail)) return;
    const info = this.options.manager.get(id);
    if (!info || info.role === 'Login') return;
    const limit = parseLimitText(tail, this.now());
    if (!limit) return;
    if (limit.kind === 'warning') {
      this.tails.set(id, '');
      this.noteWarning(id, info, limit);
      return;
    }
    // Only a console that is (or just was) working can hit a limit; old banners in a replayed
    // conversation show up while it is starting or idle and are ignored
    const prompt = this.prompts.get(id);
    const recent = prompt && this.now() - prompt.at < RECENT_PROMPT_MS;
    if (info.status !== 'working' && !recent) return;
    this.tails.set(id, '');
    this.onLimitHit(id, limit);
  }

  onHook(id: string, payload: HookPayload): void {
    const event = payload.hook_event_name;
    const file = (payload as Record<string, unknown>).transcript_path;
    if (typeof file === 'string' && file.endsWith('.jsonl')) this.transcripts.set(id, file);
    if (event === 'UserPromptSubmit') {
      const text = typeof payload.prompt === 'string' ? payload.prompt : '';
      this.prompts.set(id, { text, at: this.now(), done: false });
    } else if (event === 'Stop') {
      const p = this.prompts.get(id);
      if (p) p.done = true;
    } else if (event === 'SessionStart') {
      this.onReady(id);
    }
    const info = this.options.manager.get(id);
    if (!info || info.role === 'Login') return;
    const limit = limitFromHook(payload, this.now());
    if (!limit) return;
    if (limit.kind === 'warning') this.noteWarning(id, info, limit);
    else this.onLimitHit(id, limit);
  }

  private noteWarning(id: string, info: ConsoleInfo, limit: LimitInfo): void {
    if (limit.percent === undefined || (limit.window !== 'session' && limit.window !== 'weekly')) return;
    const key = `${limit.window}:${limit.percent}:${limit.resetsAt ?? ''}`;
    if (this.lastWarning.get(id) === key) return;
    this.lastWarning.set(id, key);
    this.options.store.setUtilization(this.accountOf(info), limit.window, limit.percent, limit.resetsAt);
  }

  // ---------- limit hit ----------

  onLimitHit(id: string, limit: LimitInfo): void {
    const { manager, store } = this.options;
    const info = manager.get(id);
    if (!info || this.pending.has(id) || this.switching.has(id)) return;
    const last = this.lastHit.get(id) ?? 0;
    if (this.now() - last < HIT_DEBOUNCE_MS) return;
    this.lastHit.set(id, this.now());
    const fromId = this.accountOf(info);
    const from = store.markLimited(fromId, { resetsAt: limit.resetsAt, label: limit.label });
    if (!from) return;
    const until = from.limitResetsAt ? ` until ${formatReset(from.limitResetsAt, this.now())}` : '';
    const plan = planSwitch(store.autoSwitch, store.list(), fromId);
    if (plan.action === 'none') {
      const why =
        plan.reason === 'off'
          ? 'Auto-switch is off (Settings › Accounts).'
          : 'No other account is available: add one or log in to one in Settings › Accounts.';
      this.fileAction(id, `${from.name} hit its ${limit.label}${until}`, `${info.name} is waiting. ${why}`);
      return;
    }
    if (plan.action === 'ask') {
      const item = this.fileAction(
        id,
        `${info.name}: ${from.name} hit its ${limit.label}${until}`,
        `Switch ${info.name} to ${plan.to.name} and continue the conversation there?`,
      );
      item.options = [
        { key: `switch:${plan.to.id}`, label: `Switch to ${plan.to.name}` },
        { key: 'dismiss', label: 'Not now' },
      ];
      manager.emit('action', item);
      manager.persist();
      return;
    }
    this.switching.add(id);
    this.later(this.options.switchDelayMs ?? SWITCH_DELAY_MS, () => {
      this.switching.delete(id);
      // Picked again: another console may have used up that account in the meantime
      const again = planSwitch(this.options.store.autoSwitch, this.options.store.list(), fromId);
      if (again.action === 'switch') this.switchConsole(id, again.to.id);
    });
  }

  private answer(item: ActionItem, key: string): void {
    const { manager } = this.options;
    if (key === 'dismiss') {
      this.resolve(item);
      return;
    }
    const match = /^switch:(.+)$/.exec(key);
    if (!match || !item.consoleId) throw new Error(`Unknown option ${key}`);
    const target = this.options.store.get(match[1]);
    if (!target || target.status !== 'ok') throw new Error(`${target?.name ?? 'That account'} is not available right now`);
    this.resolve(item);
    if (!manager.get(item.consoleId)) throw new Error('The console is gone');
    this.switchConsole(item.consoleId, target.id);
  }

  // Moves one console to another account and resumes its conversation there
  switchConsole(id: string, toId: string): AccountSwitchEvent | null {
    const { manager, store } = this.options;
    const info = manager.get(id);
    const to = store.get(toId);
    if (!info || !to) return null;
    const fromId = this.accountOf(info);
    const from = store.get(fromId);
    if (!from || from.id === to.id) return null;
    if (to.status === 'needs_login') throw new Error(`${to.name} needs a login first`);

    const copy = copyTranscript({
      fromDir: from.configDir,
      toDir: to.configDir,
      cwd: info.cwd,
      sessionId: info.sessionId,
      sourceFile: this.transcripts.get(id),
    });
    const prompt = this.prompts.get(id);
    const interrupted = prompt && !prompt.done ? prompt.text.trim() : '';
    this.pending.set(id, {
      // Resumed: repeat the interrupted prompt, else nudge it on. Fresh conversation: only a known prompt.
      text: interrupted || (copy.copied ? CONTINUE_PROMPT : null),
      oldSessionId: info.sessionId,
      from,
      to,
    });
    this.prompts.delete(id);
    this.tails.set(id, '');

    info.accountId = to.id;
    store.touch(to.id);
    manager.restart(id);
    const until = from.limitResetsAt ? ` (${from.name} limited until ${formatReset(from.limitResetsAt, this.now())})` : '';
    const live = manager.get(id);
    if (live && live.status !== 'exited') {
      live.statusDetail = copy.copied
        ? `Switched from ${from.name} to ${to.name}${until}`
        : `Switched from ${from.name} to ${to.name}${until}; the conversation could not be copied (${copy.reason ?? 'unknown'})`;
      manager.touch(id);
    }
    const event: AccountSwitchEvent = {
      consoleId: id,
      consoleName: info.name,
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      ...(from.limitResetsAt ? { resetsAt: from.limitResetsAt } : {}),
      at: this.now(),
    };
    this.options.broadcast({ type: 'account-switch', event });
    const item = this.fileAction(id, `${info.name} switched from ${from.name} to ${to.name}${until}`, undefined);
    item.resolvedAt = this.now(); // informational: shows in the inbox history, nothing to do
    item.resolvedBy = 'auto';
    manager.emit('action', item);
    manager.persist();
    return event;
  }

  // The relaunched console is ready: send the interrupted prompt
  private onReady(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const text = pending.text;
    if (!text) return;
    this.later(this.options.resendDelayMs ?? RESEND_DELAY_MS, () => {
      if (this.options.manager.get(id)) this.options.manager.sendText(id, text);
    });
  }

  // The resume fallback started a new conversation: say so plainly
  private onConsole(info: ConsoleInfo): void {
    const pending = this.pending.get(info.id);
    if (!pending || info.sessionId === pending.oldSessionId) return;
    if (!info.statusDetail?.startsWith('Could not resume')) return;
    info.statusDetail = `Switched to ${pending.to.name}, but the conversation could not be resumed there; started a new one`;
    // A fresh conversation has no context for "Continue where you left off."
    if (pending.text === CONTINUE_PROMPT) pending.text = null;
    this.options.manager.touch(info.id);
  }

  // ---------- inbox ----------

  private fileAction(consoleId: string, title: string, detail: string | undefined): ActionItem {
    const { manager } = this.options;
    const clipped = title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
    // One open account item per console: a newer one replaces it
    for (const old of manager.actions.filter((a) => a.kind === 'account' && a.consoleId === consoleId && !a.resolvedAt)) {
      this.resolve(old);
    }
    const item: ActionItem = { id: crypto.randomUUID(), consoleId, kind: 'account', title: clipped, createdAt: this.now() };
    if (detail) item.detail = detail;
    manager.actions.push(item);
    manager.emit('action', item);
    manager.persist();
    return item;
  }

  private resolve(item: ActionItem): void {
    item.resolvedAt = this.now();
    item.resolvedBy = 'user';
    this.options.manager.emit('action', item);
    this.options.manager.persist();
  }
}
