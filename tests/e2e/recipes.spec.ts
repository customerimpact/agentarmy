import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Template } from '../../src/shared/protocol';
import { decodeRecipe, encodeRecipe } from '../../src/shared/recipes';
import { AgentArmyServer, makeTempHome } from './helpers/server';

// Recipes: share a custom template as a gridhive.dev link, import it back from the link (preview first,
// nothing launches), and open a recipe from a http://127.0.0.1:<port>/#recipe=<code> link.
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let shareLink = '';

const port = process.env.AA_E2E_PORT ? Number(process.env.AA_E2E_PORT) : undefined;
const customTemplates = async () =>
  (await server.api<Template[]>('GET', '/api/templates')).filter((t) => t.custom);

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('recipes');
  server = await AgentArmyServer.start({ home, port });
  await server.api('POST', '/api/templates/custom', {
    name: 'Pair review',
    rows: [
      { role: 'Builder', prompt: 'You are {name}. Build it.', agent: 'codex', accountId: 'work-account' },
      { name: 'Rex', role: 'Reviewer', prompt: 'Review the diff.', worktree: true },
    ],
  });
  page = await browser.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(server.url);
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // temp dir; Windows may still hold it for a moment
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a. share a template as a link and a README badge, without the account', async () => {
  await page.getByTestId('command-bar-templates').click();
  const dialog = page.getByTestId('templates-dialog');
  const card = dialog.getByTestId('template-card').filter({ hasText: 'Pair review' });
  await card.getByTestId('template-share').click();

  const share = dialog.getByTestId('recipe-share');
  await expect(share).toBeVisible();
  shareLink = await share.getByTestId('recipe-share-link').inputValue();
  expect(shareLink).toMatch(/^https:\/\/gridhive\.dev\/r#[A-Za-z0-9_-]+$/);
  expect(await share.getByTestId('recipe-share-badge').inputValue()).toContain('[![Run in GridHive]');
  expect(decodeRecipe(shareLink)).toEqual({
    name: 'Pair review',
    description: '2 agents: Builder, Reviewer',
    rows: [
      { role: 'Builder', prompt: 'You are {name}. Build it.', agent: 'codex' },
      { name: 'Rex', role: 'Reviewer', prompt: 'Review the diff.', worktree: true },
    ],
  });
  await expect(share.getByTestId('recipe-rows')).toContainText('Review the diff.');
});

test('b. import the link: preview with prompts, then it lands on the launch step', async () => {
  const dialog = page.getByTestId('templates-dialog');
  await dialog.getByRole('button', { name: 'Back to templates' }).click();
  await dialog.getByTestId('recipe-import-open').click();

  const panel = dialog.getByTestId('recipe-import');
  await panel.getByTestId('recipe-import-input').fill('https://gridhive.dev/r#broken!!');
  await expect(panel.getByTestId('recipe-import-error')).toHaveText('This is not a GridHive recipe link');
  await expect(dialog.getByTestId('recipe-import-save')).toBeDisabled();

  await panel.getByTestId('recipe-import-input').fill(shareLink);
  await expect(panel.getByTestId('recipe-rows')).toContainText('You are {name}. Build it.');
  await expect(panel.getByTestId('recipe-rows')).toContainText('Codex');
  await dialog.getByTestId('recipe-import-save').click();

  // Saved as a template and shown on the launch step; nothing was launched
  await expect(dialog.getByTestId('template-launch')).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('Pair review');
  const templates = await customTemplates();
  expect(templates).toHaveLength(2);
  expect(templates[1].rows).toEqual([
    { role: 'Builder', prompt: 'You are {name}. Build it.', agent: 'codex' },
    { name: 'Rex', role: 'Reviewer', prompt: 'Review the diff.', worktree: true },
  ]);
  expect(Object.keys((await server.api<{ consoles: unknown[] }>('GET', '/api/state')).consoles)).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('c. a #recipe= link on the local board opens the import preview', async () => {
  const code = encodeRecipe({ name: 'Docs squad', rows: [{ role: 'Docs', prompt: 'Write the README.' }] });
  await page.goto(`${server.url}#recipe=${code}`);
  const dialog = page.getByTestId('templates-dialog');
  await expect(dialog.getByTestId('recipe-import')).toBeVisible();
  await expect(dialog.getByTestId('recipe-rows')).toContainText('Write the README.');
  await expect(dialog.getByTestId('recipe-import-input')).toHaveValue(code);
  // The code is not left in the address bar
  expect(new URL(page.url()).hash).toBe('');
});
