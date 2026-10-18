import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, BrowserTile, ConsoleInfo, RecapResponse } from '../../src/shared/protocol';
import { findBrowser } from '../../src/server/browsers/chrome-finder';
import { consoleNode, expectStatus, expectTerminalToContain, typeInTerminal } from './helpers/board';
import { AgentArmyServer, waitFor } from './helpers/server';

// Auto dev previews end to end: the fake CLI's "serve" prompt starts a real HTTP server and prints a
// Vite-style "Local: http://localhost:<port>/" line; a browser tile linked to that console must open
// to its right and load the page. Then the daily recap shows what happened.

test.describe.configure({ mode: 'serial' });

const browserPath = process.env.AGENTARMY_BROWSER_PATH || findBrowser();
// Isolated from the user's board: own data folder, fixed test port
const PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4424);
const ROOT = process.env.E2E_PREVIEW_HOME ?? os.tmpdir();

let home: string;
let server: AgentArmyServer;
let page: Page;
let ada: ConsoleInfo;

const state = () => server.api<BoardState>('GET', '/api/state');

// Chrome processes started for tiles live under this run's data folder; take down only those
function killOurChromes(): void {
  if (process.platform !== 'win32' || !home) return;
  const needle = path.join(home, '.agentarmy', 'browsers').replace(/'/g, "''");
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore' },
  );
}

test.beforeAll(async ({ browser }) => {
  test.skip(!browserPath, 'No Chrome, Edge or Chromium found: browser tiles cannot start, so previews cannot be checked');
  fs.mkdirSync(ROOT, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(ROOT, 'agentarmy-e2e-preview-')));
  fs.mkdirSync(path.join(home, 'shop'));
  fs.mkdirSync(path.join(home, 'docs'));
  server = await AgentArmyServer.start({ home, port: PORT, env: {
      FAKE_CLAUDE_DELAY_MS: '600',
      AGENTARMY_BROWSER_PATH: browserPath!,
      // Chrome on Windows starts too slowly (or not at all) with USERPROFILE pointing at an empty folder
      HOME: os.homedir(),
      USERPROFILE: os.homedir(),
    } });
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close().catch(() => undefined);
  if (server) {
    // Close tiles through the API so their Chrome processes exit cleanly
    const tiles = await state().then((s) => s.browsers).catch(() => [] as BrowserTile[]);
    for (const t of tiles) await server.api('DELETE', `/api/browsers/${t.id}`).catch(() => undefined);
    await server.stop();
  }
  killOurChromes();
  if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a dev server started in a console opens a linked preview tile next to it', async ({}, testInfo) => {
  ada = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: path.join(home, 'shop'), name: 'Ada', layout: { x: 0, y: 0, width: 720, height: 460 } });
  await page.goto(server.url);
  await expectStatus(page, ada.id, 'idle');

  await typeInTerminal(page, ada.id, 'plan');
  await expectTerminalToContain(page, ada.id, 'Done: plan');
  await typeInTerminal(page, ada.id, 'edit');
  await expectTerminalToContain(page, ada.id, 'Done: edit');
  await typeInTerminal(page, ada.id, 'serve');
  await expectTerminalToContain(page, ada.id, 'Local:');

  const tile = await waitFor(async () => (await state()).browsers.find((b) => b.linkedConsoleId === ada.id), {
    timeout: 25_000,
    message: 'a preview tile linked to Ada',
  });
  expect(tile.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  // Placed to the right of the console
  expect(tile.layout.x).toBeGreaterThanOrEqual(ada.layout.x + ada.layout.width);
  expect(tile.layout.y).toBe(ada.layout.y);

  const node = page.locator(`[data-testid="browser-node"][data-browser-id="${tile.id}"]`);
  await expect(node).toBeAttached();
  // The page really loaded in the tile's Chromium (title comes from the page itself)
  await waitFor(async () => (await state()).browsers.find((b) => b.id === tile.id)?.title === 'Fake dev server', {
    timeout: 30_000,
    message: 'the preview page title',
  });
  await expect(node.getByTestId('browser-url')).toHaveValue(/localhost:\d+/);
  await expect(node.getByTestId('browser-canvas')).toBeVisible();

  // Printing the same URL again (TUI redraws) does not open a second tile
  await typeInTerminal(page, ada.id, 'serve');
  await expectTerminalToContain(page, ada.id, 'Dev server is running');
  await page.waitForTimeout(1500);
  expect((await state()).browsers.filter((b) => b.linkedConsoleId === ada.id)).toHaveLength(1);

  // Bring both onto the screen for the screenshot
  await page.getByTestId('command-bar').getByRole('button', { name: 'Fit all' }).click();
  await expect(node).toBeInViewport();
  await page.waitForTimeout(1500); // fit animation + a few screencast frames
  await page.screenshot({ path: testInfo.outputPath('preview-tile.png') });
});

test('ask first: a toast offers the preview and opens it on click', async () => {
  await server.api('PATCH', '/api/settings', { previewMode: 'ask' });
  const bex = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: path.join(home, 'docs'), name: 'Bex', layout: { x: 0, y: 1400, width: 720, height: 460 } });
  await expect(consoleNode(page, bex.id)).toBeAttached();
  await expectStatus(page, bex.id, 'idle');
  await server.api('POST', `/api/consoles/${bex.id}/send`, { text: 'serve' });

  const offer = page.getByTestId('preview-offer');
  await expect(offer).toBeVisible({ timeout: 25_000 });
  await expect(offer).toContainText('Bex started localhost:');
  expect((await state()).browsers.some((b) => b.linkedConsoleId === bex.id)).toBe(false);
  await offer.getByTestId('preview-offer-yes').click();
  await expect(offer).toBeHidden();
  await waitFor(async () => (await state()).browsers.find((b) => b.linkedConsoleId === bex.id), { message: 'Bex preview tile' });
});

test('the daily recap lists what the agents did', async ({}, testInfo) => {
  const { recap, markdown } = await server.api<RecapResponse>('GET', '/api/recap');
  const a = recap.projects.flatMap((p) => p.agents).find((x) => x.name === 'Ada')!;
  expect(a.prompts).toBeGreaterThanOrEqual(4);
  expect(a.todosCompleted).toContain('Sketch the layout');
  expect(a.files).toContain('src/app.ts');
  expect(a.highlights.some((h) => h.startsWith('Opened preview http://localhost:'))).toBe(true);
  expect(a.next.map((t) => t.content)).toEqual(['Build the page', 'Write the tests']);
  expect(markdown).toContain('### Ada');

  await page.getByTestId('sidebar-tab-progress').click();
  await page.getByTestId('recap-open').click();
  const modal = page.getByTestId('recap-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('recap-agent').filter({ hasText: 'Ada' })).toContainText('Sketch the layout');
  await expect(modal).toContainText('Opened preview http://localhost:');
  await expect(modal.getByTestId('recap-day')).toHaveText('Today');
  // No webhook configured: no send buttons
  await expect(modal.getByTestId('recap-send-slack')).toHaveCount(0);
  await modal.screenshot({ path: testInfo.outputPath('recap-modal.png') });

  await modal.getByTestId('recap-prev').click();
  await expect(modal.getByTestId('recap-day')).toHaveText('Yesterday');
  await expect(modal).toContainText('No agent activity was recorded on this day.');
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});
