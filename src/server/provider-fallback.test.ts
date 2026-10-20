import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind } from '../shared/agents.js';
import type { ConsoleInfo, LimitFallbackMode, SwitchAgentResponse } from '../shared/protocol.js';
import { AccountStore } from './accounts.js';
import { AccountSwitcher } from './account-switch.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import {
  CONTINUE_TASK,
  ProviderFallback,
  fallbackCandidates,
  planFallback,
  shouldOfferSwitchBack,
  type Readiness,
} from './provider-fallback.js';
import type { SwitchAgentInternal, SwitchAgentService } from './switch-agent.js';

const NOW = Date.UTC(2026, 9, 18, 12); // 14:00 Brussels
const BANNER = "You've hit your session limit · resets 3pm (Europe/Brussels)";
let tmp: string;

describe('planFallback', () => {
  const ready = { codex: { ready: true }, gemini: { ready: false, why: 'Gemini CLI is not installed' } };
  it('continues a limited Claude console on the preferred CLI (ask or switch), else waits', () => {
    expect(planFallback({ mode: 'ask', source: 'claude', preferred: 'codex', claudeAvailable: false, readiness: ready })).toEqual({ action: 'ask', agent: 'codex' });
    expect(planFallback({ mode: 'switch', source: 'claude', preferred: 'codex', claudeAvailable: false, readiness: ready })).toEqual({ action: 'switch', agent: 'codex' });
    expect(planFallback({ mode: 'wait', source: 'claude', preferred: 'codex', claudeAvailable: false, readiness: ready })).toEqual({ action: 'wait', reason: 'setting' });
    expect(planFallback({ mode: 'switch', source: 'claude', preferred: 'gemini', claudeAvailable: false, readiness: ready })).toEqual({
      action: 'wait',
      reason: 'unavailable',
      agent: 'gemini',
      why: 'Gemini CLI is not installed',
    });
    expect(planFallback({ mode: 'switch', source: 'claude', preferred: 'claude', claudeAvailable: false, readiness: ready })).toMatchObject({ action: 'wait' });
  });

  it('works in reverse: a limited Codex console goes to Claude first, then the preferred CLI', () => {
    expect(fallbackCandidates('codex', 'codex')).toEqual(['claude']);
    expect(fallbackCandidates('codex', 'grok')).toEqual(['claude', 'grok']);
    expect(planFallback({ mode: 'switch', source: 'codex', preferred: 'codex', claudeAvailable: true, readiness: {} })).toEqual({ action: 'switch', agent: 'claude' });
    expect(planFallback({ mode: 'ask', source: 'codex', preferred: 'grok', claudeAvailable: false, readiness: { grok: { ready: true } } })).toEqual({ action: 'ask', agent: 'grok' });
  });

  it('offers switching back once the old provider is usable', () => {
    expect(shouldOfferSwitchBack({ agent: 'claude', at: 0 }, false, 10)).toBe(false);
    expect(shouldOfferSwitchBack({ agent: 'claude', at: 0 }, true, 10)).toBe(true);
    expect(shouldOfferSwitchBack({ agent: 'claude', at: 0, offered: true }, true, 10)).toBe(false);
    expect(shouldOfferSwitchBack({ agent: 'codex', at: 0, resetsAt: 100 }, false, 99)).toBe(false);
    expect(shouldOfferSwitchBack({ agent: 'codex', at: 0, resetsAt: 100 }, false, 100)).toBe(true);
  });
});

function writeLogin(dir: string, email: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
}

function setup(opts: { mode?: LimitFallbackMode; preferred?: AgentKind; readiness?: Partial<Record<AgentKind, Readiness>>; consoles?: ConsoleInfo[] } = {}) {
  const store = new AccountStore({ file: null, accountsDir: path.join(tmp, 'accounts'), defaultDir: path.join(tmp, 'default'), env: {} });
  writeLogin(path.join(tmp, 'default'), 'me@home.com'); // one Claude account only
  const ctx = fakeManager(opts.consoles ?? [fakeConsole('ada', 'working')]);
  const calls: Array<{ id: string; req: SwitchAgentInternal }> = [];
  let n = 0;
  const switchAgent = vi.fn(async (id: string, req: SwitchAgentInternal): Promise<SwitchAgentResponse> => {
    calls.push({ id, req });
    const from = ctx.manager.get(id)!;
    const target = { ...fakeConsole(`new${++n}`), name: from.name, agent: req.agent === 'claude' ? undefined : req.agent, fallbackFrom: req.fallbackFrom };
    (ctx.manager as unknown as { register(i: ConsoleInfo): void }).register(target);
    return { console: target, job: {} as never, brief: 'B', briefMode: 'quick' };
  });
  const switcher = { switchAgent, isSwitching: () => false } as unknown as SwitchAgentService;
  const settings = { ...DEFAULT_SETTINGS, limitFallback: opts.mode ?? 'ask', limitFallbackAgent: opts.preferred ?? 'codex' };
  const readiness = vi.fn(async (agent: AgentKind) => opts.readiness?.[agent] ?? { ready: true });
  const fallback = new ProviderFallback({ manager: ctx.manager, store, switcher, settings: () => settings, readiness, switchDelayMs: 50, checkMs: 0 });
  const accounts = new AccountSwitcher({ manager: ctx.manager, store, broadcast: () => {}, switchDelayMs: 10 });
  accounts.setFallback(fallback);
  const items = () => ctx.manager.actions.filter((a) => a.kind === 'account');
  const open = () => items().filter((a) => !a.resolvedAt);
  return { ...ctx, store, fallback, accounts, calls, switchAgent, items, open, settings };
}

