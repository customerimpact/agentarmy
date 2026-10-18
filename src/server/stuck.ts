import crypto from 'node:crypto';
import type { ActionItem, AppSettings, ConsoleInfo } from '../shared/protocol.js';
import type { ActionInbox } from './actions.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import { stripAnsi } from './prompt-detector.js';

// Stuck-agent alerts: a working console that (a) shows no new output and fires no hooks for a while,
// (b) repeats the exact same tool call many times in a row, or (c) runs one turn for very long.
// Each opens a 'stuck' action with Nudge / Interrupt / Ignore buttons; it resolves itself on progress.

export const NUDGE_TEXT = 'Status check: are you stuck? Summarize progress in one line and continue.';
export const LOOP_LIMIT = 5;
export const SNOOZE_MS = 30 * 60_000;
const CHECK_MS = 15_000;
const SEEN_FRAMES = 32; // spinner frames repeat; only text we have not seen lately counts as progress
const MINUTE = 60_000;

type Reason = 'looping' | 'stalled' | 'long';
const PRIORITY: Record<Reason, number> = { looping: 3, stalled: 2, long: 1 };

export type StuckSettings = Pick<AppSettings, 'stuckAlerts' | 'stallMinutes' | 'longTurnMinutes'>;

interface Track {
  status: ConsoleInfo['status'] | null;
  progressAt: number;
  turnStartedAt: number | null;
  lastCall: string | null;
  lastCallLabel: string;
  streak: number;
  reason: Reason | null; // reason of the open item
  alerted: Set<Reason>; // raised in this episode (so "Done" in the inbox is not undone a moment later)
  snoozeUntil: number;
  seen: string[];
}

// Letters only: drops the spinner glyph, the elapsed seconds and the token counter
export function normalizeOutput(data: string): string {
  return stripAnsi(data).replace(/[^A-Za-z]+/g, ' ').trim();
}

function callHash(payload: HookPayload): string {
  const input = JSON.stringify(payload.tool_input ?? null);
  return crypto.createHash('sha1').update(`${String(payload.tool_name)}\0${input}`).digest('hex');
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / MINUTE));
}

export interface StuckOptions {
  now?: () => number;
  checkMs?: number;
}

