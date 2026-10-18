import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake PTY: records writes and lets the test play Claude Code's output
interface FakePty {
  written: string[];
  emit(data: string): void;
  write(data: string): void;
  kill(): void;
  resize(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}
const ptys: FakePty[] = [];
vi.mock('node-pty', () => ({
  spawn: () => {
    let listener: (d: string) => void = () => {};
    const p: FakePty = {
      written: [],
      emit: (data) => listener(data),
      write(data) {
        this.written.push(data);
      },
      kill() {},
      resize() {},
      onData(cb) {
        listener = cb;
      },
      onExit() {},
    };
    ptys.push(p);
    return p;
  },
}));
vi.mock('./claude-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-path.js')>()),
  resolveClaudeExecutable: () => 'claude',
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-send-'));
process.env.AGENTARMY_HOME = home;
const { ConsoleManager, DEFAULT_SEND_TIMING } = await import('./consoles.js');

const LONG = Array.from({ length: 15 }, (_, i) => `Line ${i + 1} of the role prompt`).join('\n');

function setup() {
  const manager = new ConsoleManager({ port: 1, token: 't', onChange: () => {} });
  const info = manager.create({ cwd: home });
  const pty = ptys[ptys.length - 1];
  const enters = () => pty.written.filter((w) => w === '\r').length;
  return { manager, info, pty, enters };
}

beforeEach(() => {
  ptys.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ConsoleManager.sendText', () => {
  it('pastes multi-line text and presses Enter only after the output goes quiet', async () => {
    const { manager, info, pty, enters } = setup();
    expect(manager.sendText(info.id, LONG)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.written[0]).toBe(`\x1b[200~${LONG}\x1b[201~`);
    // Claude Code keeps redrawing while it takes the paste in
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100);
      pty.emit('\x1b[2K[Pasted text #1 +14 lines]');
      expect(enters()).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.quietMs + 50);
    expect(enters()).toBe(1);
  });

  it('waits at least the minimum even when nothing is printed', async () => {
    const { manager, info, enters } = setup();
    manager.sendText(info.id, 'hi');
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.minWaitMs - 30);
    expect(enters()).toBe(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(enters()).toBe(1);
  });

  it('gives up waiting for quiet after the maximum', async () => {
    const { manager, info, pty, enters } = setup();
    manager.sendText(info.id, 'x'.repeat(20_000));
    const noisy = setInterval(() => pty.emit('.'), 20);
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.maxWaitMs - 50);
    expect(enters()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(enters()).toBe(1);
    clearInterval(noisy);
  });

  it('presses Enter once more when no UserPromptSubmit arrives, and only once', async () => {
    const { manager, info, enters } = setup();
    manager.sendText(info.id, LONG);
    await vi.advanceTimersByTimeAsync(1000);
    expect(enters()).toBe(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.verifyMs);
    expect(enters()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(enters()).toBe(2);
  });

  it('does not press Enter again once the prompt was submitted', async () => {
    const { manager, info, enters } = setup();
    manager.sendText(info.id, LONG);
    await vi.advanceTimersByTimeAsync(1000);
    manager.handleHook(info.id, { hook_event_name: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.verifyMs + 1000);
    expect(enters()).toBe(1);
  });

  it('does not press Enter again while the console is working', async () => {
    const { manager, info, enters } = setup();
    manager.sendText(info.id, LONG);
    await vi.advanceTimersByTimeAsync(1000);
    manager.handleHook(info.id, { hook_event_name: 'PreToolUse', tool_name: 'Read' });
    expect(manager.get(info.id)!.status).toBe('working');
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.verifyMs + 1000);
    expect(enters()).toBe(1);
  });

  it('never retries slash commands (they fire no UserPromptSubmit)', async () => {
    const { manager, info, enters } = setup();
    manager.sendText(info.id, '/model haiku');
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMING.verifyMs + 2000);
    expect(enters()).toBe(1);
  });

  it('keeps two sends to one console in order', async () => {
    const { manager, info, pty } = setup();
    manager.sendText(info.id, 'first');
    manager.sendText(info.id, 'second');
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.written.slice(0, 4)).toEqual(['first', '\r', 'second', '\r']);
  });

  it('reports a /model switch seen on screen, even across chunks and colors', () => {
    const { manager, info, pty } = setup();
    const seen: string[] = [];
    manager.on('model-switch', (id) => seen.push(id));
    pty.emit('  \x1b[2m⎿\x1b[22m  Set mo');
    pty.emit('del to \x1b[1mHaiku 5.5\x1b[22m');
    expect(seen).toEqual([info.id]);
    // Recorded from Claude Code 2.1.302: spaces are cursor moves, and the line comes inside a long redraw
    pty.emit(
      '\x1b[?2026h\r\n \x1b[1C⎿\x1b[m\x1b[2CSet\x1b[1Cmodel\x1b[1Cto\x1b[38;2;177;185;249m\x1b[1CSonnet\x1b[1C5.5\x1b[m' +
        '\x1b[1Cand\x1b[1Csaved\x1b[1Csessions' +
        ' '.repeat(400),
    );
    expect(seen).toEqual([info.id, info.id]);
  });
});