// Lets the async plan (readiness checks) settle under fake timers
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fallback-'));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ProviderFallback with the account switcher', () => {
  it("'switch': the only Claude account hits its limit -> continues on Codex with a quick brief + Continue the task.", async () => {
    const { manager, calls, open } = setup({ mode: 'switch' });
    manager.emit('output', 'ada', BANNER);
    await settle(0);
    expect(calls).toEqual([]); // waits a moment so the failing turn's last hooks land
    await settle(60);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('ada');
    expect(calls[0].req).toMatchObject({ agent: 'codex', closeOld: true, briefMode: 'quick', continuePrompt: CONTINUE_TASK });
    expect(calls[0].req.fallbackFrom).toMatchObject({ agent: 'claude', resetsAt: Date.UTC(2026, 9, 18, 13) });
    const item = open().find((a) => a.consoleId === 'new1');
    expect(item?.title).toContain('Ada continued on Codex: every Claude account is limited');
  });

  it("'ask': files Continue on Codex / Wait and switches when answered", async () => {
    const { manager, calls, open, accounts } = setup({ mode: 'ask' });
    manager.emit('output', 'ada', BANNER);
    await settle(0);
    const item = open()[0];
    expect(item.options).toEqual([
      { key: 'fallback:codex', label: 'Continue on Codex' },
      { key: 'dismiss', label: 'Wait' },
    ]);
    (accounts as unknown as { answer(i: typeof item, k: string): void }).answer(item, 'fallback:codex');
    await settle(0);
    expect(item.resolvedAt).toBe(NOW);
    expect(calls[0].req).toMatchObject({ agent: 'codex', continuePrompt: CONTINUE_TASK, fallbackFrom: { agent: 'claude', resetsAt: Date.UTC(2026, 9, 18, 13) } });
  });

  it('waits (and says why) when the fallback CLI is not logged in, or when set to wait', async () => {
    const a = setup({ mode: 'switch', readiness: { codex: { ready: false, why: 'Codex CLI is not logged in' } } });
    a.manager.emit('output', 'ada', BANNER);
    await settle(100);
    expect(a.calls).toEqual([]);
    expect(a.open()[0].detail).toContain('Codex CLI is not available to continue (Codex CLI is not logged in)');

    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fallback-'));
    const b = setup({ mode: 'wait' });
    b.manager.emit('output', 'ada', BANNER);
    await settle(100);
    expect(b.calls).toEqual([]);
    expect(b.open()[0].detail).toContain('waits for the reset');
  });

  it('offers Switch back to Claude once the limit resets, and switches back when answered', async () => {
    const { manager, calls, open, store, fallback } = setup({ mode: 'switch' });
    manager.emit('output', 'ada', BANNER);
    await settle(60);
    const moved = manager.get('new1')!;
    expect(moved.fallbackFrom?.agent).toBe('claude');
    fallback.check();
    expect(open().some((a) => a.options?.some((o) => o.key.startsWith('switchback')))).toBe(false); // still limited

    vi.setSystemTime(Date.UTC(2026, 9, 18, 13, 1)); // after the 3pm reset
    store.refresh(); // what account-routes does every 30 s; emits change
    const offer = open().find((a) => a.consoleId === 'new1')!;
    expect(offer.title).toBe('Claude is available again: switch Ada back?');
    expect(offer.options?.[0]).toEqual({ key: 'switchback:claude', label: 'Switch back to Claude' });
    expect(moved.fallbackFrom?.offered).toBe(true);
    fallback.check(); // offered once only
    expect(open().filter((a) => a.title.startsWith('Claude is available again'))).toHaveLength(1);

    fallback.answer(offer, 'switchback:claude');
    await settle(0);
    expect(calls[1]).toMatchObject({ id: 'new1', req: { agent: 'claude', closeOld: true, continuePrompt: CONTINUE_TASK } });
  });

  it('a Codex console that hits its usage limit moves to Claude (reverse fallback)', async () => {
    const codex = { ...fakeConsole('cody', 'working'), agent: 'codex' as const, statusChangedAt: NOW };
    const { manager, calls, store } = setup({ mode: 'switch', consoles: [codex] });
    manager.emit('output', 'cody', "■ You've hit your usage limit. Upgrade to Pro, or try again at 3:45 PM.");
    await settle(60);
    expect(calls[0]).toMatchObject({ id: 'cody', req: { agent: 'claude' } });
    expect(calls[0].req.fallbackFrom?.agent).toBe('codex');
    expect(calls[0].req.fallbackFrom?.resetsAt).toBeGreaterThan(NOW);
    // Never marks a Claude account limited for another CLI's message
    expect(store.list().every((a) => a.status === 'ok')).toBe(true);
  });

  it('ignores limit text from an idle console that has not worked for a while', async () => {
    const codex = { ...fakeConsole('cody', 'idle'), agent: 'codex' as const, statusChangedAt: NOW - 10 * 60_000 };
    const { manager, calls, open } = setup({ mode: 'switch', consoles: [codex] });
    manager.get('cody')!.statusChangedAt = NOW - 10 * 60_000;
    manager.emit('output', 'cody', "You've hit your usage limit.");
    await settle(100);
    expect(calls).toEqual([]);
    expect(open()).toEqual([]);
  });
});
