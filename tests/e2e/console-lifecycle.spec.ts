import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import {
  consoleNode,
  expectStatus,
  expectTerminalToContain,
  flyToConsole,
  typeInTerminal,
} from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// One server + one page shared by the whole flow; each test builds on the previous one
test.describe.configure({ mode: 'serial' });

let home: string;
let projectDir: string;
let otherDir: string;
let server: AgentArmyServer;
let page: Page;
let first: ConsoleInfo; // created through the UI
let second: ConsoleInfo; // created through the API, stays idle
let resumedAt = 0;

async function readState(): Promise<BoardState> {
  return server.api<BoardState>('GET', '/api/state');
}

async function savedState(): Promise<BoardState | null> {
  try {
    return JSON.parse(fs.readFileSync(server.stateFile, 'utf8')) as BoardState;
  } catch {
    return null;
  }
}

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('lifecycle');
  projectDir = path.join(home, 'alpha-project');
  otherDir = path.join(home, 'beta-project');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(otherDir);
  server = await AgentArmyServer.start({ home });
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

test('a. empty board, create a console through the folder picker', async () => {
  await page.goto(server.url);
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your board is empty' })).toBeVisible();
  // Token is stripped from the address bar
  expect(page.url()).not.toContain('token=');

  await page.getByTestId('empty-state').getByRole('button', { name: 'New agent' }).click();
  const picker = page.getByTestId('folder-picker');
  await expect(picker).toBeVisible();
  // The picker starts in the (temp) home dir
  await picker.getByRole('button', { name: 'alpha-project' }).click();
  await picker.getByTestId('folder-picker-use').click();
  await expect(picker).toBeHidden();

  const state = await waitFor(async () => (await readState()).consoles[0], { message: 'console in state' });
  first = state;
  expect(path.resolve(first.cwd).toLowerCase()).toBe(path.resolve(projectDir).toLowerCase());
  expect(first.name.trim()).not.toBe('');
  await expect(page.getByTestId('mission-item').first()).toContainText(first.name);

  await expect(page.getByTestId('empty-state')).toBeHidden();
  await expect(consoleNode(page, first.id)).toBeVisible();
  await expectTerminalToContain(page, first.id, 'Fake Claude Code');
  await expectTerminalToContain(page, first.id, `session ${first.sessionId}`);
  await expectStatus(page, first.id, 'idle');
  await expect(consoleNode(page, first.id).getByTestId('console-status')).toContainText('Idle');
});

test('b. a prompt goes working, then resting', async () => {
  await typeInTerminal(page, first.id, 'hello');
  await expectStatus(page, first.id, 'working', 5000);
  await expect(consoleNode(page, first.id).getByTestId('console-status')).toContainText('Working');
  await expectTerminalToContain(page, first.id, 'Done: hello');
  await expectStatus(page, first.id, 'resting');
  await expect(consoleNode(page, first.id).getByTestId('console-status')).toContainText('Resting');
});

test('b2. Ctrl-C is passed to the CLI without killing it', async () => {
  await consoleNode(page, first.id).locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+C');
  await expectTerminalToContain(page, first.id, '^C');
  await page.waitForTimeout(500);
  await expectStatus(page, first.id, 'resting');
});

test('c. a permission prompt shows "needs you" everywhere', async () => {
  second = await server.api<ConsoleInfo>('POST', '/api/consoles', {
    cwd: otherDir,
    layout: { x: 900, y: 0 },
  });
  await expect(consoleNode(page, second.id)).toBeVisible();
  await expectStatus(page, second.id, 'idle');

  await typeInTerminal(page, first.id, 'ask');
  await expectStatus(page, first.id, 'needs_you');
  const node = consoleNode(page, first.id);
  await expect(node).toHaveClass(/aa-needs-glow/);
  await expect(node.getByTestId('console-status')).toContainText('Needs you');
  await expect(node.getByText('Fake needs permission').first()).toBeVisible();

  const missions = page.getByTestId('mission-item');
  await expect(missions).toHaveCount(2);
  await expect(missions.first()).toHaveAttribute('data-console-id', first.id);
  await expect(missions.first()).toHaveAttribute('data-status', 'needs_you');
  await expect(page.getByTestId('mission-list').getByText('Needs you', { exact: false }).first()).toBeVisible();
  await expect(page).toHaveTitle(/^\(1\) /);

  // Answer the prompt: back to resting and the badge clears
  await typeInTerminal(page, first.id, 'y');
  await expectTerminalToContain(page, first.id, 'Done: ask');
  await expectStatus(page, first.id, 'resting');
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});

