import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionInbox } from './actions.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { LOOP_LIMIT, normalizeOutput, NUDGE_TEXT, SNOOZE_MS, StuckWatcher, type StuckSettings } from './stuck.js';

const MIN = 60_000;

function setup(settings: Partial<StuckSettings> = {}) {
  const ctx = fakeManager([fakeConsole('ada', 'idle'), fakeConsole('bex', 'idle')]);
  const inbox = new ActionInbox(ctx.manager);
  const current: StuckSettings = { stuckAlerts: true, stallMinutes: 5, longTurnMinutes: 20, ...settings };
  const inputs: Array<{ id: string; data: string }> = [];
  ctx.manager.input = vi.fn((id: string, data: string) => void inputs.push({ id, data }));
  const watcher = new StuckWatcher(ctx.manager, inbox, () => current, { checkMs: 1000 });
  const stuck = () => ctx.manager.actions.filter((a) => a.kind === 'stuck');
  const open = () => stuck().find((a) => !a.resolvedAt);
  const hook = (id: string, payload: Record<string, unknown>) => ctx.manager.emit('hook', id, payload);
  const tool = (id: string, command: string) =>
    hook(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  // ConsoleManager streams output to attached listeners; reach the watcher's listener the same way
  const output = (id: string, data: string) => {
    const live = (ctx.manager as unknown as { consoles: Map<string, { listeners: Set<(d: string) => void> }> }).consoles.get(id)!;
    for (const listener of live.listeners) listener(data);
  };
  return { ...ctx, inbox, watcher, current, inputs, stuck, open, hook, tool, output };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeOutput', () => {
  it('keeps only letters, so spinner frames with changing timers look the same', () => {
    const a = normalizeOutput('\x1b[38;5;174m✻\x1b[39m Thinking… (34s · ↓ 1.2k tokens · esc to interrupt)');
    const b = normalizeOutput('\x1b[38;5;174m✶\x1b[39m Thinking… (35s · ↓ 1.3k tokens · esc to interrupt)');
    expect(a).toBe(b);
    expect(a).toBe('Thinking s k tokens esc to interrupt');
  });
});

describe('StuckWatcher', () => {
  it('flags a working console with no new output and no hooks as stalled, then clears on progress', () => {
    const { setStatus, open, output, stuck } = setup();
    setStatus('ada', 'working');
    output('ada', '✻ Thinking… (1s · esc to interrupt)');
    vi.advanceTimersByTime(4 * MIN);
    // Spinner redraws are not progress
    output('ada', '✶ Thinking… (241s · esc to interrupt)');
    expect(open()).toBeUndefined();
    vi.advanceTimersByTime(1 * MIN + 1000);
    expect(open()).toMatchObject({ consoleId: 'ada', kind: 'stuck', title: 'Ada seems stalled' });
    expect(open()?.detail).toMatch(/no new output and no tool activity for 5 min/);
    expect(open()?.options?.map((o) => o.key)).toEqual(['nudge', 'interrupt', 'ignore']);
    output('ada', '● Found the bug in parser.ts');
    expect(stuck()[0].resolvedBy).toBe('auto');
    expect(open()).toBeUndefined();
  });

  it('does not watch consoles that are not working', () => {
    const { setStatus, open } = setup();
    setStatus('ada', 'resting');
    setStatus('bex', 'needs_you');
    vi.advanceTimersByTime(60 * MIN);
    expect(open()).toBeUndefined();
  });

  it('flags the same tool call repeated LOOP_LIMIT times in a row, and clears on a different call', () => {
    const { setStatus, tool, open, stuck } = setup();
    setStatus('ada', 'working');
    for (let i = 0; i < LOOP_LIMIT - 1; i++) tool('ada', 'npm test');
    expect(open()).toBeUndefined();
    tool('ada', 'npm test');
    expect(open()).toMatchObject({ title: 'Ada may be looping' });
    expect(open()?.detail).toMatch(/same tool call 5 times in a row/);
    tool('ada', 'git diff');
    expect(stuck()[0].resolvedBy).toBe('auto');
  });

  it('a different call in between restarts the streak', () => {
    const { setStatus, tool, open } = setup();
    setStatus('ada', 'working');
    for (let i = 0; i < 4; i++) tool('ada', 'npm test');
    tool('ada', 'ls');
    for (let i = 0; i < 4; i++) tool('ada', 'npm test');
    expect(open()).toBeUndefined();
  });

  it('flags a very long turn and resolves when the turn ends', () => {
    const { setStatus, hook, tool, open, stuck } = setup({ longTurnMinutes: 20 });
    setStatus('ada', 'working');
    hook('ada', { hook_event_name: 'UserPromptSubmit', prompt: 'refactor' });
    // Keep it busy with varied tool calls so it is neither stalled nor looping
    for (let m = 0; m < 20; m++) {
      tool('ada', `step ${m}`);
      vi.advanceTimersByTime(MIN);
    }
    vi.advanceTimersByTime(1000);
    expect(open()?.title).toBe('Ada has been working for 20 min');
    setStatus('ada', 'resting');
    expect(stuck()[0].resolvedBy).toBe('auto');
  });

  it('Nudge types the status-check message, Interrupt sends Esc, both resolve the item', () => {
    const { setStatus, tool, open, inbox, typed, inputs } = setup();
    setStatus('ada', 'working');
    for (let i = 0; i < LOOP_LIMIT; i++) tool('ada', 'npm test');
    inbox.answer(open()!.id, { key: 'nudge' });
    expect(typed).toEqual([{ id: 'ada', text: NUDGE_TEXT }]);
    expect(open()).toBeUndefined();
    for (let i = 0; i < LOOP_LIMIT; i++) tool('ada', 'npm test');
    const second = open()!;
    inbox.answer(second.id, { key: 'interrupt' });
    expect(inputs).toEqual([{ id: 'ada', data: '\x1b' }]);
    expect(second.resolvedBy).toBe('user');
    expect(() => inbox.answer(second.id, { key: 'nudge' })).toThrow(/already resolved/);
  });

  it('Ignore snoozes that console for 30 minutes', () => {
    const { setStatus, open, inbox } = setup({ stallMinutes: 1 });
    setStatus('ada', 'working');
    vi.advanceTimersByTime(MIN + 1000);
    inbox.answer(open()!.id, { key: 'ignore' });
    vi.advanceTimersByTime(SNOOZE_MS - 2 * MIN);
    expect(open()).toBeUndefined();
    vi.advanceTimersByTime(3 * MIN);
    expect(open()?.title).toBe('Ada seems stalled');
    expect(() => inbox.answer(open()!.id, { key: 'bogus' })).toThrow(/Unknown option/);
  });

  it('marking the item Done does not re-open it for the same episode', () => {
    const { setStatus, open, inbox, stuck } = setup({ stallMinutes: 1 });
    setStatus('ada', 'working');
    vi.advanceTimersByTime(MIN + 1000);
    inbox.setResolved(open()!.id, true);
    vi.advanceTimersByTime(10 * MIN);
    expect(stuck()).toHaveLength(1);
  });

  it('does nothing while alerts are turned off, and closes open ones', () => {
    const { setStatus, open, current, stuck } = setup({ stallMinutes: 1 });
    setStatus('ada', 'working');
    vi.advanceTimersByTime(MIN + 1000);
    expect(open()).toBeDefined();
    current.stuckAlerts = false;
    vi.advanceTimersByTime(1000);
    expect(open()).toBeUndefined();
    vi.advanceTimersByTime(30 * MIN);
    expect(stuck()).toHaveLength(1);
  });
});
