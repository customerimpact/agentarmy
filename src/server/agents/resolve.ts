import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSpawnCommand, resolveOnPath, unwrapNpmShim, type ResolveOptions, type SpawnCommand } from '../claude-path.js';

// Where an agent CLI really lives. npm installs a .cmd shim on Windows; spawning that through
// cmd.exe works but Ctrl-C then asks "Terminate batch job (Y/N)?", so we unwrap it:
// shim -> native exe (Claude Code style) or shim -> node + JS entry point (Codex, Gemini CLI style).
export interface ResolvedExecutable {
  file: string;
  prefixArgs: string[]; // e.g. the JS entry point when file is node
  display: string; // what the user configured or what PATH gave us
}

const defaultReadFile = (p: string): string => fs.readFileSync(p, 'utf8');
const defaultIsFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// '"%dp0%\node_modules\@openai\codex\bin\codex.js" %*' -> the script, plus the node the shim would use
export function unwrapNodeShim(
  cmdPath: string,
  options: ResolveOptions = {},
): { node: string; script: string } | null {
  const readFile = options.readFile ?? defaultReadFile;
  const isFile = options.isFile ?? defaultIsFile;
  let content: string;
  try {
    content = readFile(cmdPath);
  } catch {
    return null;
  }
  const match = content.match(/"%dp0%\\([^"%]+\.(?:js|mjs|cjs))"/i);
  if (!match) return null;
  const dir = path.win32.dirname(cmdPath);
  const script = path.win32.join(dir, match[1]);
  if (!isFile(script)) return null;
  // The shim prefers a node.exe next to itself, then node on PATH
  const local = path.win32.join(dir, 'node.exe');
  const node = isFile(local) ? local : resolveOnPath('node', options);
  return node ? { node, script } : null;
}

export function resolveAgentExecutable(
  command: string,
  override: string | undefined,
  options: ResolveOptions = {},
): ResolvedExecutable | null {
  const platform = options.platform ?? process.platform;
  const wanted = override?.trim() || command;
  const found = resolveOnPath(wanted, options);
  if (!found) return null;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
    const exe = unwrapNpmShim(found, options);
    if (exe) return { file: exe, prefixArgs: [], display: found };
    const viaNode = unwrapNodeShim(found, options);
    if (viaNode) return { file: viaNode.node, prefixArgs: [viaNode.script], display: found };
  }
  return { file: found, prefixArgs: [], display: found };
}

// The final spawn line: unwrapped executables run directly, leftover .cmd files via cmd.exe /d /s /c
export function spawnFor(
  exe: ResolvedExecutable,
  args: string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): SpawnCommand {
  return buildSpawnCommand(exe.file, [...exe.prefixArgs, ...args], options);
}

const VERSION_TIMEOUT_MS = 8000;

// `<cli> --version`, first line. Never starts a session.
export function readVersion(exe: ResolvedExecutable, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const command = spawnFor(exe, ['--version']);
  return new Promise((resolve) => {
    const verbatim = typeof command.args === 'string'; // cmd.exe /d /s /c "...": a pre-quoted line
    const args = typeof command.args === 'string' ? [command.args] : command.args;
    const opts = { timeout: VERSION_TIMEOUT_MS, windowsHide: true, env, windowsVerbatimArguments: verbatim };
    execFile(command.file, args, opts, (err, stdout) => {
      if (err && !stdout) return resolve(undefined);
      // eslint-disable-next-line no-control-regex
      const text = String(stdout).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
      // A version line has a number in it; anything else (a banner, a TUI) is not a version
      const line = text.split(/\r?\n/).find((l) => /\d+\.\d+/.test(l));
      resolve(line?.trim().slice(0, 120));
    });
  });
}