test('d. consoles survive a server restart and resume the same session', async () => {
  const before = await readState();
  const sessions = Object.fromEntries(before.consoles.map((c) => [c.id, c.sessionId]));
  expect(Object.keys(sessions)).toHaveLength(2);

  // Wait for the debounced save to include both consoles in their settled state
  await waitFor(
    async () => {
      const saved = await savedState();
      return (
        saved?.consoles.length === 2 &&
        saved.consoles.every((c) => c.sessionId === sessions[c.id] && c.status !== 'starting')
      );
    },
    { message: 'state.json to be written' },
  );

  await server.stop();
  server = await AgentArmyServer.start({ home });
  await page.goto(server.url);

  const after = await readState();
  expect(after.consoles.map((c) => c.id).sort()).toEqual(Object.keys(sessions).sort());
  for (const c of after.consoles) expect(c.sessionId).toBe(sessions[c.id]);

  await expect(consoleNode(page, first.id)).toBeVisible();
  await expect(consoleNode(page, second.id)).toBeVisible();

  // Without --resume-all, restored consoles wait as 'suspended' until the user resumes them
  await expectStatus(page, first.id, 'suspended');
  await expectStatus(page, second.id, 'suspended');
  await consoleNode(page, first.id).getByTestId('console-restart').click();
  await expectTerminalToContain(page, first.id, `resumed ${sessions[first.id]}`);
  await expectStatus(page, second.id, 'suspended');
  expect(await server.api<{ resumed: number }>('POST', '/api/resume-all')).toEqual({ resumed: 1 });
  resumedAt = Date.now();

  await expectTerminalToContain(page, first.id, `resumed ${sessions[first.id]}`);
  await expectTerminalToContain(page, second.id, `resumed ${sessions[second.id]}`);
  await expectStatus(page, first.id, 'idle');
  await expectStatus(page, second.id, 'idle');

  // The resumed session still works
  await typeInTerminal(page, first.id, 'again');
  await expectTerminalToContain(page, first.id, 'Done: again');
  await expectStatus(page, first.id, 'resting');
  const final = await readState();
  expect(final.consoles.find((c) => c.id === first.id)?.sessionId).toBe(sessions[first.id]);
});

test('e. closing a console removes it from the board', async () => {
  await consoleNode(page, first.id).getByTestId('console-close').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(consoleNode(page, first.id)).toHaveCount(0);
  await expect(page.getByTestId('mission-item')).toHaveCount(1);
  const state = await readState();
  expect(state.consoles.map((c) => c.id)).toEqual([second.id]);
});

test('g. API errors, crashes and restart', async () => {
  // The second console sits at x=900, partly off screen
  await flyToConsole(page, second.id);
  await typeInTerminal(page, second.id, 'fail');
  await expectStatus(page, second.id, 'error');
  await expect(consoleNode(page, second.id).getByTestId('console-status')).toContainText('Error');

  // A non-zero exit within 10s of a --resume launch counts as "could not resume" and starts a
  // new session (consoles.ts RESUME_FAILURE_WINDOW_MS); get past that window first
  const wait = resumedAt + 11_000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await typeInTerminal(page, second.id, 'crash');
  await expectStatus(page, second.id, 'exited');
  const exited = (await readState()).consoles.find((c) => c.id === second.id);
  expect(exited?.exitCode).toBe(3);

  // The exited header shows a Restart button that relaunches with --resume
  await consoleNode(page, second.id).getByTestId('console-restart').click();
  await expectTerminalToContain(page, second.id, `resumed ${second.sessionId}`);
  await expectStatus(page, second.id, 'idle');

  // Typing exit ends the session cleanly
  await typeInTerminal(page, second.id, 'exit');
  await expectStatus(page, second.id, 'exited');
  expect((await readState()).consoles.find((c) => c.id === second.id)?.exitCode).toBe(0);

  await consoleNode(page, second.id).getByTestId('console-close').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
});
