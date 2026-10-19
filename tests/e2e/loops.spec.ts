import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo, Loop, Project } from '../../src/shared/protocol';
import { consoleNode, expectStatus, expectTerminalToContain } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Loops (WHEN / TARGET / STOP), Pause all / Resume all and one prompt to a whole team,
// against the fake Claude CLI.
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let ada: ConsoleInfo;
let bex: ConsoleInfo;

const port = process.env.AA_E2E_PORT ? Number(process.env.AA_E2E_PORT) : undefined;
const loops = () => server.api<Loop[]>('GET', '/api/loops');
const state = () => server.api<BoardState>('GET', '/api/state');

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('loops');
  fs.mkdirSync(path.join(home, 'work'));
  // Turns take 3 s so "Pause all" can catch an agent while it works
  server = await AgentArmyServer.start({ home, port, env: { FAKE_CLAUDE_DELAY_MS: '3000' } });
  const cwd = path.join(home, 'work');
  ada = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd, name: 'Ada', layout: { x: 0, y: 0, width: 640, height: 380 } });
  bex = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd, name: 'Bex', layout: { x: 700, y: 0, width: 640, height: 380 } });
  page = await browser.newPage();
  await page.goto(server.url);
  await expectStatus(page, ada.id, 'idle');
  await expectStatus(page, bex.id, 'idle');
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may still hold a fake CLI's folder for a moment; it is a temp dir anyway
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a. create an idle loop in the modal; it runs twice and retires', async ({}, testInfo) => {
  await page.getByTestId('loops-button').click();
  const dialog = page.getByTestId('loops-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('loop-new-empty').click();

  await dialog.getByTestId('loop-name').fill('Nudge Ada');
  await dialog.getByTestId('loop-prompt').fill('loop ping');
  await dialog.getByTestId('loop-when-idle').click();
  await dialog.getByTestId('loop-idle-value').fill('5');
  await dialog.locator('select').first().selectOption('s');
  await dialog.getByTestId('loop-target-consoles').click();
  await dialog.getByTestId('loop-console-option').filter({ hasText: 'Ada' }).locator('input').check();
  await dialog.getByTestId('loop-stop-runs').check();
  await dialog.getByTestId('loop-stop-runs').locator('xpath=..').locator('input[type=number]').fill('2');
  await expect(dialog.getByTestId('loop-summary-line')).toHaveText("After 5 s idle, send 'loop ping' to Ada at most 2 times");
  await page.screenshot({ path: testInfo.outputPath('loops-modal.png') });

  await dialog.getByTestId('loop-save').click();
  const row = dialog.getByTestId('loop-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('loop-summary')).toContainText("send 'loop ping' to Ada");

  await expectTerminalToContain(page, ada.id, 'Done: loop ping', 20_000);
  const retired = await waitFor(async () => (await loops()).find((l) => l.retiredReason), { timeout: 40_000, message: 'loop retired' });
  expect(retired).toMatchObject({ runs: 2, enabled: false, retiredReason: 'after 2 runs' });
  await expect(row).toContainText('Retired');
  await expect(row.getByTestId('loop-runs')).toHaveText('2 runs');
  await page.screenshot({ path: testInfo.outputPath('loops-list.png') });
  // Bex was not a target
  expect((await state()).consoles.find((c) => c.id === bex.id)!.status).toBe('idle');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('b. a goal command that exits 0 retires the loop after the run', async () => {
  await expectStatus(page, ada.id, 'resting', 20_000);
  const loop = await server.api<Loop>('POST', '/api/loops', {
    name: 'Until green',
    prompt: 'check build',
    target: { kind: 'consoles', ids: [bex.id] },
    trigger: { kind: 'schedule', everyMinutes: 60 },
    stop: { whenGoal: { kind: 'command', command: 'node -e "process.exit(0)"', description: 'the build is green' } },
    confirmCommand: true,
  });
  await server.api('POST', `/api/loops/${loop.id}/run`);
  await expectTerminalToContain(page, bex.id, 'Done: check build', 20_000);
  const done = await waitFor(async () => (await loops()).find((l) => l.id === loop.id && l.retiredReason), { timeout: 30_000, message: 'goal met' });
  expect(done.lastGoal).toMatchObject({ met: true });
  expect(done.lastGoal!.detail).toContain('exit code 0');

  // Without confirmCommand the server refuses a command goal
  await expect(
    server.api('POST', '/api/loops', { prompt: 'x', target: { kind: 'all' }, trigger: { kind: 'schedule', everyMinutes: 5 }, stop: { whenGoal: { kind: 'command', command: 'echo hi' } } }),
  ).rejects.toThrow(/Confirm the goal command/);
});

test('c. Pause all interrupts working agents; Resume all continues them', async () => {
  await expectStatus(page, bex.id, 'resting', 20_000);
  await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'long task' });
  await expectStatus(page, ada.id, 'working');
  await page.getByTestId('command-bar-pause-all').click();
  await expect(consoleNode(page, ada.id).getByTestId('paused-pill')).toBeVisible();
  await expect(page.locator(`[data-testid="mission-item"][data-console-id="${ada.id}"]`).getByTestId('paused-pill')).toBeVisible();
  await expect(consoleNode(page, bex.id).getByTestId('paused-pill')).toHaveCount(0);
  expect((await state()).consoles.find((c) => c.id === ada.id)!.paused).toBe(true);

  // The fake CLI ignores Esc and finishes its turn; then Resume all types the continue prompt
  await expectTerminalToContain(page, ada.id, 'Done: long task', 20_000);
  const resume = page.getByTestId('command-bar-resume-paused');
  await expect(resume).toHaveText(/Resume all \(1\)/);
  await resume.click();
  await expectTerminalToContain(page, ada.id, 'Done: Continue where you left off.', 20_000);
  await expect(consoleNode(page, ada.id).getByTestId('paused-pill')).toHaveCount(0);
  await expect(resume).toHaveCount(0);
});

test('d. @team:<project> in the command bar sends one prompt to every agent of the project', async () => {
  await expectStatus(page, ada.id, 'resting', 20_000);
  const project = await server.api<Project>('POST', '/api/projects', { name: 'Squad', consoleIds: [ada.id, bex.id] });
  await expect(page.getByTestId('project-frame-title')).toHaveText(/Squad/i);
  const input = page.getByTestId('command-bar-input');
  await input.click();
  await input.fill('@team:Squad hello team');
  await input.press('Enter');
  await expect(page.getByTestId('command-bar-feedback')).toHaveText('Sent to 2 agents');
  await expectTerminalToContain(page, ada.id, 'Done: hello team', 20_000);
  await expectTerminalToContain(page, bex.id, 'Done: hello team', 20_000);

  // The project frame menu has a Message team box too
  await expectStatus(page, bex.id, 'resting', 20_000);
  await page.getByTestId('project-frame-menu-button').click();
  await page.getByTestId('project-message-team').click();
  await page.getByTestId('project-message-input').fill('from the frame');
  await page.getByTestId('project-message-send').click();
  await expectTerminalToContain(page, bex.id, 'Done: from the frame', 20_000);
  expect(project.consoleIds).toHaveLength(2);
});

test('e. the Mission Map counts active loops', async () => {
  await server.api<Loop>('POST', '/api/loops', {
    prompt: 'later',
    target: { kind: 'all' },
    trigger: { kind: 'schedule', everyMinutes: 120 },
  });
  await page.getByTestId('command-bar-mission-map').click();
  await expect(page.getByTestId('map-overview')).toContainText(/Active loops\s*1/);
});
