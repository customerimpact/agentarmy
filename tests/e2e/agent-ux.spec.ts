import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, flyToConsole } from './helpers/board';
import { AgentArmyServer, REPO_ROOT, makeTempHome, waitFor } from './helpers/server';

// Choosing (and changing) which AI runs a console: templates "Run this team on: Codex", the remembered
// choice on the gallery card, and "Switch agent…" on a running console. Fake CLIs only.
test.describe.configure({ mode: 'serial' });

const PORT = Number(process.env.AA_AGENT_UX_PORT ?? 4452);
const DATA_DIR = path.join(os.tmpdir(), 'aa-v04-C');
const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'fake-cli');
const FAKE_CODEX = path.join(FAKE_CLI, process.platform === 'win32' ? 'codex.cmd' : 'codex');
const SHOTS = process.env.AGENT_UX_SCREENSHOT_DIR;

let home: string;
let server: AgentArmyServer;
let page: Page;

const state = () => server.api<BoardState>('GET', '/api/state');

async function shot(target: Locator, name: string): Promise<void> {
  if (!SHOTS) return;
  // Readiness comes from CLI detection; let it settle so the pictures show real dots
  await expect(target.locator('[data-readiness="checking"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(target.getByText('Checking…')).toHaveCount(0, { timeout: 20_000 });
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['ember', 'paper']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(150);
    await target.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'ember';
  });
}

test.beforeAll(async ({ browser }) => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  home = makeTempHome('agent-ux');
  fs.mkdirSync(path.join(home, 'ux-project'));
  server = await AgentArmyServer.start({ home, port: PORT, env: { AGENTARMY_HOME: DATA_DIR, FAKE_CODEX_DELAY_MS: '800' } });
  await server.api('PATCH', '/api/settings', { agentPaths: { codex: FAKE_CODEX } });
  page = await browser.newPage();
  await page.goto(server.url);
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may still hold a fake CLI's folder for a moment
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a. New agent: the provider is a first step of cards, Claude preselected', async () => {
  await page.getByTestId('empty-state').getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByTestId('folder-picker');
  const picker = dialog.getByTestId('agent-picker');
  await expect(picker.getByTestId('agent-option-claude')).toHaveAttribute('aria-checked', 'true');
  await expect(picker.getByTestId('agent-option-codex')).toHaveAttribute('data-installed', 'true');
  await shot(dialog, 'new-agent');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('b. a template launched "on Codex" runs every console on Codex, orchestrator included', async () => {
  await page.getByTestId('command-bar-templates').click();
  const dialog = page.getByTestId('templates-dialog');
  const card = dialog.locator('[data-testid="template-card"][data-template-id="bug-squad"]');
  await expect(card.getByTestId('template-card-agents')).toHaveAttribute('data-runs-on', 'claude');

  // Hover shortcut: "Launch on Codex…" opens the launch step with Codex picked
  await card.hover();
  const launchOn = card.getByTestId('template-launch-on');
  await expect(launchOn).toHaveText(/Launch on Codex/);
  await launchOn.click();

  const runOn = dialog.getByTestId('template-run-on');
  await expect(runOn.getByTestId('template-run-on-option-codex')).toHaveAttribute('aria-checked', 'true');
  await expect(runOn.getByTestId('template-run-on-option-codex')).not.toHaveAttribute('data-readiness', 'not_installed');
  // One options row: only Codex is used
  await expect(dialog.getByTestId('provider-options')).toHaveCount(1);
  await dialog.getByTestId('template-model-codex').fill('gpt-5-codex');

  // Mixed shows a CLI per team plus the orchestrator; back to Codex afterwards
  await runOn.getByTestId('template-run-on-option-mixed').click();
  await expect(dialog.getByTestId('orchestrator-agent-select')).toHaveValue('codex');
  await expect(dialog.getByTestId('team-agent-select')).toHaveCount(1);
  await shot(dialog.getByTestId('template-run-step'), 'template-step-mixed');
  await runOn.getByTestId('template-run-on-option-codex').click();
  await expect(dialog.getByTestId('team-agent-select')).toHaveCount(0);

  await dialog.getByTestId('folder-picker-entry').filter({ hasText: 'ux-project' }).click();
  await shot(dialog, 'template-step');
  await dialog.getByTestId('template-launch').click();
  await expect(dialog).toBeHidden();

  await waitFor(async () => (await state()).consoles.length === 4, 15_000);
  const consoles = (await state()).consoles;
  expect(consoles.map((c) => c.agent)).toEqual(['codex', 'codex', 'codex', 'codex']);
  expect(consoles.find((c) => c.role === 'Orchestrator')?.agent).toBe('codex');
  // The header names the AI of every terminal
  for (const c of consoles) await expect(consoleNode(page, c.id).getByTestId('console-agent')).toHaveText('Codex');

  // The card remembers the choice
  await page.getByTestId('command-bar-templates').click();
  await expect(card.getByTestId('template-card-agents')).toHaveAttribute('data-runs-on', 'codex');
  await card.hover();
  await expect(card.getByTestId('template-launch-on')).toHaveText(/Launch on Claude/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('c. Switch agent… moves one console from Codex to Claude in place', async () => {
  const before = (await state()).consoles;
  const worker = before.find((c) => c.role === 'Investigator') as ConsoleInfo;
  await waitFor(async () => (await state()).consoles.find((c) => c.id === worker.id)?.status !== 'starting', 20_000);
  await flyToConsole(page, worker.id);
  await consoleNode(page, worker.id).getByTestId('console-agent').click();

  const dialog = page.getByTestId('switch-agent-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('switch-target-claude').click();
  await expect(dialog.getByTestId('switch-preview')).toContainText(`${worker.name}(Codex)`);
  await expect(dialog.getByTestId('switch-preview')).toContainText(`${worker.name}(Claude)`);
  await expect(dialog.getByTestId('switch-close-old')).toBeChecked();
  await shot(dialog, 'switch-dialog');
  await dialog.getByTestId('switch-start').click();
  await expect(dialog.getByTestId('switch-steps')).toBeVisible();

  await waitFor(async () => {
    const now = (await state()).consoles;
    return !now.some((c) => c.id === worker.id) && now.some((c) => c.name === worker.name && (c.agent ?? 'claude') === 'claude');
  }, 60_000);
  const moved = (await state()).consoles.find((c) => c.name === worker.name)!;
  expect(moved.cwd).toBe(worker.cwd);
  expect(moved.role).toBe('Investigator');
  await expect(consoleNode(page, moved.id).getByTestId('console-agent')).toHaveText('Claude');
  await expect(dialog).toBeHidden({ timeout: 30_000 });
});

test('d. Composer: "All rows on" sets every row; per-row model and agent stay editable', async () => {
  await page.getByTestId('command-bar-compose').click();
  const dialog = page.getByTestId('composer-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('composer-run-on-option-codex').click();
  await expect(dialog.getByTestId('composer-agent')).toHaveCount(3);
  for (const select of await dialog.getByTestId('composer-agent').all()) await expect(select).toHaveValue('codex');
  await dialog.getByTestId('composer-agent').nth(1).selectOption('claude');
  await expect(dialog.getByTestId('composer-run-on-option-mixed')).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('composer-model').nth(1).fill('sonnet');
  await shot(dialog, 'composer');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
