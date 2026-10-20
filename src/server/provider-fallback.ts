import crypto from 'node:crypto';
import type { Account, ActionItem, AppSettings, ConsoleInfo, LimitFallbackMode } from '../shared/protocol.js';
import { AGENT_META, type AgentKind } from '../shared/agents.js';
import type { AccountStore } from './accounts.js';
import type { ConsoleManager } from './consoles.js';
import { formatReset } from './limit-parser.js';
import { parseAgentLimitText } from './agent-limits.js';
import type { SwitchAgentService } from './switch-agent.js';
import { detectAgents } from './agents/index.js';
import { defaultProviderDir, detectLogin } from './agents/providers.js';
import { providerKey } from './settings.js';
import { providerOfAgent } from '../shared/providers.js';

// Cross-provider fallback on plan limits.
//
// Claude: when a Claude console hits its limit and no other Claude account is ok (account-switch.ts
// asks us via onClaudeLimited), the setting "When all Claude accounts are limited" decides:
//   'ask' (default) -> an Actions item "Continue on Codex" / "Wait"
//   'switch'        -> switch-agent to settings.limitFallbackAgent (Codex by default) with a quick brief
//                      plus "Continue the task.", and an Actions item saying so
//   'wait'          -> an Actions item that it waits for the reset
// The fallback CLI must be installed and logged in (readiness()), else we wait and say why.
// The new console carries fallbackFrom { agent: 'claude', resetsAt }; once a Claude account is ok again
// (account store change, or the reset time passed) an Actions item offers "Switch back to Claude".
//
// Other CLIs: Codex / Gemini CLI / Grok / OpenCode limit messages are read from their terminal
// output (agent-limits.ts, best effort). The same setting then moves the console to Claude when an
// account is ok, else to the fallback CLI if that is a different one.

export const CONTINUE_TASK = 'Continue the task.';
const SWITCH_DELAY_MS = 800;
const CHECK_MS = 30_000;
const HIT_DEBOUNCE_MS = 60_000;
const RECENT_WORK_MS = 2 * 60_000;
const TAIL_LIMIT = 3000;
const MAX_TITLE = 120;
const UNKNOWN_RESET_MS = 60 * 60_000;

export interface Readiness {
  ready: boolean;
  why?: string; // e.g. 'Codex CLI is not installed' / 'not logged in'
}

export type FallbackPlan =
  | { action: 'switch' | 'ask'; agent: AgentKind }
  | { action: 'wait'; reason: 'setting' | 'unavailable'; agent?: AgentKind; why?: string };

export interface PlanInput {
  mode: LimitFallbackMode;
  source: AgentKind; // the CLI that hit its limit
  preferred: AgentKind; // settings.limitFallbackAgent
  claudeAvailable: boolean; // some Claude account is ok
  readiness: Partial<Record<AgentKind, Readiness>>; // for the candidates
}

// Candidates in order: from Claude -> the preferred CLI; from another CLI -> Claude, then the preferred CLI
export function fallbackCandidates(source: AgentKind, preferred: AgentKind): AgentKind[] {
  const list: AgentKind[] = source === 'claude' ? [preferred] : ['claude', preferred];
  return [...new Set(list)].filter((a) => a !== source && a !== 'custom');
}

// Pure decision: where (if anywhere) a limited console continues
export function planFallback(input: PlanInput): FallbackPlan {
  if (input.mode === 'wait') return { action: 'wait', reason: 'setting' };
  const candidates = fallbackCandidates(input.source, input.preferred);
  const ready = (a: AgentKind): Readiness =>
    a === 'claude' ? { ready: input.claudeAvailable, why: 'every Claude account is limited' } : (input.readiness[a] ?? { ready: false });
  const pick = candidates.find((a) => ready(a).ready);
  if (!pick) {
    const first = candidates[0];
    return { action: 'wait', reason: 'unavailable', ...(first ? { agent: first, why: ready(first).why } : {}) };
  }
  return { action: input.mode === 'switch' ? 'switch' : 'ask', agent: pick };
}

// Is the provider that ran out usable again?
export function shouldOfferSwitchBack(from: NonNullable<ConsoleInfo['fallbackFrom']>, claudeAvailable: boolean, now: number): boolean {
  if (from.offered) return false;
  if (from.agent === 'claude') return claudeAvailable;
  return now >= (from.resetsAt ?? from.at + UNKNOWN_RESET_MS);
}

// Installed (Settings › Agents path or PATH) and logged in (the providers hub's file / env check)
export async function agentReadiness(agent: AgentKind, settings: AppSettings): Promise<Readiness> {
  const label = AGENT_META[agent].label;
  const found = (await detectAgents(settings)).agents.find((a) => a.id === agent);
  if (!found?.installed) return { ready: false, why: `${label} is not installed` };
  const provider = providerOfAgent(agent);
  if (!provider || provider === 'claude') return { ready: true };
  const login = detectLogin(provider, defaultProviderDir(provider), { savedKey: provider === 'grok' && !!providerKey(settings, 'grok') });
  return login.loggedIn ? { ready: true } : { ready: false, why: `${label} is not logged in (Settings › Agents & logins)` };
}

