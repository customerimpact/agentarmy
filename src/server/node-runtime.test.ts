import { describe, expect, it } from 'vitest';
import { forwarderCommand, nodeScriptCommand, powershellPath } from './node-runtime.js';
import { buildMcpConfig } from './mcp-bridge.js';

describe('nodeScriptCommand', () => {
  it('runs scripts with plain node under the CLI', () => {
    expect(nodeScriptCommand('s.cjs', ['a'], 'node.exe', false)).toEqual({ command: 'node.exe', args: ['s.cjs', 'a'] });
  });

  it('sets ELECTRON_RUN_AS_NODE for the desktop app only on that child', () => {
    expect(nodeScriptCommand('s.cjs', ['a'], 'AgentArmy.exe', true)).toEqual({
      command: 'AgentArmy.exe',
      args: ['s.cjs', 'a'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('carries the env into the MCP config', () => {
    const config = buildMcpConfig('AgentArmy.exe', 'mcp.cjs', 'http://127.0.0.1:1', 'c', 't', true);
    expect(config.mcpServers.agentarmy.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(buildMcpConfig('node', 'mcp.cjs', 'http://x', 'c', 't', false).mcpServers.agentarmy.env).toBeUndefined();
  });
});

describe('forwarderCommand', () => {
  it('uses node + the .cjs relay under the CLI', () => {
    expect(forwarderCommand({ node: 'f.cjs', powershell: 'f.ps1' }, { electron: false, execPath: 'node' })).toEqual({
      command: 'node',
      args: ['f.cjs'],
    });
  });

  it('uses the PowerShell relay in the Windows desktop app', () => {
    const cmd = forwarderCommand({ node: 'f.cjs', powershell: 'f.ps1' }, { electron: true, platform: 'win32' });
    expect(cmd.command).toBe(powershellPath());
    expect(cmd.args.slice(-2)).toEqual(['-File', 'f.ps1']);
  });

  it('wraps the Electron binary with sh on macOS/Linux', () => {
    const cmd = forwarderCommand({ node: 'f.cjs' }, { electron: true, platform: 'darwin', execPath: '/A.app/A' });
    expect(cmd).toEqual({ command: '/bin/sh', args: ['-c', 'ELECTRON_RUN_AS_NODE=1 exec "$0" "$@"', '/A.app/A', 'f.cjs'] });
  });
});
