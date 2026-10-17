import { describe, expect, it } from 'vitest';
import {
  buildSpawnCommand,
  quoteCmdArg,
  resolveClaudeExecutable,
  resolveOnPath,
  unwrapNpmShim,
} from './claude-path.js';

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
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

describe('resolveOnPath', () => {
  const env = { Path: 'C:\\Windows;C:\\Users\\me\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('finds a .cmd shim on Windows using PATHEXT and a case-insensitive Path variable', () => {
    const fs = fakeFs({ 'C:\\Users\\me\\npm\\claude.cmd': '' });
    expect(resolveOnPath('claude', { platform: 'win32', env, ...fs })).toBe(
      'C:\\Users\\me\\npm\\claude.cmd',
    );
  });

  it('prefers the earlier PATHEXT entry in the same directory', () => {
    const fs = fakeFs({
      'C:\\Users\\me\\npm\\claude.exe': '',
      'C:\\Users\\me\\npm\\claude.cmd': '',
    });
    expect(resolveOnPath('claude', { platform: 'win32', env, ...fs })).toBe(
      'C:\\Users\\me\\npm\\claude.exe',
    );
  });

  it('ignores the extensionless bash shim npm writes next to the .cmd', () => {
    const fs = fakeFs({ 'C:\\Users\\me\\npm\\claude': '', 'C:\\Users\\me\\npm\\claude.cmd': '' });
    expect(resolveOnPath('claude', { platform: 'win32', env, ...fs })).toBe(
      'C:\\Users\\me\\npm\\claude.cmd',
    );
  });

  it('uses plain names on POSIX', () => {
    const fs = fakeFs({ '/usr/local/bin/claude': '' });
    const posixEnv = { PATH: '/usr/bin:/usr/local/bin' };
    expect(resolveOnPath('claude', { platform: 'linux', env: posixEnv, ...fs })).toBe(
      '/usr/local/bin/claude',
    );
  });

  it('returns null when nothing matches', () => {
    expect(resolveOnPath('claude', { platform: 'win32', env, ...fakeFs({}) })).toBeNull();
  });
});

describe('unwrapNpmShim / resolveClaudeExecutable', () => {
  const shim = 'C:\\Users\\me\\npm\\claude.cmd';
  const exe = 'C:\\Users\\me\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

  it('follows an npm cmd-shim to the native exe', () => {
    expect(unwrapNpmShim(shim, fakeFs({ [shim]: NPM_SHIM, [exe]: '' }))).toBe(exe);
  });

  it('keeps the .cmd when the shim target is missing', () => {
    const fs = fakeFs({ [shim]: NPM_SHIM });
    expect(
      resolveClaudeExecutable({ platform: 'win32', env: { PATH: 'C:\\Users\\me\\npm' }, ...fs }),
    ).toBe(shim);
  });

  it('honours AGENTARMY_CLAUDE_PATH', () => {
    const custom = 'D:\\tools\\claude.exe';
    const fs = fakeFs({ [custom]: '' });
    expect(
      resolveClaudeExecutable({ platform: 'win32', env: { AGENTARMY_CLAUDE_PATH: custom }, ...fs }),
    ).toBe(custom);
  });

  it('throws a helpful error when claude is not installed', () => {
    expect(() => resolveClaudeExecutable({ platform: 'win32', env: {}, ...fakeFs({}) })).toThrow(
      /Could not find "claude"/,
    );
  });
});

describe('quoteCmdArg', () => {
  it('leaves simple arguments alone', () => {
    expect(quoteCmdArg('--resume')).toBe('--resume');
    expect(quoteCmdArg('C:\\Users\\me\\claude.cmd')).toBe('C:\\Users\\me\\claude.cmd');
  });

  it('quotes spaces and cmd metacharacters', () => {
    expect(quoteCmdArg('C:\\Program Files\\x.json')).toBe('"C:\\Program Files\\x.json"');
    expect(quoteCmdArg('a&b')).toBe('"a&b"');
    expect(quoteCmdArg('')).toBe('""');
  });

  it('rejects embedded double quotes', () => {
    expect(() => quoteCmdArg('a"b')).toThrow();
  });
});

describe('buildSpawnCommand', () => {
  it('wraps .cmd files in cmd.exe /d /s /c with a pre-escaped command line', () => {
    const cmd = buildSpawnCommand(
      'C:\\Users\\Jane Doe\\npm\\claude.cmd',
      ['--settings', 'C:\\Temp\\a b.json'],
      { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } },
    );
    expect(cmd).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: '/d /s /c ""C:\\Users\\Jane Doe\\npm\\claude.cmd" --settings "C:\\Temp\\a b.json""',
    });
  });

  it('spawns .exe files directly with an argv array', () => {
    expect(
      buildSpawnCommand('C:\\bin\\claude.exe', ['--resume', 'x'], { platform: 'win32' }),
    ).toEqual({ file: 'C:\\bin\\claude.exe', args: ['--resume', 'x'] });
  });
});
