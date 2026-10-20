import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConsoleInfo } from '../../shared/protocol.js';
import { validateAgentSetting } from './settings.js';
import { codexArgs, codexStatusFromOutput, tomlArray, tomlString } from './codex.js';
import { geminiSystemSettings } from './gemini.js';
import { opencodeConfig } from './opencode.js';
import { shellCommand, validateCommand } from './custom.js';
import { resolveAgentExecutable, unwrapNodeShim } from './resolve.js';
import { AGENT_HEURISTICS, CUSTOM_HEURISTICS, OutputStatusTracker, detectConfirmation } from './output-status.js';
import { adapterFor } from './index.js';

function info(extra: Partial<ConsoleInfo> = {}): ConsoleInfo {
  return {
    id: 'c1',
    name: 'Ada',
    cwd: process.cwd(),
    sessionId: '11111111-1111-1111-1111-111111111111',
    status: 'starting',
    statusChangedAt: 0,
    layout: { x: 0, y: 0, width: 700, height: 500 },
    createdAt: 0,
    ...extra,
  };
}

// npm's cmd-shim for a package whose bin is a JS file (Codex, Gemini CLI)
const NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

function fakeFs(files: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p: string) => lower.has(p.toLowerCase()),
    readFile: (p: string) => {
      const content = lower.get(p.toLowerCase());
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
  };
}

describe('executable resolution', () => {
  const env = { Path: 'C:\\Program Files\\nodejs;C:\\Users\\me\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('unwraps an npm node shim into node + the JS entry point', () => {
    const fs = fakeFs({
      'C:\\Users\\me\\npm\\codex.cmd': NODE_SHIM,
      'C:\\Users\\me\\npm\\node_modules\\@openai\\codex\\bin\\codex.js': '',
      'C:\\Program Files\\nodejs\\node.exe': '',
    });
    expect(resolveAgentExecutable('codex', '', { platform: 'win32', env, ...fs })).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\Users\\me\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
      display: 'C:\\Users\\me\\npm\\codex.cmd',
    });
  });

  it('prefers a node.exe next to the shim, like the shim itself', () => {
    const fs = fakeFs({
      'C:\\tools\\codex.cmd': NODE_SHIM,
      'C:\\tools\\node.exe': '',
      'C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js': '',
    });
    expect(unwrapNodeShim('C:\\tools\\codex.cmd', { platform: 'win32', env, ...fs })?.node).toBe('C:\\tools\\node.exe');
  });

  it('keeps a .cmd it cannot unwrap (spawned through cmd.exe later) and honours a path override', () => {
    const fs = fakeFs({ 'D:\\bin\\gemini.cmd': '@echo off\r\nsomething %*' });
    expect(resolveAgentExecutable('gemini', 'D:\\bin\\gemini.cmd', { platform: 'win32', env, ...fs })).toEqual({
      file: 'D:\\bin\\gemini.cmd',
      prefixArgs: [],
      display: 'D:\\bin\\gemini.cmd',
    });
  });

  it('returns null when the CLI is not installed', () => {
    expect(resolveAgentExecutable('opencode', '', { platform: 'win32', env, ...fakeFs({}) })).toBeNull();
  });
});

