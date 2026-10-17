import fs from 'node:fs';
import path from 'node:path';

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

export interface SpawnCommand {
  file: string;
  // node-pty accepts a pre-escaped command line string on Windows, which we need for cmd.exe
  args: string[] | string;
}

const defaultIsFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const defaultReadFile = (p: string): string => fs.readFileSync(p, 'utf8');

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows env names are case-insensitive (Path vs PATH)
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

export function resolveOnPath(command: string, options: ResolveOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? defaultIsFile;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const isWindows = platform === 'win32';

  const extensions = isWindows
    ? (getEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidatesFor = (base: string): string[] => {
    if (!isWindows) return [base];
    const hasKnownExt = extensions.some((ext) => base.toLowerCase().endsWith(ext.toLowerCase()));
    return hasKnownExt ? [base] : extensions.map((ext) => base + ext.toLowerCase());
  };

  if (command.includes('/') || command.includes('\\')) {
    return candidatesFor(command).find(isFile) ?? null;
  }

  const dirs = (getEnv(env, 'PATH') ?? '').split(isWindows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidatesFor(pathApi.join(dir.replace(/^"|"$/g, ''), command))) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// npm's cmd-shim launches a native exe via "%dp0%\...". Spawning that exe directly avoids
// cmd.exe's "Terminate batch job (Y/N)?" prompt when the user presses Ctrl-C.
export function unwrapNpmShim(cmdPath: string, options: ResolveOptions = {}): string | null {
  const isFile = options.isFile ?? defaultIsFile;
  const readFile = options.readFile ?? defaultReadFile;
  let content: string;
  try {
    content = readFile(cmdPath);
  } catch {
    return null;
  }
  const match = content.match(/"%dp0%\\([^"%]+\.exe)"/i);
  if (!match) return null;
  const target = path.win32.join(path.win32.dirname(cmdPath), match[1]);
  return isFile(target) ? target : null;
}

export function resolveClaudeExecutable(options: ResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = env.AGENTARMY_CLAUDE_PATH;
  const resolved = override ? resolveOnPath(override, options) : resolveOnPath('claude', options);
  if (!resolved) {
    throw new Error(
      override
        ? `AGENTARMY_CLAUDE_PATH points to a missing file: ${override}`
        : 'Could not find "claude" on PATH. Install Claude Code or set AGENTARMY_CLAUDE_PATH.',
    );
  }
  if (platform === 'win32' && isBatchFile(resolved)) {
    return unwrapNpmShim(resolved, options) ?? resolved;
  }
  return resolved;
}

function isBatchFile(p: string): boolean {
  return /\.(cmd|bat)$/i.test(p);
}

// Quote one argument for a cmd.exe command line. Inside double quotes cmd treats & | < > ^
// literally; a bare double quote cannot be represented, and Windows paths never contain one.
export function quoteCmdArg(arg: string): string {
  if (arg.includes('"')) throw new Error(`Argument contains a double quote: ${arg}`);
  if (arg !== '' && !/[\s&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg}"`;
}

export function buildSpawnCommand(
  executable: string,
  args: string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): SpawnCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === 'win32' && isBatchFile(executable)) {
    const comspec = getEnv(env, 'ComSpec') ?? 'cmd.exe';
    // /s strips exactly the outer quotes, so the inner quoting survives untouched
    const inner = [executable, ...args].map(quoteCmdArg).join(' ');
    return { file: comspec, args: `/d /s /c "${inner}"` };
  }
  return { file: executable, args };
}
