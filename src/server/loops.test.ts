import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop, LoopInput } from '../shared/protocol.js';
import { compileMatcher, loopPromptText, loopSummary, parseGoalVerdict } from '../shared/loops.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { LoopService, stripAnsi, type CommandRunner } from './loops.js';

const MIN = 60_000;

function setup(statuses: Record<string, 'idle' | 'resting' | 'working' | 'needs_you' | 'exited'> = { ada: 'idle', bex: 'idle' }, runCommand?: CommandRunner) {
  const consoles = Object.entries(statuses).map(([id, status]) => fakeConsole(id, status));
  const { manager, typed, setStatus } = fakeManager(consoles);
  for (const c of manager.list()) c.statusChangedAt = Date.now();
  const service = new LoopService(manager, { tickMs: 0, runCommand });
  const create = (input: Partial<LoopInput>): Loop =>
    service.create({ name: 'L', prompt: 'run the tests', target: { kind: 'all' }, trigger: { kind: 'schedule', everyMinutes: 5 }, ...input });
  const stop = (id: string, message = 'Done') =>
    manager.handleHook(id, { hook_event_name: 'Stop', session_id: 's', last_assistant_message: message } as never);
  return { manager, typed, setStatus, service, create, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('shared loop helpers', () => {
  it('matches plain text case-insensitively and /regex/flags', () => {
    expect(compileMatcher('Tests Failed')('3 tests failed')).toBe(true);
    expect(compileMatcher('tests failed')('all green')).toBe(false);
    expect(compileMatcher('/\\d+ failing/')('2 failing')).toBe(true);
    expect(compileMatcher('/ERROR/i')('an error here')).toBe(true);
    expect(() => compileMatcher('/(/')).toThrow();
  });

  it('parses the last GOAL MET / GOAL NOT MET verdict', () => {
    expect(parseGoalVerdict('All good. GOAL MET')).toBe(true);
    expect(parseGoalVerdict('Still red.\nGOAL NOT MET')).toBe(false);
    expect(parseGoalVerdict('I was told to say "GOAL MET" or "GOAL NOT MET". Result: goal not met')).toBe(false);
    expect(parseGoalVerdict('Nothing here')).toBeNull();
    expect(parseGoalVerdict(undefined)).toBeNull();
  });

  it('appends the goal instruction for agent-judged loops only', () => {
    expect(loopPromptText({ name: 'x', prompt: 'go', stop: {} })).toBe('go');
    const text = loopPromptText({ name: 'x', prompt: 'go', stop: { whenGoal: { kind: 'agent', description: 'tests pass' } } });
    expect(text).toContain('go\n\n');
    expect(text).toContain('"GOAL MET" if tests pass');
  });

  it('writes a plain-English summary', () => {
    const names = { console: (id: string) => ({ a: 'Ada', b: 'Bex' })[id], project: () => 'Frontend' };
    expect(
      loopSummary(
        { prompt: 'Run the tests', target: { kind: 'project', id: 'p' }, trigger: { kind: 'schedule', everyMinutes: 15 }, stop: { whenGoal: { kind: 'command', command: 'npm test', description: 'tests pass' } } },
        names,
      ),
    ).toBe("Every 15 min, send 'Run the tests' to Frontend until tests pass");
    expect(
      loopSummary({ prompt: 'Keep going', target: { kind: 'consoles', ids: ['a', 'b'] }, trigger: { kind: 'idle', afterSeconds: 90 }, stop: { afterRuns: 3 } }, names),
    ).toBe("After 1 min 30 s idle, send 'Keep going' to Ada, Bex at most 3 times");
    expect(
      loopSummary({ prompt: 'Fix it', target: { kind: 'all' }, trigger: { kind: 'output', match: '/fail(ed)?/' }, stop: { afterMinutes: 120 } }, names),
    ).toBe("When output matches /fail(ed)?/, send 'Fix it' to every console for 2 h");
  });

  it('strips ANSI and turns cursor moves into spaces', () => {
    expect(stripAnsi('\x1b[31mtests\x1b[1Cfailed\x1b[39m')).toBe('tests failed');
  });
});

describe('LoopService validation', () => {
  it('rejects bad input', () => {
    const { create } = setup();
    expect(() => create({ prompt: '' })).toThrow(/prompt/);
    expect(() => create({ trigger: { kind: 'schedule', everyMinutes: 2 } })).toThrow(/between 5 and 120/);
    expect(() => create({ trigger: { kind: 'output', match: '/(/' } })).toThrow(/regular expression/);
    expect(() => create({ target: { kind: 'consoles', ids: [] } })).toThrow(/at least one/);
    expect(() => create({ target: { kind: 'consoles', ids: ['nobody'] } })).toThrow(/Unknown console/);
    expect(() => create({ target: { kind: 'project', id: 'nope' } })).toThrow(/Unknown project/);
  });

  it('requires confirmCommand for a goal command', () => {
    const { create } = setup();
    expect(() => create({ stop: { whenGoal: { kind: 'command', command: 'npm test' } } })).toThrow(/Confirm/);
    const loop = create({ stop: { whenGoal: { kind: 'command', command: 'npm test' } }, confirmCommand: true });
    expect(loop.stop.whenGoal).toEqual({ kind: 'command', command: 'npm test' });
  });
});

describe('schedule trigger', () => {
  it('sends every N minutes to ready targets, skipping working and needs_you', () => {
    const { create, service, typed } = setup({ ada: 'idle', bex: 'working', cy: 'needs_you' });
    const loop = create({ trigger: { kind: 'schedule', everyMinutes: 15 } });
    vi.advanceTimersByTime(14 * MIN);
    service.tick();
    expect(typed).toEqual([]);
    vi.advanceTimersByTime(MIN);
    service.tick();
    expect(typed).toEqual([{ id: 'ada', text: 'run the tests' }]);
    expect(loop.runs).toBe(1);
    expect(loop.history?.at(-1)).toMatchObject({ sentTo: ['Ada'], skipped: ['Bex (working)', 'Cy (needs you)'] });
    service.tick();
    expect(typed).toHaveLength(1); // not again until the next 15 minutes
  });

  it('waits while every target is busy instead of logging empty runs', () => {
    const { create, service, typed, setStatus } = setup({ ada: 'working' });
    const loop = create({});
    vi.advanceTimersByTime(6 * MIN);
    service.tick();
    expect(typed).toEqual([]);
    expect(loop.history).toEqual([]);
    setStatus('ada', 'resting');
    service.tick();
    expect(typed).toHaveLength(1);
  });

  it('skips paused consoles', () => {
    const { create, service, typed, manager } = setup({ ada: 'resting', bex: 'resting' });
    manager.get('ada')!.paused = true;
    create({});
    vi.advanceTimersByTime(5 * MIN);
    service.tick();
    expect(typed.map((t) => t.id)).toEqual(['bex']);
  });

  it('a disabled loop does nothing; run now ignores the trigger', () => {
    const { create, service, typed } = setup();
    const loop = create({ enabled: false });
    vi.advanceTimersByTime(60 * MIN);
    service.tick();
    expect(typed).toEqual([]);
    service.runNow(loop.id);
    expect(typed).toHaveLength(2);
    expect(loop.runs).toBe(1);
  });
});

describe('idle trigger', () => {
  it('fires once per idle period after N seconds', () => {
    const { create, service, typed, setStatus, manager } = setup({ ada: 'working' });
    create({ target: { kind: 'consoles', ids: ['ada'] }, trigger: { kind: 'idle', afterSeconds: 30 } });
    vi.advanceTimersByTime(60_000);
    setStatus('ada', 'resting');
    manager.get('ada')!.statusChangedAt = Date.now(); // the hook path sets this
    service.tick();
    expect(typed).toEqual([]);
    vi.advanceTimersByTime(29_000);
    service.tick();
    expect(typed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    service.tick();
    expect(typed).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    service.tick();
    expect(typed).toHaveLength(1); // same idle period
  });

  it('fires again after the agent worked and went idle again', () => {
    const { create, service, typed, manager } = setup({ ada: 'resting' });
    create({ trigger: { kind: 'idle', afterSeconds: 10 }, target: { kind: 'consoles', ids: ['ada'] } });
    vi.advanceTimersByTime(10_000);
    service.tick();
    expect(typed).toHaveLength(1);
    manager.handleHook('ada', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'run the tests' } as never);
    manager.handleHook('ada', { hook_event_name: 'Stop', session_id: 's' } as never);
    vi.advanceTimersByTime(10_000);
    service.tick();
    expect(typed).toHaveLength(2);
  });
});

describe('output trigger', () => {
  it('sends once the matching console rests, and ignores the echo of its own turn', () => {
    const { create, service, typed, manager, stop } = setup({ ada: 'working' });
    create({ prompt: 'fix the failing tests', target: { kind: 'consoles', ids: ['ada'] }, trigger: { kind: 'output', match: 'tests failed' } });
    manager.emit('output', 'ada', '3 \x1b[31mtests\x1b[1Cfai');
    manager.emit('output', 'ada', 'led\x1b[39m\r\n');
    service.tick();
    expect(typed).toEqual([]); // still working
    stop('ada');
    service.tick();
    expect(typed).toHaveLength(1);
    // The new turn prints the same words again; that is our own echo until its Stop
    manager.emit('output', 'ada', 'tests failed');
    stop('ada');
    service.tick();
    expect(typed).toHaveLength(1);
    manager.emit('output', 'ada', 'tests failed again');
    service.tick();
    expect(typed).toHaveLength(2);
  });
});

describe('stop conditions', () => {
  it('retires after N runs', () => {
    const { create, service, typed } = setup({ ada: 'idle' });
    const loop = create({ stop: { afterRuns: 2 } });
    service.runNow(loop.id);
    expect(loop.enabled).toBe(true);
    service.runNow(loop.id);
    expect(loop).toMatchObject({ enabled: false, retiredReason: 'after 2 runs', runs: 2 });
    vi.advanceTimersByTime(10 * MIN);
    service.tick();
    expect(typed).toHaveLength(2);
  });

  it('retires after N minutes, and re-enabling starts over', () => {
    const { create, service } = setup({ ada: 'working' });
    const loop = create({ stop: { afterMinutes: 30 } });
    vi.advanceTimersByTime(30 * MIN);
    service.tick();
    expect(loop).toMatchObject({ enabled: false, retiredReason: 'after 30 min' });
    service.update(loop.id, { enabled: true });
    expect(loop.enabled).toBe(true);
    expect(loop.retiredAt).toBeUndefined();
    service.tick();
    expect(loop.enabled).toBe(true);
  });

  it('agent goal: GOAL MET in the Stop message retires the loop', () => {
    const { create, service, typed, stop } = setup({ ada: 'idle' });
    const loop = create({ target: { kind: 'consoles', ids: ['ada'] }, stop: { whenGoal: { kind: 'agent', description: 'the build is green' } } });
    service.runNow(loop.id);
    expect(typed[0].text).toContain('"GOAL NOT MET"');
    stop('ada', 'Still failing. GOAL NOT MET');
    expect(loop).toMatchObject({ enabled: true, lastGoal: { met: false } });
    service.runNow(loop.id);
    stop('ada', 'Build is green now.\nGOAL MET');
    expect(loop).toMatchObject({ enabled: false, retiredReason: 'goal met', lastGoal: { met: true } });
  });

  it('command goal: runs after every target ended its turn; exit 0 retires', async () => {
    const codes = [1, 0];
    const runCommand = vi.fn<CommandRunner>(async () => ({ code: codes.shift() ?? 0, output: '', timedOut: false }));
    const { create, service, stop } = setup({ ada: 'idle', bex: 'idle' }, runCommand);
    const loop = create({ stop: { whenGoal: { kind: 'command', command: 'npm test' } }, confirmCommand: true });
    service.runNow(loop.id);
    stop('ada');
    expect(runCommand).not.toHaveBeenCalled(); // Bex is still on it
    stop('bex');
    await vi.waitFor(() => expect(loop.lastGoal).toMatchObject({ met: false, detail: '`npm test` exit code 1' }));
    expect(runCommand).toHaveBeenCalledWith('npm test', process.cwd());
    expect(loop.enabled).toBe(true);
    service.runNow(loop.id);
    stop('ada');
    stop('bex');
    await vi.waitFor(() => expect(loop.enabled).toBe(false));
    expect(loop.retiredReason).toBe('goal met');
  });
});

describe('persistence', () => {
  it('loops live in the board state', () => {
    const { create, manager, service } = setup();
    const loop = create({});
    expect(manager.getState().loops).toEqual([loop]);
    service.remove(loop.id);
    expect(manager.getState().loops).toEqual([]);
  });
});
