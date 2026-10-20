import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo, MemoryDoc } from '../../src/shared/protocol';
import { consoleNode, expectStatus, expectTerminalToContain, flyToConsole } from './helpers/board';
import { AgentArmyServer, waitFor } from './helpers/server';

// Handoffs (quick brief from Ada's transcript typed into Bex, drawn as a job line) and project memory
test.describe.configure({ mode: 'serial' });

const BASE = process.env.AA_E2E_TMP ?? path.join(os.tmpdir(), 'aa-v03-B');
const SHOTS = process.env.AA_E2E_SHOTS ?? BASE;
let home: string;
let dir: string;
let server: AgentArmyServer;
let page: Page;
let ada: ConsoleInfo;
let bex: ConsoleInfo;
let cy: ConsoleInfo;

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(BASE, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(BASE, 'handoff-')));
  dir = path.join(home, 'shop');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  server = await AgentArmyServer.start({
    home,
    port: process.env.AA_E2E_PORT ? Number(process.env.AA_E2E_PORT) : undefined,
    env: { FAKE_CLAUDE_REAL_TRANSCRIPTS: '1', FAKE_CLAUDE_DELAY_MS: '600' },
  });
  ada = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Ada', layout: { x: 0, y: 0, width: 640, height: 400 } });
  bex = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Bex', layout: { x: 760, y: 0, width: 640, height: 400 } });
  cy = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Cy', layout: { x: 0, y: 520, width: 640, height: 400 } });
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('quick handoff from Ada to Bex types the brief and draws a job line', async () => {
  await page.goto(server.url);
  for (const c of [ada, bex, cy]) await expectStatus(page, c.id, 'idle');

  // Give Ada some history: a plan (todos) and an edit (files touched)
  await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'plan' });
  await expectTerminalToContain(page, ada.id, 'Done: plan');
  await expectStatus(page, ada.id, 'resting');
  await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'edit' });
  await expectTerminalToContain(page, ada.id, 'Done: edit');
  await expectStatus(page, ada.id, 'resting');

  await flyToConsole(page, ada.id);
  await consoleNode(page, ada.id).getByTestId('console-handoff').click();
  const dialog = page.getByTestId('handoff-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator(`[data-testid="handoff-target"][data-console-id="${bex.id}"]`).click();
  await dialog.getByTestId('handoff-mode-quick').click();
  await dialog.getByTestId('handoff-note').fill('Finish the tests next.');
  await dialog.getByTestId('handoff-build').click();

  const brief = dialog.getByTestId('handoff-brief');
  await expect(brief).toHaveValue(/^\[GridHive handoff from Ada\]/);
  const text = await brief.inputValue();
  expect(text).toContain('Finish the tests next.');
  expect(text).toContain('- plan');
  expect(text).toContain('- [~] Build the page (in progress)');
  expect(text).toContain('- [ ] Write the tests');
  expect(text).toContain('- src/app.ts');
  expect(text).toContain('Edited src/app.ts.');
  await page.screenshot({ path: path.join(SHOTS, 'handoff-preview.png') });

  await dialog.getByTestId('handoff-send').click();
  await expect(dialog).toBeHidden();

  // Bex got it (the fake CLI submits the first line of a paste) and the board shows the job line
  await expectTerminalToContain(page, bex.id, 'Done: [GridHive handoff from Ada]');
  const job = await waitFor(async () => {
    const state = await server.api<BoardState>('GET', '/api/state');
    return state.jobs.find((j) => j.kind === 'handoff' && j.fromId === ada.id && j.toId === bex.id && j.status === 'done');
  }, { message: 'a done handoff job from Ada to Bex' });
  expect(job.title).toBe('Handoff: Ada → Bex');
  expect(job.message).toContain('Write the tests');
  await expect(page.locator(`[data-testid="flow-edge"][data-source="${ada.id}"][data-target="${bex.id}"]`)).toHaveCount(1);
  // The handoff never types a "finished" note back into Ada
  await page.waitForTimeout(500);
  expect(await consoleNode(page, ada.id).locator('.xterm-rows').textContent()).not.toContain('GridHive]');
});

