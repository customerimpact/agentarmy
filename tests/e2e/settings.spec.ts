import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConsoleInfo, PublicSettings } from '../../src/shared/protocol';
import { consoleNode, expectTerminalToContain, flyToConsole } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

test.describe.configure({ mode: 'serial' });

let home: string;
let projectDir: string;
let server: AgentArmyServer;
let page: Page;

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('settings');
  projectDir = path.join(home, 'settings-project');
  fs.mkdirSync(projectDir);
  server = await AgentArmyServer.start({ home });
  page = await browser.newPage();
  await page.goto(server.url);
  await page.getByTestId('sidebar-tab-agents').waitFor();
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
});

const row = (id: string) => page.locator(`[data-setting-id="${id}"]`);

test('key 4 opens the Settings tab and search filters across sections', async () => {
  await page.locator('body').click({ position: { x: 900, y: 450 } });
  await page.keyboard.press('4');
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  await expect(row('theme')).toBeVisible();
  await expect(row('font-size')).toBeVisible();

  // '/' focuses the search box
  await page.locator('body').click({ position: { x: 200, y: 20 } });
  await page.keyboard.press('/');
  const search = page.getByTestId('settings-search');
  await expect(search).toBeFocused();

  await search.fill('slack');
  await expect(row('slack')).toBeVisible();
  await expect(row('font-size')).toHaveCount(0);
  await expect(panel.locator('[data-section="terminals"]')).toHaveCount(0);
  await expect(page.getByTestId('settings-result-count')).toHaveText('1 result');
  await expect(row('slack').locator('mark.aa-hit').first()).toHaveText(/slack/i);

  // Keywords match too: "opus" finds the model row
  await search.fill('opus');
  await expect(row('model')).toBeVisible();

  await search.fill('font');
  await expect(row('font-size')).toBeVisible();
  await expect(row('model')).toHaveCount(0);

  await search.fill('qwertyuiop');
  await expect(page.getByTestId('settings-result-count')).toHaveText('0 results');
  await search.fill('');
  await expect(row('model')).toBeVisible();
});

test('default model is saved on the server and passed to new consoles', async () => {
  await row('model').getByRole('combobox', { name: 'Model' }).selectOption('haiku');
  await waitFor(
    async () => (await server.api<PublicSettings>('GET', '/api/settings')).settings.model === 'haiku',
    { message: 'model saved' },
  );
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.agentarmy', 'settings.json'), 'utf8'));
  expect(saved.model).toBe('haiku');

  const created = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: projectDir });
  await expect(consoleNode(page, created.id)).toBeVisible();
  await page.getByTestId('sidebar-tab-agents').click();
  await flyToConsole(page, created.id);
  await expectTerminalToContain(page, created.id, 'args --model haiku');
});

test('terminal font size applies live and persists across a reload', async () => {
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-tab-settings').click();
  await page.getByTestId('settings-search').fill('font size');
  const stepper = row('font-size');
  await expect(stepper).toContainText('13px');
  await stepper.getByRole('button', { name: 'Increase Font size' }).click();
  await stepper.getByRole('button', { name: 'Increase Font size' }).click();
  await expect(stepper).toContainText('15px');

  const rows = page.locator('[data-testid="console-node"] .xterm-rows').first();
  await expect.poll(() => rows.evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px');

  await page.reload();
  await page.getByTestId('sidebar-tab-settings').click();
  await page.getByTestId('settings-search').fill('font size');
  await expect(row('font-size')).toContainText('15px');
});

test('rejects an invalid webhook URL and never returns a saved one', async () => {
  await page.getByTestId('settings-search').fill('slack');
  const input = row('slack').getByLabel('Slack webhook URL');
  await input.fill('https://example.com/not-slack');
  await row('slack').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Could not save: Slack webhook must look like/)).toBeVisible();

  const url = 'https://hooks.slack.com/services/T000/B000/e2eSecretAbcd';
  await input.fill(url);
  await row('slack').getByRole('button', { name: 'Save' }).click();
  await expect(row('slack')).toContainText('Connected');
  await expect(row('slack')).toContainText('Abcd');
  const view = await server.api<PublicSettings>('GET', '/api/settings');
  expect(JSON.stringify(view)).not.toContain('e2eSecret');
  expect(view.slack).toEqual({ set: true, hint: 'Abcd' });
});
