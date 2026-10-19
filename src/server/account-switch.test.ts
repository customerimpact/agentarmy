import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, ServerMessage } from '../shared/protocol.js';
import { AccountStore, DEFAULT_ACCOUNT_ID, transcriptFile } from './accounts.js';
import { AccountSwitcher, CONTINUE_PROMPT, planSwitch } from './account-switch.js';
import { ActionInbox } from './actions.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

let tmp: string;
const NOW = Date.UTC(2026, 9, 18, 12); // 14:00 Brussels
const BANNER = "You've hit your session limit · resets 3pm (Europe/Brussels)";

function writeLogin(dir: string, email: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
}

function setup(opts: { workLoggedIn?: boolean; mode?: 'on' | 'ask' | 'off' } = {}) {
  const store = new AccountStore({
    file: null,
    accountsDir: path.join(tmp, 'accounts'),
    defaultDir: path.join(tmp, 'default'),
    env: {},
  });
  writeLogin(path.join(tmp, 'default'), 'me@home.com');
  const work = store.create('Work');
  if (opts.workLoggedIn !== false) writeLogin(work.configDir, 'me@work.com');
  // The product default is 'ask'; these tests exercise automatic switching unless a mode is given
  store.patch({ autoSwitch: opts.mode ?? 'on' });
  const ctx = fakeManager([fakeConsole('ada', 'working')]);
  const ada = ctx.manager.get('ada')!;
  const restarts: Array<{ id: string; accountId?: string }> = [];
  ctx.manager.restart = vi.fn((id: string) => {
    const info = ctx.manager.get(id)!;
    restarts.push({ id, accountId: info.accountId });
    info.status = 'starting';
    info.statusDetail = undefined;
    ctx.manager.touch(id);
    return info;
  });
  const messages: ServerMessage[] = [];
  const switcher = new AccountSwitcher({
    manager: ctx.manager,
    store,
    broadcast: (m) => messages.push(m),
    resendDelayMs: 10,
    switchDelayMs: 10,
  });
  const inbox = new ActionInbox(ctx.manager);
  const hook = (payload: Record<string, unknown>) => ctx.manager.emit('hook', 'ada', payload);
  const accountItems = () => ctx.manager.actions.filter((a) => a.kind === 'account');
  // A transcript in the default account, like Claude Code writes it
  const src = transcriptFile(path.join(tmp, 'default'), ada.cwd, ada.sessionId);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '{"type":"user","message":{"content":"build it"}}\n');
  return { ...ctx, store, work, ada, restarts, messages, switcher, inbox, hook, accountItems };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-switch-'));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function account(id: string, status: Account['status']): Account {
  return { id, name: id, configDir: id, isDefault: id === 'default', status, lastSeenAt: 0 };
}

describe('planSwitch', () => {
  const list = [account('default', 'limited'), account('a', 'needs_login'), account('b', 'limited'), account('c', 'ok')];
  it('picks the first ok account other than the limited one', () => {
    expect(planSwitch('on', list, 'default')).toMatchObject({ action: 'switch', to: { id: 'c' } });
    expect(planSwitch('ask', list, 'default')).toMatchObject({ action: 'ask', to: { id: 'c' } });
  });
  it('does nothing when off or when nothing is available', () => {
    expect(planSwitch('off', list, 'default')).toEqual({ action: 'none', reason: 'off' });
    expect(planSwitch('on', list.slice(0, 3), 'default')).toEqual({ action: 'none', reason: 'no-account' });
    expect(planSwitch('on', [account('c', 'ok')], 'c')).toEqual({ action: 'none', reason: 'no-account' });
  });
});

