import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { AgentArmyServer, FAKE_CLAUDE_SHIM, REPO_ROOT } from '../e2e/helpers/server';

// `npx agentarmy` already runs on the same data folder: the app shows that board instead of starting
// a second server, and quitting the app leaves the CLI server alone.
test('the app attaches to a running CLI server and leaves it running on quit', async () => {
  const root = path.join(os.tmpdir(), 'agentarmy-desktop-test');
  fs.mkdirSync(root, { recursive: true });
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'attach-')));
  const server = await AgentArmyServer.start({ home });
  try {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENTARMY_HOME: path.join(home, '.agentarmy'),
      AGENTARMY_PORT: String(server.port + 1), // must not be used
      AGENTARMY_CLAUDE_PATH: FAKE_CLAUDE_SHIM,
      AGENTARMY_DISABLE_UPDATES: '1',
      HOME: home,
      USERPROFILE: home,
    };
    delete env.CLAUDECODE;
    delete env.AGENTARMY_TOKEN;
    const exe = process.env.DESKTOP_EXE;
    const app = await electron.launch({
      ...(exe ? { executablePath: exe, args: [] } : { args: [path.join(REPO_ROOT, 'dist', 'desktop', 'main.js')] }),
      env,
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).port).toBe(String(server.port));
    const owns = await app.evaluate(
      () => (globalThis as unknown as { __agentarmyDesktop: { ownsServer: () => boolean } }).__agentarmyDesktop.ownsServer(),
    );
    expect(owns).toBe(false);

    const closed = app.waitForEvent('close');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await closed;
    // Still serving
    await expect(server.api('GET', '/api/state')).resolves.toBeTruthy();
  } finally {
    await server.stop();
  }
});