describe('codex adapter', () => {
  const mcp = { command: 'C:\\node\\node.exe', args: ['C:\\tmp\\gridhive-mcp.cjs', 'http://127.0.0.1:4317', 'c1', 'tok'] };

  it('new session: per-process -c overrides for OSC 9 notifications, notify relay and the MCP server', () => {
    expect(codexArgs({ mode: 'new', mcp, notify: ['C:\\node\\node.exe', 'C:\\tmp\\codex-notify.cjs', 'http://x/hook/c1?token=t'] })).toEqual([
      '-c', 'tui.notifications=true',
      '-c', "tui.notification_method='osc9'",
      '-c', "tui.notification_condition='always'",
      '-c', "notify=['C:\\node\\node.exe','C:\\tmp\\codex-notify.cjs','http://x/hook/c1?token=t']",
      '-c', "mcp_servers.gridhive.command='C:\\node\\node.exe'",
      '-c', "mcp_servers.gridhive.args=['C:\\tmp\\gridhive-mcp.cjs','http://127.0.0.1:4317','c1','tok']",
    ]);
  });

  it('resume: the thread id when known, else --last; desktop app passes ELECTRON_RUN_AS_NODE to the MCP server', () => {
    expect(codexArgs({ mode: 'resume', threadId: 'abc-123' }).slice(0, 2)).toEqual(['resume', 'abc-123']);
    expect(codexArgs({ mode: 'resume' }).slice(0, 2)).toEqual(['resume', '--last']);
    const args = codexArgs({ mode: 'new', mcp: { ...mcp, env: { ELECTRON_RUN_AS_NODE: '1' } } });
    expect(args).toContain("mcp_servers.gridhive.env={ELECTRON_RUN_AS_NODE='1'}");
    expect(args).not.toContain('notify');
  });

  it('quotes TOML values as literal strings, falling back to basic strings for quotes', () => {
    expect(tomlString('C:\\Program Files\\x')).toBe("'C:\\Program Files\\x'");
    expect(tomlString("O'Brien")).toBe('"O\'Brien"');
    expect(tomlArray(['a', 'b c'])).toBe("['a','b c']");
  });

  it('reads OSC 9 notifications: approvals are needs_you, anything else ends the turn', () => {
    expect(codexStatusFromOutput('\x1b]9;Approval requested: npm install\x07')).toEqual({ status: 'needs_you', detail: 'Approval requested: npm install' });
    expect(codexStatusFromOutput('x\x1b]9;Agent turn complete\x1b\\y')).toEqual({ status: 'resting' });
    expect(codexStatusFromOutput('\x1b]0;window title\x07plain output')).toBeNull();
  });

  it('builds the launch through the resolved executable and never touches CLAUDE accounts', () => {
    const spec = adapterFor('codex').buildLaunch(info({ agent: 'codex' }), 'new', {
      port: 4444,
      token: 'tok',
      baseEnv: { PATH: process.env.PATH ?? '', HOME: 'h' },
      settings: { agentPaths: { codex: path.join(process.cwd(), 'tests', 'fake-cli', process.platform === 'win32' ? 'codex.cmd' : 'codex') } } as never,
      accountEnv: () => ({ CLAUDE_CONFIG_DIR: 'nope' }),
    });
    const args = typeof spec.args === 'string' ? spec.args : spec.args.join(' ');
    // The fake may run directly (file) or through node/cmd.exe (args), depending on the platform
    expect(`${spec.file} ${args}`).toMatch(/fake-cli|codex\.cmd/);
    expect(args).toContain("mcp_servers.gridhive.command=");
    expect(spec.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(spec.env.HOME).toBe('h');
  });
});

describe('gemini and opencode config', () => {
  const mcp = { command: 'node', args: ['mcp.cjs', 'http://127.0.0.1:1', 'c1', 't'] };

  it('gemini: adds a trusted gridhive server to a copy of the system settings', () => {
    expect(geminiSystemSettings({ theme: 'x', mcpServers: { mine: { command: 'a' } } }, mcp)).toEqual({
      theme: 'x',
      mcpServers: { mine: { command: 'a' }, gridhive: { ...mcp, trust: true } },
    });
  });

  it('gemini: status from output heuristics', () => {
    const adapter = adapterFor('gemini');
    expect(adapter.supportsHooks).toBe(false);
    expect(adapter.heuristics).toBe('agent');
  });

  it('opencode: a local MCP server in its own merged config file', () => {
    expect(opencodeConfig(mcp)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { gridhive: { type: 'local', command: ['node', 'mcp.cjs', 'http://127.0.0.1:1', 'c1', 't'], enabled: true } },
    });
  });
});