export class StuckWatcher {
  private readonly tracks = new Map<string, Track>();
  private readonly listeners = new Map<string, (data: string) => void>();
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(
    private readonly manager: ConsoleManager,
    private readonly inbox: ActionInbox,
    private readonly settings: () => StuckSettings,
    options: StuckOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    manager.on('console', (info) => this.onConsole(info));
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('removed', (id) => {
      this.tracks.delete(id);
      this.listeners.delete(id);
    });
    inbox.stuckHandler = (item, key) => this.act(item, key);
    for (const info of manager.list()) this.onConsole(info);
    this.timer = setInterval(() => this.check(), options.checkMs ?? CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        status: null,
        progressAt: this.now(),
        turnStartedAt: null,
        lastCall: null,
        lastCallLabel: '',
        streak: 0,
        reason: null,
        alerted: new Set(),
        snoozeUntil: 0,
        seen: [],
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  private onConsole(info: ConsoleInfo): void {
    const t = this.track(info.id);
    if (!this.listeners.has(info.id)) {
      const listener = (data: string): void => this.onOutput(info.id, data);
      try {
        this.manager.attach(info.id, listener);
        this.listeners.set(info.id, listener);
      } catch {
        // console vanished between the event and now
      }
    }
    const was = t.status;
    t.status = info.status;
    if (info.status === 'working') {
      if (was !== 'working') {
        t.progressAt = this.now();
        t.turnStartedAt ??= this.now();
      }
      return;
    }
    // Waiting on the user, done, failed or gone: nothing is stuck any more
    t.turnStartedAt = null;
    t.streak = 0;
    t.lastCall = null;
    t.alerted.clear();
    this.clear(info.id, t);
  }

  private onOutput(id: string, data: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    const text = normalizeOutput(data);
    if (text.length < 3 || t.seen.includes(text)) return;
    t.seen.push(text);
    if (t.seen.length > SEEN_FRAMES) t.seen.shift();
    this.progress(id, t);
  }

  onHook(id: string, payload: HookPayload): void {
    const t = this.tracks.get(id);
    if (!t) return;
    const event = payload.hook_event_name;
    if (event === 'UserPromptSubmit') {
      t.turnStartedAt = this.now();
      t.streak = 0;
      t.lastCall = null;
      t.alerted.delete('long');
      t.alerted.delete('looping');
    }
    if (event === 'PreToolUse' && typeof payload.tool_name === 'string') {
      const hash = callHash(payload);
      if (hash === t.lastCall) t.streak++;
      else {
        t.lastCall = hash;
        t.streak = 1;
        t.alerted.delete('looping');
        if (t.reason === 'looping') this.clear(id, t);
      }
      t.lastCallLabel = this.manager.get(id)?.activity ?? payload.tool_name;
    }
    this.progress(id, t);
    if (event === 'PreToolUse' && t.streak >= LOOP_LIMIT) this.raise(id, t, 'looping');
  }

  private progress(id: string, t: Track): void {
    t.progressAt = this.now();
    t.alerted.delete('stalled');
    if (t.reason === 'stalled') this.clear(id, t);
  }

  check(): void {
    const s = this.settings();
    const now = this.now();
    for (const info of this.manager.list()) {
      const t = this.tracks.get(info.id);
      if (!t) continue;
      if (!s.stuckAlerts) {
        this.clear(info.id, t);
        continue;
      }
      if (info.status !== 'working') continue;
      if (now - t.progressAt >= s.stallMinutes * MINUTE) this.raise(info.id, t, 'stalled');
      if (t.turnStartedAt !== null && now - t.turnStartedAt >= s.longTurnMinutes * MINUTE) {
        this.raise(info.id, t, 'long');
      }
    }
  }

  private raise(id: string, t: Track, reason: Reason): void {
    const s = this.settings();
    const info = this.manager.get(id);
    if (!s.stuckAlerts || !info || info.status !== 'working') return;
    if (this.now() < t.snoozeUntil || t.alerted.has(reason)) return;
    if (t.reason && PRIORITY[t.reason] >= PRIORITY[reason] && this.inbox.openStuckFor(id)) return;
    t.alerted.add(reason);
    t.reason = reason;
    const last = info.activity ? ` Last activity: ${info.activity}.` : '';
    const now = this.now();
    const text: Record<Reason, [string, string]> = {
      looping: [
        `${info.name} may be looping`,
        `Made the same tool call ${t.streak} times in a row: ${t.lastCallLabel}.`,
      ],
      stalled: [
        `${info.name} seems stalled`,
        `Working, but no new output and no tool activity for ${minutes(now - t.progressAt)} min.${last}`,
      ],
      long: [
        `${info.name} has been working for ${minutes(now - (t.turnStartedAt ?? now))} min`,
        `This turn has run longer than ${s.longTurnMinutes} min.${last}`,
      ],
    };
    this.inbox.openStuck(id, ...text[reason]);
  }

  private clear(id: string, t: Track): void {
    t.reason = null;
    this.inbox.resolveStuck(id);
  }

  // Buttons on a stuck item
  private act(item: ActionItem, key: string): void {
    const id = item.consoleId;
    if (!id) throw new Error('This item has no console');
    const t = this.track(id);
    if (key === 'nudge') {
      if (!this.manager.sendText(id, NUDGE_TEXT)) throw new Error('The console is not running');
    } else if (key === 'interrupt') {
      if (!this.manager.get(id)) throw new Error('The console is not running');
      this.manager.input(id, '\x1b');
    } else if (key === 'ignore') {
      t.snoozeUntil = this.now() + SNOOZE_MS;
    } else {
      throw new Error(`Unknown option ${key}`);
    }
    // Start counting again from now so the same alert does not fire right back
    t.progressAt = this.now();
    if (t.turnStartedAt !== null) t.turnStartedAt = this.now();
    t.streak = 0;
    t.lastCall = null;
    t.alerted.clear();
    t.reason = null;
    this.inbox.resolveStuck(id, 'user');
  }
}
