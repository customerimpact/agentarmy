import { execFileSync } from 'node:child_process';
import os from 'node:os';

// Apps started from the Finder, the Dock or Launchpad get a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so `claude`, `codex`, node and git from Homebrew, npm or the official installers are not found.
// Ask the user's login shell for its PATH once at startup, the PATH a terminal would see.

const MARK = '__AGENTARMY_PATH__';
const SHELL_TIMEOUT_MS = 5000;

// Usual install folders, in case the shell answers slowly or its rc files fail
export function commonBinDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.npm-global/bin`,
    `${home}/.bun/bin`,
    `${home}/.opencode/bin`,
  ];
}

// The shell's rc files may print banners; only the text between the markers counts
export function parseShellPath(output: string): string | null {
  const start = output.indexOf(MARK);
  const end = output.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return null;
  const value = output.slice(start + MARK.length, end).trim();
  return value || null;
}

// Joins PATH lists in order, dropping empty and repeated entries
export function mergePath(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dir of (list ?? '').split(':')) {
      if (dir) seen.add(dir);
    }
  }
  return [...seen].join(':');
}

export function loadShellPath(env: NodeJS.ProcessEnv = process.env): void {
  const shell = env.SHELL || '/bin/zsh';
  let fromShell: string | null = null;
  try {
    const output = execFileSync(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, DISABLE_AUTO_UPDATE: 'true' }, // oh-my-zsh: no update prompt
    });
    fromShell = parseShellPath(output);
  } catch (err) {
    console.warn(`[gridhive] could not read PATH from ${shell}: ${(err as Error).message}`);
  }
  env.PATH = mergePath(fromShell, env.PATH, commonBinDirs(env.HOME || os.homedir()).join(':'));
}