describe('custom commands', () => {
  it('runs through cmd.exe on Windows with the command verbatim', () => {
    expect(shellCommand('npm run dev -- --port "3000"', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: '/d /s /c "npm run dev -- --port "3000""',
    });
  });

  it('runs through $SHELL -lc elsewhere, /bin/sh when SHELL is unset or relative', () => {
    expect(shellCommand('ls | wc -l', { platform: 'linux', env: { SHELL: '/bin/zsh' } })).toEqual({ file: '/bin/zsh', args: ['-lc', 'ls | wc -l'] });
    expect(shellCommand('ls', { platform: 'darwin', env: { SHELL: 'zsh' } })).toEqual({ file: '/bin/sh', args: ['-lc', 'ls'] });
  });

  it('validates the command', () => {
    expect(validateCommand('  bash ')).toBe('bash');
    expect(() => validateCommand('')).toThrow(/needs a command/);
    expect(() => validateCommand('a\nb')).toThrow(/single line/);
    expect(() => validateCommand('x'.repeat(2001))).toThrow(/longer/);
  });

  it('has no resume and no hooks', () => {
    const adapter = adapterFor('custom');
    expect(adapter.supportsResume).toBe(false);
    expect(adapter.heuristics).toBe('custom');
    const spec = adapter.buildLaunch(info({ agent: 'custom', command: 'echo hi' }), 'resume', { port: 1, token: 't', baseEnv: { A: '1' } });
    expect(spec.env).toEqual({ A: '1' });
  });
});

describe('claude adapter', () => {
  it('is the default and keeps hook-driven status', () => {
    expect(adapterFor(undefined).id).toBe('claude');
    expect(adapterFor(undefined).heuristics).toBeUndefined();
  });
});

describe('agent settings', () => {
  const err = (m: string) => new Error(m);
  it('accepts known agents and trims path overrides', () => {
    expect(validateAgentSetting('defaultAgent', 'codex', err)).toEqual({ defaultAgent: 'codex' });
    expect(validateAgentSetting('agentPaths', { codex: ' C:\\x\\codex.cmd ', gemini: '' }, err)).toEqual({ agentPaths: { codex: 'C:\\x\\codex.cmd' } });
    expect(() => validateAgentSetting('defaultAgent', 'cursor', err)).toThrow();
    expect(() => validateAgentSetting('agentPaths', { claude: 'x' }, err)).toThrow();
  });
});

// Recorded-looking screens (ANSI as the TUIs draw them)
const CODEX_WORKING = '\x1b[2K\x1b[1G\x1b[1m•\x1b[0m \x1b[1mWorking\x1b[0m \x1b[2m(3s • esc to interrupt)\x1b[0m';
const CODEX_APPROVAL = [
  '\x1b[1mWould you like to run the following command?\x1b[0m',
  '',
  '  $ npm install left-pad',
  '',
  '\x1b[36m› 1. Yes, proceed (y)\x1b[0m',
  '  2. Yes, and don\'t ask again for this command (a)',
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '\x1b[2mPress enter to confirm or esc to cancel\x1b[0m',
].join('\r\n');
const GEMINI_CONFIRM = '\x1b[33m╭──────────╮\x1b[0m\r\n│ Allow execution of: \'rm -rf build\'? │\r\n│ ● 1. Allow once │\r\n│   2. Allow always │\r\n│   3. No (esc) │\r\n╰──────────╯';

