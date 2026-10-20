import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHookSettings, hookUrl, removeSettingsFile, writeSettingsFile } from './hook-settings.js';
import { mcpConfigPath, mcpScriptPath, MCP_SCRIPT_SOURCE, writeMcpConfigFile } from './mcp-bridge.js';

describe('hook settings + MCP config files', () => {
  it('pre-approves the gridhive MCP tools', () => {
    const settings = buildHookSettings(hookUrl(1, 'c', 't'), { node: 'n', script: 's' });
    expect(settings.permissions).toEqual({ allow: ['mcp__gridhive'] });
  });

  it('writes the per-console MCP config next to the settings file and removes both', () => {
    const id = `test-${process.pid}-${Date.now()}`;
    const settingsFile = writeSettingsFile(id, 4400, 'tok');
    const mcpFile = writeMcpConfigFile(id, 4400, 'tok');
    expect(mcpFile).toBe(mcpConfigPath(id));
    expect(JSON.parse(fs.readFileSync(mcpFile, 'utf8'))).toEqual({
      mcpServers: {
        gridhive: {
          command: process.execPath,
          args: [mcpScriptPath(), 'http://127.0.0.1:4400', id, 'tok'],
        },
      },
    });
    expect(fs.readFileSync(mcpScriptPath(), 'utf8')).toBe(MCP_SCRIPT_SOURCE);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).permissions.allow).toContain('mcp__gridhive');
    removeSettingsFile(id);
    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(fs.existsSync(mcpFile)).toBe(false);
  });
});
