import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, expectStatus, expectTerminalToContain } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// When `claude --resume` fails right away (conversation gone), the server starts a fresh session
test('a resume that fails falls back to a new session', async ({ page }) => {
  const home = makeTempHome('fallback');
  const project = path.join(home, 'gamma-project');
  fs.mkdirSync(project);
  let server = await AgentArmyServer.start({ home });
  try {
    const created = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: project });
    await waitFor(async () => {
      const state = await server.api<BoardState>('GET', '/api/state');
      return state.consoles[0]?.status === 'idle';
    });
    const stateFile = server.stateFile;
    await waitFor(() => fs.readFileSync(stateFile, 'utf8').includes('"idle"'), {
      message: 'state.json saved',
    });

    await server.stop();
    server = await AgentArmyServer.start({ home, env: { FAKE_CLAUDE_FAIL_RESUME: '1' } });
    expect(await server.api<{ resumed: number }>('POST', '/api/resume-all')).toEqual({ resumed: 1 });

    const restored = await waitFor(
      async () => {
        const c = (await server.api<BoardState>('GET', '/api/state')).consoles[0];
        return c && c.status === 'idle' && c.sessionId !== created.sessionId ? c : null;
      },
      { timeout: 20_000, message: 'a new session after the failed resume' },
    );
    expect(restored.id).toBe(created.id);
    expect(restored.statusDetail).toMatch(/Could not resume/);

    await page.goto(server.url);
    await expectStatus(page, created.id, 'idle');
    await expectTerminalToContain(page, created.id, `session ${restored.sessionId}`);
    await expect(consoleNode(page, created.id).getByTestId('console-status')).toHaveAttribute(
      'title',
      /Could not resume/,
    );
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
