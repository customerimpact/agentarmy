import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ActionItem, BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, expectStatus, expectTerminalToContain, typeInTerminal } from './helpers/board';
import { AgentArmyServer, waitFor } from './helpers/server';

// Answer a permission prompt from the Actions tab, without touching the terminal.
// AGENTARMY_E2E_HOME / AGENTARMY_E2E_PORT / AGENTARMY_E2E_SHOTS let a run pick its own folder,
// port and screenshot folder (parallel agents on one machine).

test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let agent: ConsoleInfo;

const openNeedsYou = async (): Promise<ActionItem | undefined> =>
  (await server.api<BoardState>('GET', '/api/state')).actions.find(
    (a) => a.consoleId === agent.id && a.kind === 'needs_you' && !a.resolvedAt && !!a.options?.length,
  );

test.beforeAll(async ({ browser }) => {
  const base = process.env.AGENTARMY_E2E_HOME ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'agentarmy-e2e-inbox-')));
  fs.mkdirSync(path.join(home, 'repo'));
  const port = process.env.AGENTARMY_E2E_PORT ? Number(process.env.AGENTARMY_E2E_PORT) : undefined;
  server = await AgentArmyServer.start({ home, port });
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Windows may still hold the fake CLI's folder for a moment; it is a temp dir anyway
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a permission prompt can be answered "Yes" from the Actions tab', async () => {
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: path.join(home, 'repo'), name: 'Ada' });
  await page.goto(server.url);
  await expect(consoleNode(page, agent.id)).toBeVisible();
  await expectStatus(page, agent.id, 'idle');

  await typeInTerminal(page, agent.id, 'ask');
  await expectStatus(page, agent.id, 'needs_you');
  // The server reads the numbered dialog off the screen and puts it on the action item
  const item = await waitFor(openNeedsYou, { message: 'needs_you item with options' });
  expect(item.question).toBe('Do you want to proceed?');
  expect(item.options?.map((o) => o.key)).toEqual(['1', '2', '3']);
  expect(item.allowText).toBe(true);

  await page.getByTestId('sidebar-tab-actions').click();
  const card = page.locator(`[data-testid="action-item"][data-action-id="${item.id}"]`);
  await expect(card.getByTestId('answer-question')).toHaveText('Do you want to proceed?');
  const options = card.getByTestId('answer-option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('data-tone', 'primary');
  await expect(options.nth(1)).toHaveAttribute('data-tone', 'neutral');
  await expect(options.nth(2)).toHaveAttribute('data-tone', 'danger');
  await expect(card.getByTestId('answer-reply')).toBeVisible();
  await card.getByRole('button', { name: 'Show context' }).click();
  await expect(card.getByTestId('answer-context')).toContainText('echo fake');

  const shots = process.env.AGENTARMY_E2E_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.getByTestId('actions-panel').screenshot({ path: path.join(shots, 'actions-inbox.png') });
    await page.screenshot({ path: path.join(shots, 'actions-inbox-full.png') });
  }

  await options.nth(0).click();
  await expectTerminalToContain(page, agent.id, 'Permission granted');
  await expectTerminalToContain(page, agent.id, 'Done: ask');
  await expectStatus(page, agent.id, 'resting');
  const after = (await server.api<BoardState>('GET', '/api/state')).actions.find((a) => a.id === item.id);
  expect(after?.resolvedBy).toBe('auto');
  await expect(card).toHaveCount(0);
});

test('keyboard 3 on the focused item answers "No"', async () => {
  await typeInTerminal(page, agent.id, 'ask');
  await expectStatus(page, agent.id, 'needs_you');
  const item = await waitFor(openNeedsYou, { message: 'second needs_you item with options' });
  const card = page.locator(`[data-testid="action-item"][data-action-id="${item.id}"]`);
  await expect(card.getByTestId('answer-option')).toHaveCount(3);
  await card.focus();
  await page.keyboard.press('3');
  await expectTerminalToContain(page, agent.id, 'Permission denied');
  await expectStatus(page, agent.id, 'resting');
});