export interface ProviderFallbackOptions {
  manager: ConsoleManager;
  store: AccountStore;
  switcher: SwitchAgentService;
  settings: () => AppSettings;
  readiness: (agent: AgentKind) => Promise<Readiness>;
  now?: () => number;
  switchDelayMs?: number;
  checkMs?: number; // 0 = no timer (tests call check())
}

function short(agent: AgentKind): string {
  return AGENT_META[agent].short;
}

export class ProviderFallback {
  private readonly now: () => number;
  private tails = new Map<string, string>();
  private lastHit = new Map<string, number>();
  private busy = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly options: ProviderFallbackOptions) {
    this.now = options.now ?? Date.now;
    const { manager, store } = options;
    manager.on('output', (id, data) => this.onOutput(id, data));
    manager.on('removed', (id) => {
      this.tails.delete(id);
      this.lastHit.delete(id);
      this.busy.delete(id);
    });
    store.on('change', () => this.check());
    const ms = options.checkMs ?? CHECK_MS;
    if (ms > 0) {
      this.interval = setInterval(() => this.check(), ms);
      this.interval.unref?.();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
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

  private claudeAvailable(): boolean {
    return this.options.store.list().some((a) => a.status === 'ok');
  }

  private async plan(source: AgentKind): Promise<FallbackPlan> {
    const settings = this.options.settings();
    const preferred = settings.limitFallbackAgent ?? 'codex';
    const readiness: PlanInput['readiness'] = {};
    for (const agent of fallbackCandidates(source, preferred)) {
      if (agent === 'claude') continue;
      try {
        readiness[agent] = await this.options.readiness(agent);
      } catch (err) {
        readiness[agent] = { ready: false, why: err instanceof Error ? err.message : String(err) };
      }
    }
    return planFallback({ mode: settings.limitFallback ?? 'ask', source, preferred, claudeAvailable: this.claudeAvailable(), readiness });
  }

  // ---------- Claude limit (called by account-switch.ts when no Claude account is left) ----------

  // Always takes over the Actions item for this hit; returns true
  onClaudeLimited(consoleId: string, from: Account, label: string): boolean {
    const info = this.options.manager.get(consoleId);
    if (!info) return false;
    const resetsAt = from.limitResetsAt;
    const until = resetsAt ? ` until ${formatReset(resetsAt, this.now())}` : '';
    void this.decide(info, 'claude', `every Claude account is limited (${from.name} hit its ${label}${until})`, resetsAt);
    return true;
  }

  // ---------- other CLIs ----------

  onOutput(id: string, data: string): void {
    const { manager } = this.options;
    const info = manager.get(id);
    const agent = info?.agent ?? 'claude';
    if (!info || agent === 'claude' || agent === 'custom' || info.role === 'Login') return;
    const tail = ((this.tails.get(id) ?? '') + data).slice(-TAIL_LIMIT);
    this.tails.set(id, tail);
    if (!/limit|quota|credits|429|too many|exhausted/i.test(tail)) return;
    const limit = parseAgentLimitText(agent, tail, this.now());
    if (!limit) return;
    this.tails.set(id, '');
    // Only a console that is (or just was) working: banners replayed while it starts do not count
    const recent = this.now() - info.statusChangedAt < RECENT_WORK_MS;
    if (info.status === 'starting' || (info.status !== 'working' && !recent)) return;
    const last = this.lastHit.get(id) ?? 0;
    if (this.now() - last < HIT_DEBOUNCE_MS) return;
    this.lastHit.set(id, this.now());
    const until = limit.resetsAt ? ` until ${formatReset(limit.resetsAt, this.now())}` : '';
    void this.decide(info, agent, `${AGENT_META[agent].label} hit its ${limit.label.replace(/^\w+ /, '')}${until}`, limit.resetsAt);
  }

  // ---------- decision ----------

  private async decide(info: ConsoleInfo, source: AgentKind, why: string, resetsAt?: number): Promise<void> {
    if (this.busy.has(info.id) || this.options.switcher.isSwitching(info.id)) return;
    this.busy.add(info.id);
    try {
      const plan = await this.plan(source);
      if (!this.options.manager.get(info.id)) return;
      if (plan.action === 'wait') {
        const detail =
          plan.reason === 'setting'
            ? `${info.name} waits for the reset (Settings › Accounts › When all Claude accounts are limited: Wait).`
            : plan.agent
              ? `${info.name} waits: ${AGENT_META[plan.agent].label} is not available to continue (${plan.why ?? 'not ready'}).`
              : `${info.name} waits for the reset.`;
        this.fileAction(info.id, `${info.name}: ${why}`, detail);
        return;
      }
      if (plan.action === 'ask') {
        this.fileAction(
          info.id,
          `${info.name}: ${why}`,
          `Continue on ${AGENT_META[plan.agent].label}? ${info.name} gets a handoff brief there and carries on; you can switch back when ${short(source)} is available again.`,
          [
            { key: `fallback:${plan.agent}`, label: `Continue on ${short(plan.agent)}` },
            { key: 'dismiss', label: 'Wait' },
          ],
        );
        return;
      }
      const agent = plan.agent;
      this.later(this.options.switchDelayMs ?? SWITCH_DELAY_MS, () => {
        void this.switchTo(info.id, agent, source, resetsAt, why);
      });
    } finally {
      this.busy.delete(info.id);
    }
  }

  private async switchTo(consoleId: string, agent: AgentKind, source: AgentKind, resetsAt: number | undefined, why: string): Promise<ConsoleInfo | null> {
    const { manager } = this.options;
    const info = manager.get(consoleId);
    if (!info) return null;
    // Asked first: the earliest Claude reset is when switching back makes sense
    if (!resetsAt && source === 'claude') {
      const resets = this.options.store.list().map((a) => a.limitResetsAt ?? 0).filter((t) => t > this.now());
      if (resets.length) resetsAt = Math.min(...resets);
    }
    try {
      const res = await this.options.switcher.switchAgent(consoleId, {
        agent,
        closeOld: true,
        briefMode: 'quick', // claude -p would use the limited plan; the quick brief is free
        continuePrompt: CONTINUE_TASK,
        fallbackFrom: {
          agent: source,
          ...(source === 'claude' && info.accountId && info.accountId !== 'auto' ? { accountId: info.accountId } : {}),
          ...(resetsAt ? { resetsAt } : {}),
          at: this.now(),
        },
      });
      this.fileAction(
        res.console.id,
        `${info.name} continued on ${short(agent)}: ${why}`,
        `GridHive moved ${info.name} to ${AGENT_META[agent].label} with a handoff brief. You will be offered to switch back once ${short(source)} is available again.`,
        [{ key: 'dismiss', label: 'OK' }],
      );
      return res.console;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fileAction(consoleId, `${info.name}: could not continue on ${short(agent)}`, message);
      return null;
    }
  }

  // ---------- switch back ----------

  check(): void {
    const { manager } = this.options;
    const claudeOk = this.claudeAvailable();
    const now = this.now();
    for (const info of manager.list()) {
      const from = info.fallbackFrom;
      if (!from || !shouldOfferSwitchBack(from, claudeOk, now)) continue;
      from.offered = true;
      manager.touch(info.id);
      this.fileAction(
        info.id,
        `${short(from.agent)} is available again: switch ${info.name} back?`,
        `${info.name} moved to ${short(info.agent ?? 'claude')} when ${short(from.agent)} hit its limit. Switching back hands the work over with a brief.`,
        [
          { key: `switchback:${from.agent}`, label: `Switch back to ${short(from.agent)}` },
          { key: 'dismiss', label: `Stay on ${short(info.agent ?? 'claude')}` },
        ],
      );
    }
  }

  // ---------- Actions items (kind 'account'; answers come through account-switch.ts) ----------

  // Returns true when the key was ours
  answer(item: ActionItem, key: string): boolean {
    const match = /^(fallback|switchback):([a-z]+)$/.exec(key);
    if (!match) return false;
    if (!item.consoleId) throw new Error('The console is gone');
    const info = this.options.manager.get(item.consoleId);
    if (!info) throw new Error('The console is gone');
    const agent = match[2] as AgentKind;
    this.resolve(item, 'user');
    const source: AgentKind = info.agent ?? 'claude';
    if (match[1] === 'fallback') {
      void this.switchTo(info.id, agent, source, undefined, `continued on ${short(agent)} as you asked`);
    } else {
      void this.options.switcher
        .switchAgent(info.id, {
          agent,
          closeOld: true,
          briefMode: 'quick',
          continuePrompt: CONTINUE_TASK,
          ...(info.fallbackFrom?.accountId ? { accountId: info.fallbackFrom.accountId } : {}),
        })
        .catch((err: unknown) => {
          this.fileAction(info.id, `${info.name}: could not switch back to ${short(agent)}`, err instanceof Error ? err.message : String(err));
        });
    }
    return true;
  }

  private fileAction(
    consoleId: string,
    title: string,
    detail: string | undefined,
    options?: ActionItem['options'],
  ): ActionItem {
    const { manager } = this.options;
    const clipped = title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
    // One open account item per console, like account-switch.ts
    for (const old of manager.actions.filter((a) => a.kind === 'account' && a.consoleId === consoleId && !a.resolvedAt)) {
      this.resolve(old, 'auto');
    }
    const item: ActionItem = { id: crypto.randomUUID(), consoleId, kind: 'account', title: clipped, createdAt: this.now() };
    if (detail) item.detail = detail;
    if (options?.length) item.options = options;
    manager.actions.push(item);
    manager.emit('action', item);
    manager.persist();
    return item;
  }

  private resolve(item: ActionItem, by: 'auto' | 'user'): void {
    item.resolvedAt = this.now();
    item.resolvedBy = by;
    this.options.manager.emit('action', item);
    this.options.manager.persist();
  }
}
