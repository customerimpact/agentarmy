// How child processes (Claude Code's SessionStart hook, the MCP bridge) run our small Node scripts.
// Under the CLI process.execPath is node. Inside the desktop app it is GridHive.exe (Electron), which
// only behaves like node with ELECTRON_RUN_AS_NODE=1. That variable must never reach the console's own
// environment: it would break any Electron app the user or the agent starts from that terminal.

export interface ScriptCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function isElectron(): boolean {
  return typeof process.versions.electron === 'string';
}

// For launchers that accept an env block (MCP server configs)
export function nodeScriptCommand(script: string, args: string[], execPath = process.execPath, electron = isElectron()): ScriptCommand {
  return electron
    ? { command: execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: execPath, args: [script, ...args] };
}

// PowerShell forwarder for the desktop app on Windows: command hooks cannot set env vars, and
// GridHive.exe without ELECTRON_RUN_AS_NODE would start the app instead of running the script.
// Reads stdin as raw bytes (no codepage mangling), posts it, retries once, never prints, always exits 0.
export const POWERSHELL_FORWARDER_SOURCE = `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$url = $args[0]
$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
$body = $buffer.ToArray()
for ($i = 0; $i -lt 2; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 8 | Out-Null
    break
  } catch {}
}
exit 0
`;

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// Command (exec form, no shell) that relays a hook payload from stdin to `url`, minus the url argument
export function forwarderCommand(
  scripts: { node: string; powershell?: string },
  options: { electron?: boolean; platform?: NodeJS.Platform; execPath?: string } = {},
): ScriptCommand {
  const electron = options.electron ?? isElectron();
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  if (!electron) return { command: execPath, args: [scripts.node] };
  if (platform === 'win32' && scripts.powershell) {
    return {
      command: powershellPath(),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scripts.powershell],
    };
  }
  // POSIX: a one-line sh wrapper sets the variable for this child only
  return { command: '/bin/sh', args: ['-c', 'ELECTRON_RUN_AS_NODE=1 exec "$0" "$@"', execPath, scripts.node] };
}
