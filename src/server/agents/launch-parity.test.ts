import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../shared/protocol.js';

// What ConsoleManager hands node-pty, per agent. Claude Code must get exactly the pre-adapter launch.
interface Spawned {
  file: string;
  args: string[] | string;
  env: Record<string, string>;
  cwd: string;
  emit: (data: string) => void;
}
const spawned: Spawned[] = [];
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[] | string, opts: { env: Record<string, string>; cwd: string }) => {
    let listener: (d: string) => void = () => {};
    const s: Spawned = { file, args, env: opts.env, cwd: opts.cwd, emit: (d) => listener(d) };
    spawned.push(s);
    return {
      write() {},
      kill() {},
      resize() {},
      onData(cb: (d: string) => void) {
        listener = cb;
      },
      onExit() {},
    };
  },
}));
vi.mock('../claude-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-path.js')>()),
  resolveClaudeExecutable: () => 'C:\\fake\\claude.exe',
}));

const { ConsoleManager } = await import('../consoles.js');
const { DEFAULT_SETTINGS } = await import('../settings.js');
const { settingsDir } = await import('../hook-settings.js');

const settings: AppSettings = { ...DEFAULT_SETTINGS, model: 'opus', permissionMode: 'plan', extraArgs: '--verbose' };

function manager(withAccounts = false) {
  const m = new ConsoleManager({ port: 4444, token: 'tok', onChange: () => {}, settings: () => settings });
  if (withAccounts) m.accountEnv = (_info, mode) => ({ CLAUDE_CONFIG_DIR: `D:\\accounts\\work-${mode}` });
  return m;
}

beforeEach(() => {
  spawned.length = 0;
});

describe('launch through agent adapters', () => {
  it('Claude Code: same args and env as before the adapter refactor (new, then resume)', () => {
    const m = manager(true);
    const info = m.create({ cwd: process.cwd() });
    const dir = settingsDir();
    const expected = (flag: string) => [
      flag,
      info.sessionId,
      '--settings',
      path.join(dir, `${info.id}.settings.json`),
      '--mcp-config',
      path.join(dir, `${info.id}.mcp.json`),
      '--model',
      'opus',
      '--permission-mode',
      'plan',
      '--verbose',
    ];
    expect(spawned[0].file).toBe('C:\\fake\\claude.exe');
    expect(spawned[0].args).toEqual(expected('--session-id'));
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe('D:\\accounts\\work-new');
    expect(spawned[0].env.CLAUDE_CODE_ENABLE_TASKS).toBe('1');
    expect(spawned[0].env.TERM).toBe('xterm-256color');
    expect(info.agent).toBeUndefined();
    expect(info.accountId).toBe('auto');
    m.restart(info.id);
    expect(spawned[1].args).toEqual(expected('--resume'));
    expect(spawned[1].env.CLAUDE_CONFIG_DIR).toBe('D:\\accounts\\work-resume');
    m.shutdown();
  });

  it('custom command: runs through the shell, no account, status from output', async () => {
    const m = manager(true);
    const info = m.create({ cwd: process.cwd(), agent: 'custom', command: 'npm run dev' });
    expect(info.agent).toBe('custom');
    expect(info.command).toBe('npm run dev');
    expect(info.accountId).toBeUndefined();
    if (process.platform === 'win32') {
      expect(spawned[0].file.toLowerCase()).toContain('cmd.exe');
      expect(spawned[0].args).toBe('/d /s /c "npm run dev"');
    } else {
      expect(spawned[0].args).toEqual(['-lc', 'npm run dev']);
    }
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();
    spawned[0].emit('compiling...\r\n');
    await vi.waitFor(() => expect(m.get(info.id)?.status).toBe('working'), { timeout: 2000 });
    await vi.waitFor(() => expect(m.get(info.id)?.status).toBe('resting'), { timeout: 4000 });
    m.shutdown();
  });

  it('rejects unknown agents and custom consoles without a command', () => {
    const m = manager();
    expect(() => m.create({ cwd: process.cwd(), agent: 'cursor' as never })).toThrow(/Unknown agent/);
    expect(() => m.create({ cwd: process.cwd(), agent: 'custom' })).toThrow(/needs a command/);
    expect(spawned).toHaveLength(0);
  });

  it('Codex: a missing CLI exits the console with an install hint instead of throwing', () => {
    const m = new ConsoleManager({
      port: 4444,
      token: 'tok',
      onChange: () => {},
      settings: () => ({ ...settings, agentPaths: { codex: 'Z:\\nowhere\\codex.cmd' } }),
    });
    const info = m.create({ cwd: process.cwd(), agent: 'codex' });
    expect(m.get(info.id)?.status).toBe('exited');
    expect(m.get(info.id)?.statusDetail).toMatch(/Codex CLI path in Settings > Agents/);
  });

  it('Codex: a relayed notify event stores the thread id that resume then uses', () => {
    const fakeCodex = path.join(process.cwd(), 'tests', 'fake-cli', process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const m = new ConsoleManager({
      port: 4444,
      token: 'tok',
      onChange: () => {},
      settings: () => ({ ...settings, agentPaths: { codex: fakeCodex } }),
    });
    const info = m.create({ cwd: process.cwd(), agent: 'codex' });
    m.handleHook(info.id, { hook_event_name: 'Stop', agent: 'codex', agent_session_id: 'thread-42' });
    expect(m.get(info.id)?.agentSessionId).toBe('thread-42');
    m.restart(info.id);
    const line = typeof spawned[1].args === 'string' ? spawned[1].args : spawned[1].args.join(' ');
    expect(line).toContain('resume thread-42');
    m.shutdown();
  });
});
