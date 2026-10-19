import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, Template } from '../../src/shared/protocol';
import { expectTerminalToContain } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Composer: launch a team of consoles with roles and first prompts in one step, save it as a
// custom template, and launch / delete that template from the Templates gallery.
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;

const port = process.env.AA_E2E_PORT ? Number(process.env.AA_E2E_PORT) : undefined;
const state = () => server.api<BoardState>('GET', '/api/state');

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('composer');
  fs.mkdirSync(path.join(home, 'squad-project'));
  server = await AgentArmyServer.start({ home, port });
  page = await browser.newPage();
  await page.goto(server.url);
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

test('a. compose two agents with roles and prompts, then save them as a template', async ({}, testInfo) => {
  await page.getByTestId('command-bar-compose').click();
  const dialog = page.getByTestId('composer-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('folder-picker-entry').filter({ hasText: 'squad-project' }).click();

  const rows = dialog.getByTestId('composer-row');
  await expect(rows).toHaveCount(3);
  await dialog.getByTestId('composer-count-minus').click();
  await expect(rows).toHaveCount(2);
  await expect(dialog.getByTestId('composer-count')).toHaveText('2');

  await dialog.getByTestId('composer-fill-role').selectOption('Tests');
  await expect(rows.nth(1).getByRole('button', { name: 'Tests', pressed: true })).toBeVisible();
  await rows.nth(0).getByTestId('composer-name').fill('Ada');
  await rows.nth(0).getByRole('button', { name: 'Docs' }).click();
  await rows.nth(0).getByTestId('composer-prompt').fill('hello {role} from {name}');
  await rows.nth(1).getByRole('button', { name: '+ Custom' }).click();
  await rows.nth(1).getByTestId('composer-custom-role').fill('Perf');
  await expect(rows.nth(1).getByRole('button', { name: 'Tests' })).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByTestId('composer-project-name').fill('Squad');
  await page.screenshot({ path: testInfo.outputPath('composer.png') });

  // Save as template first (the dialog stays open)
  await dialog.getByTestId('composer-save-template').click();
  await dialog.getByTestId('composer-template-name').fill('Docs + perf');
  await dialog.getByTestId('composer-template-save').click();
  await expect(dialog.getByTestId('composer-template-name')).toHaveCount(0);

  await dialog.getByTestId('composer-launch').click();
  await expect(dialog).toBeHidden();

  const board = await waitFor(async () => {
    const s = await state();
    return s.consoles.length === 2 && s.projects.length === 1 ? s : null;
  }, { message: 'two consoles in one project' });
  const [project] = board.projects;
  expect(project.name).toBe('Squad');
  const adaInfo = board.consoles.find((c) => c.name === 'Ada')!;
  const other = board.consoles.find((c) => c.name !== 'Ada')!;
  expect(adaInfo.role).toBe('Docs');
  expect(other.role).toBe('Perf');
  expect(project.consoleIds).toEqual([adaInfo.id, other.id]);
  // Laid out side by side inside one frame
  expect(other.layout.x).toBeGreaterThan(adaInfo.layout.x);
  expect(other.layout.y).toBe(adaInfo.layout.y);
  await expect(page.getByTestId('project-frame-title')).toHaveText(/Squad/i);
  await expectTerminalToContain(page, adaInfo.id, 'Done: hello Docs from Ada', 20_000);

  const templates = await server.api<Template[]>('GET', '/api/templates');
  const custom = templates.find((t) => t.custom)!;
  expect(custom).toMatchObject({ name: 'Docs + perf', orchestrator: false });
  expect(custom.rows).toEqual([
    { name: 'Ada', role: 'Docs', prompt: 'hello {role} from {name}' },
    { role: 'Perf' },
  ]);
  expect(fs.existsSync(path.join(home, '.agentarmy', 'templates.json'))).toBe(true);
});

test('b. the custom template shows a badge, launches through the gallery and can be deleted', async () => {
  await page.getByTestId('command-bar-templates').click();
  const dialog = page.getByTestId('templates-dialog');
  const card = dialog.locator('[data-testid="template-card"]').filter({ hasText: 'Docs + perf' });
  await expect(card.getByTestId('template-custom-badge')).toHaveText(/Custom/i);
  await expect(dialog.getByTestId('template-scratch')).toBeVisible();

  await card.click();
  // The picker opens in the folder used last (squad-project), which is the launch target
  await expect(dialog.getByText(/squad-project$/).first()).toBeVisible();
  await expect(dialog.getByTestId('template-launch')).toBeEnabled();
  await dialog.getByTestId('template-project-name').fill('Again');
  await dialog.getByTestId('template-launch').click();
  await expect(dialog).toBeHidden();
  const board = await waitFor(async () => {
    const s = await state();
    return s.projects.some((p) => p.name === 'Again') ? s : null;
  }, { message: 'template launched' });
  const again = board.projects.find((p) => p.name === 'Again')!;
  expect(again.consoleIds).toHaveLength(2);
  expect(board.consoles.filter((c) => again.consoleIds.includes(c.id)).map((c) => c.role)).toEqual(['Docs', 'Perf']);

  // Delete it from the gallery
  await page.getByTestId('command-bar-templates').click();
  const card2 = dialog.locator('[data-testid="template-card"]').filter({ hasText: 'Docs + perf' });
  await card2.getByTestId('template-delete').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(card2).toHaveCount(0);
  expect((await server.api<Template[]>('GET', '/api/templates')).some((t) => t.custom)).toBe(false);

  // "Start from scratch" opens the Composer
  await dialog.getByTestId('template-scratch').click();
  await expect(page.getByTestId('composer-dialog')).toBeVisible();
  await expect(dialog).toBeHidden();
});