test('smart mode runs claude -p (fake) through the .cmd shim and uses its output', async () => {
  const p = await server.api<{ brief: string; mode: string; warning?: string }>('POST', '/api/handoffs', { fromId: ada.id, toId: bex.id, mode: 'smart' });
  expect(p.warning).toBeUndefined();
  expect(p.mode).toBe('smart');
  expect(p.brief).toMatch(/^\[GridHive handoff from Ada\]/);
  expect(p.brief).toContain('Goal: fake smart brief');
  // --settings is consumed by the fake itself; the empty --tools value survives cmd.exe quoting
  expect(p.brief).toContain('Args: -p --model haiku --output-format text --strict-mcp-config --tools  --no-session-persistence');
});

test('handoff to a new agent here launches it and sends the brief once it is ready', async () => {
  const res = await server.api<{ console: ConsoleInfo }>('POST', '/api/handoffs/send', {
    fromId: ada.id,
    newAgent: { cwd: dir, name: 'Dax' },
    brief: 'Pick up the checkout work.',
  });
  expect(res.console.name).toBe('Dax');
  await expect(page.locator(`[data-testid="mission-item"][data-console-id="${res.console.id}"]`)).toBeVisible();
  await flyToConsole(page, res.console.id);
  await expectTerminalToContain(page, res.console.id, 'Done: Pick up the checkout work.', 20_000);
});

test('memory panel: edit project memory and push it to agents', async () => {
  await page.getByTestId('open-memory').click();
  const panel = page.getByTestId('memory-panel');
  await expect(panel).toBeVisible();
  await panel.locator(`[data-testid="memory-scope"][data-scope="folder"]`).first().click();
  await expect(panel.getByTestId('memory-title')).toHaveText('shop');
  await panel.getByTestId('memory-editor').fill('# Shop\n- Use pnpm, not npm\n- Tests: `npx vitest run`');
  await panel.getByTestId('memory-save').click();
  await expect(panel.getByTestId('memory-save')).toHaveText('Saved');
  await panel.getByTestId('memory-autopush').check();
  await page.screenshot({ path: path.join(SHOTS, 'memory-panel.png') });

  const doc = await server.api<MemoryDoc>('GET', `/api/memory?scope=folder&path=${encodeURIComponent(dir)}`);
  expect(doc).toMatchObject({ content: '# Shop\n- Use pnpm, not npm\n- Tests: `npx vitest run`', autoPush: true });

  await panel.getByTestId('memory-preview-toggle').click();
  await expect(panel.getByTestId('memory-preview')).toContainText('Use pnpm, not npm');

  await panel.getByTestId('memory-push').click();
  const picker = panel.getByTestId('memory-push-picker');
  // Everyone in the folder that can take typing is preselected; more than 2 asks for a confirm click
  await picker.locator(`[data-testid="memory-push-target"][data-console-id="${bex.id}"] input`).uncheck();
  await expect(picker.getByTestId('memory-push-confirm')).toHaveText(/Push to 3 agents/);
  await picker.getByTestId('memory-push-confirm').click();
  await expect(picker.getByTestId('memory-push-confirm')).toHaveText(/Yes, push to all 3/);
  await picker.getByTestId('memory-push-confirm').click();
  await expect(picker).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await flyToConsole(page, cy.id);
  await expectTerminalToContain(page, cy.id, 'Done: Project memory (from GridHive):');
});

test('memory is pushed automatically into a new agent in the folder', async () => {
  const eve = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Eve', layout: { x: 760, y: 520, width: 640, height: 400 } });
  await expect(page.locator(`[data-testid="mission-item"][data-console-id="${eve.id}"]`)).toBeVisible();
  await flyToConsole(page, eve.id);
  await expectTerminalToContain(page, eve.id, 'Done: Project memory (from GridHive):', 20_000);
});
