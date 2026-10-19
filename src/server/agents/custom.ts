import { resolveOnPath } from '../claude-path.js';
import { assertCwd } from './common.js';
import type { AgentAdapter, LaunchSpec } from './types.js';

// Any command line the local user typed in the UI (npm run dev, aider, bash, ...), run through their
// shell so pipes, && and quoting behave as in a terminal. No resume: restart re-runs the command.
// Status is PTY activity only (working while output streams, resting when quiet, exited).
export const MAX_COMMAND_LENGTH = 2000;

export function shellCommand(
  command: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Omit<LaunchSpec, 'env'> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === 'win32') {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'COMSPEC');
    const comspec = (key && env[key]) || 'cmd.exe';
    // A pre-quoted line (node-pty passes strings verbatim on Windows); /s strips only the outer quotes,
    // so the user's own quotes reach cmd.exe untouched
    return { file: comspec, args: `/d /s /c "${command}"` };
  }
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/sh';
  return { file: shell, args: ['-lc', command] };
}

export function validateCommand(command: unknown): string {
  if (typeof command !== 'string' || !command.trim()) throw new Error('A custom console needs a command');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`Command is longer than ${MAX_COMMAND_LENGTH} characters`);
  if (/[\r\n\0]/.test(command)) throw new Error('Command must be a single line');
  return command.trim();
}

function shellPath(): string {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/sh';
  return process.env.ComSpec || resolveOnPath('cmd') || 'cmd.exe';
}

export const customAdapter: AgentAdapter = {
  id: 'custom',
  label: 'Custom command',
  supportsResume: false,
  supportsHooks: false,
  heuristics: 'custom',
  supportsMcp: false,
  notes: process.platform === 'win32' ? 'Runs with cmd.exe /d /s /c.' : 'Runs with $SHELL -lc.',

  async detect() {
    return { installed: true, path: shellPath() };
  },

  buildLaunch(info, _mode, ctx) {
    const command = validateCommand(info.command);
    assertCwd(info.cwd);
    return { ...shellCommand(command, { env: ctx.baseEnv }), env: { ...ctx.baseEnv } };
  },
};