describe('AccountSwitcher', () => {
  it('switches a console that hit its limit and re-sends the interrupted prompt', () => {
    const t = setup();
    t.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'build it' });
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    // The old account is marked right away; the switch waits for the turn's last hooks
    expect(t.store.get(DEFAULT_ACCOUNT_ID)).toMatchObject({ status: 'limited', limitResetsAt: Date.UTC(2026, 9, 18, 13) });
    expect(t.restarts).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(t.restarts).toEqual([{ id: 'ada', accountId: t.work.id }]);
    expect(t.ada.accountId).toBe(t.work.id);
    expect(t.ada.statusDetail).toMatch(/^Switched from Default to Work \(Default limited until /);
    // The conversation now exists in the new account too
    expect(fs.existsSync(transcriptFile(t.work.configDir, t.ada.cwd, t.ada.sessionId))).toBe(true);
    expect(t.messages.find((m) => m.type === 'account-switch')).toMatchObject({
      event: { consoleId: 'ada', fromName: 'Default', toName: 'Work' },
    });
    expect(t.accountItems()[0].title).toMatch(/^Ada switched from Default to Work/);
    // Ready on the new account: the prompt that never got an answer goes in again
    t.hook({ hook_event_name: 'SessionStart', session_id: t.ada.sessionId });
    vi.advanceTimersByTime(10);
    expect(t.typed).toEqual([{ id: 'ada', text: 'build it' }]);
  });

  it('nudges with "Continue where you left off." when the prompt is unknown', () => {
    const t = setup();
    t.manager.emit('output', 'ada', `\x1b[31m${BANNER}\x1b[39m\r\n`);
    vi.advanceTimersByTime(10);
    expect(t.restarts).toHaveLength(1);
    t.hook({ hook_event_name: 'SessionStart' });
    vi.advanceTimersByTime(10);
    expect(t.typed).toEqual([{ id: 'ada', text: CONTINUE_PROMPT }]);
  });

  it('ignores old banners while the console is not working (resume replay)', () => {
    const t = setup();
    t.ada.status = 'idle';
    t.manager.emit('output', 'ada', BANNER);
    vi.advanceTimersByTime(100);
    expect(t.restarts).toEqual([]);
    expect(t.store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('ok');
  });

  it('records warning banners as utilization without switching', () => {
    const t = setup();
    t.manager.emit('output', 'ada', "You've used 95% of your weekly limit · resets Oct 20, 11pm (Europe/Brussels)");
    vi.advanceTimersByTime(100);
    expect(t.restarts).toEqual([]);
    expect(t.store.get(DEFAULT_ACCOUNT_ID)?.utilization).toMatchObject({ sevenDay: 95, sevenDayResetsAt: Date.UTC(2026, 9, 20, 21) });
  });

  it("'ask' files an Actions item and switches when it is answered", () => {
    const t = setup({ mode: 'ask' });
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    vi.advanceTimersByTime(100);
    expect(t.restarts).toEqual([]);
    const item = t.accountItems().find((a) => !a.resolvedAt)!;
    expect(item.options?.map((o) => o.label)).toEqual(['Switch to Work', 'Not now']);
    t.inbox.answer(item.id, { key: item.options![0].key });
    expect(t.restarts).toEqual([{ id: 'ada', accountId: t.work.id }]);
    expect(item.resolvedAt).toBeDefined();
  });

  it("'off' only marks the account", () => {
    const t = setup({ mode: 'off' });
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    vi.advanceTimersByTime(100);
    expect(t.restarts).toEqual([]);
    expect(t.store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('limited');
    expect(t.accountItems()[0].detail).toMatch(/Auto-switch is off/);
  });

  it('never switches to an account that needs a login', () => {
    const t = setup({ workLoggedIn: false });
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    vi.advanceTimersByTime(100);
    expect(t.restarts).toEqual([]);
    expect(t.accountItems()[0].detail).toMatch(/No other account is available/);
  });

  it('says clearly when the conversation could not be resumed on the new account', () => {
    const t = setup();
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    vi.advanceTimersByTime(10);
    // What the resume fallback in ConsoleManager does after a quick exit
    t.ada.sessionId = 'fresh-session';
    t.ada.statusDetail = 'Could not resume the previous conversation; started a new one';
    t.manager.touch('ada');
    expect(t.ada.statusDetail).toBe('Switched to Work, but the conversation could not be resumed there; started a new one');
    // Nothing to "continue" in a new conversation
    t.hook({ hook_event_name: 'SessionStart' });
    vi.advanceTimersByTime(10);
    expect(t.typed).toEqual([]);
  });

  it('a limit hit again on the new account does not bounce back to a limited one', () => {
    const t = setup();
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    vi.advanceTimersByTime(10);
    t.hook({ hook_event_name: 'SessionStart' });
    vi.advanceTimersByTime(20_000);
    t.ada.status = 'working';
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    vi.advanceTimersByTime(100);
    expect(t.restarts).toHaveLength(1);
    expect(t.store.get(t.work.id)?.status).toBe('limited');
  });

  it('the limit expires at the reset time', () => {
    const t = setup();
    t.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: BANNER });
    expect(t.store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('limited');
    vi.setSystemTime(Date.UTC(2026, 9, 18, 13, 0, 1));
    t.store.refresh();
    expect(t.store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('ok');
  });
});