describe('output status heuristics', () => {
  it('spots confirmation prompts: numbered Yes/No choices, y/n, Allow/Approve', () => {
    expect(detectConfirmation(CODEX_APPROVAL.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, ''))).toBe('Would you like to run the following command?');
    expect(detectConfirmation('Overwrite file? [y/N]')).toBe('Overwrite file? [y/N]');
    expect(detectConfirmation('Here are 1. apples 2. pears')).toBeNull();
    expect(detectConfirmation('1. Read the code\n2. Write tests')).toBeNull(); // a plain numbered list
  });

  it('agent: starting -> idle when the start-up screen settles, working while output streams after a prompt, resting when quiet', () => {
    const t = new OutputStatusTracker(AGENT_HEURISTICS, 0);
    t.feed('\x1b[2J\x1b[H>_ OpenAI Codex (v0.142.5)\r\n\r\n› ', 100);
    expect(t.evaluate('starting', 500)).toBeNull(); // still drawing
    expect(t.evaluate('starting', 3500)).toEqual({ status: 'idle' });
    t.noteInput('f', 4000);
    t.feed('\x1b[2K› f', 4050); // echo of a keystroke is not work
    expect(t.evaluate('idle', 4100)).toEqual({ status: 'idle' });
    t.noteInput('\r', 5000);
    t.feed(CODEX_WORKING, 5200);
    expect(t.evaluate('idle', 5300)).toEqual({ status: 'working' });
    t.feed(CODEX_WORKING.replace('3s', '4s'), 6200);
    expect(t.evaluate('working', 8000)).toEqual({ status: 'working' });
    expect(t.evaluate('working', 9300)).toEqual({ status: 'resting' });
  });

  it('agent: a confirmation prompt is needs_you until a key answers it', () => {
    const t = new OutputStatusTracker(AGENT_HEURISTICS, 0);
    t.noteInput('\r', 10);
    t.feed(GEMINI_CONFIRM, 100);
    expect(t.evaluate('working', 200)).toEqual({ status: 'needs_you', detail: "Allow execution of: 'rm -rf build'?" });
    t.noteInput('1', 1000);
    expect(t.evaluate('needs_you', 1100)?.status).toBe('working'); // answered, output still fresh
    expect(t.evaluate('needs_you', 5000)).toEqual({ status: 'resting' });
  });

  it('agent: Codex OSC 9 notifications override the output timing', () => {
    const t = new OutputStatusTracker({ ...AGENT_HEURISTICS, fromOutput: codexStatusFromOutput }, 0);
    t.noteInput('\r', 0);
    t.feed(CODEX_WORKING + '\x1b]9;Approval req', 100); // split across two chunks
    t.feed('uested: git push\x07', 120);
    expect(t.evaluate('working', 150)).toEqual({ status: 'needs_you', detail: 'Approval requested: git push' });
    t.noteInput('y', 500);
    t.feed(CODEX_WORKING + '\x1b]9;Agent turn complete\x07', 700);
    expect(t.evaluate('working', 800)).toEqual({ status: 'resting' });
    t.noteInput('\r', 900);
    t.feed(CODEX_WORKING, 950);
    expect(t.evaluate('resting', 1000)).toEqual({ status: 'working' });
  });

  it('custom: working while output streams, resting when quiet, never needs_you', () => {
    const t = new OutputStatusTracker(CUSTOM_HEURISTICS, 0);
    expect(t.evaluate('starting', 100)).toBeNull();
    t.feed('> vite\r\n  VITE ready in 300 ms\r\n  Overwrite? [y/N]', 200);
    expect(t.evaluate('starting', 300)).toEqual({ status: 'working' });
    expect(t.evaluate('working', 2000)).toEqual({ status: 'resting' });
    expect(t.evaluate('exited', 2000)).toBeNull();
  });
});

describe('answered prompts', () => {
  it('a dialog that is still visible but no longer at the bottom does not count (ConPTY repaints)', () => {
    const screen = CODEX_APPROVAL.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
    expect(detectConfirmation(`${screen}\n✔ Approved\nDone: ran it\n› `)).toBeNull();
    expect(detectConfirmation(`Overwrite? [y/N]\nyes\nwrote file\n$`)).toBeNull();
  });
});

describe('agent per row / team', () => {
  it('composer rows keep a CLI agent but never custom (rows have no command)', async () => {
    const { parseRows } = await import('../composer.js');
    expect(parseRows([{ role: 'A', agent: 'codex' }, { agent: 'custom' }, { agent: 'claude' }, { agent: 'nope' }])).toEqual([
      { role: 'A', agent: 'codex' },
      {},
      {},
      {},
    ]);
  });
});
