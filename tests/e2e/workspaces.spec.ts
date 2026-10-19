import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo, WorkspacesState } from '../../src/shared/protocol';
import { consoleNode, expectStatus } from './helpers/board';
import { startItemsServer } from './helpers/agent-c';
import type { AgentArmyServer } from './helpers/server';

// Workspaces as tabs: each has its own consoles, items and viewport; agents keep running everywhere
test.describe.configure({ mode: 'serial' });

let home: string;
let project: string;
let server: AgentArmyServer;
let page: Page;
let ada: ConsoleInfo;
let bex: ConsoleInfo;

const tab = (name: string) => page.locator(`[data-testid="workspace-tab"][data-workspace="${name}"]`);

async function state(): Promise<BoardState> {
  return server.api<BoardState>('GET', '/api/state');
}

async function viewport(): Promise<string> {
  return page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
}

async function clickPane(): Promise<void> {
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 300 } });
}

test.beforeAll(async ({ browser }) => {
  const started = await startItemsServer('workspaces');
  server = started.server;
  home = started.home;
  project = started.project;
  ada = await server.api<ConsoleInfo>('POST', '/api/consoles', {
    cwd: project,
    name: 'Ada',
    layout: { x: 0, y: 0, width: 760, height: 460 },
  });
  page = await browser.newPage();
  await page.goto(server.url);
  await expectStatus(page, ada.id, 'idle');
});

test.afterAll(async () => {
  await page?.close();
  for (const c of [ada, bex]) if (c) await server?.api('DELETE', `/api/consoles/${c.id}`).catch(() => undefined);
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // a leftover temp folder is harmless
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a new workspace opens as an empty tab; new agents and items land on it', async () => {
  await expect(page.getByTestId('workspace-tab')).toHaveCount(1);
  await expect(tab('Main')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('workspace-new').click();
  await expect(tab('Workspace 2')).toHaveAttribute('aria-selected', 'true');
  await expect(consoleNode(page, ada.id)).toHaveCount(0);

  bex = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: project, name: 'Bex' });
  await expect(consoleNode(page, bex.id)).toHaveCount(1);
  await clickPane();
  await page.keyboard.press('Shift+N');
  await expect(page.getByTestId('item-note')).toHaveCount(1);

  const s = await state();
  const ws2 = s.workspaces.find((w) => w.name === 'Workspace 2')!;
  expect(s.consoles.find((c) => c.id === bex.id)?.workspaceId).toBe(ws2.id);
  expect(s.consoles.find((c) => c.id === ada.id)?.workspaceId).toBe('main');
  expect(s.items[0].workspaceId).toBe(ws2.id);

  // The sidebar groups agents by workspace once there are several
  await expect(page.getByTestId('sidebar-workspace')).toHaveCount(2);
});

test('rename a tab by double-clicking it', async () => {
  await tab('Workspace 2').dblclick();
  const input = page.getByTestId('workspace-rename-input');
  await input.fill('Research');
  await input.press('Enter');
  await expect(tab('Research')).toBeVisible();
  await expect.poll(async () => (await server.api<WorkspacesState>('GET', '/api/workspaces')).workspaces.map((w) => w.name)).toEqual([
    'Main',
    'Research',
  ]);
});

test('Alt+1 / Alt+2 switch tabs, each tab keeps its own viewport', async () => {
  await clickPane();
  await page.keyboard.press('Alt+1');
  await expect(tab('Main')).toHaveAttribute('aria-selected', 'true');
  await expect(consoleNode(page, ada.id)).toHaveCount(1);
  await expect(page.getByTestId('item-note')).toHaveCount(0);

  // Pan Main somewhere specific
  const pane = page.locator('.react-flow__pane');
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 360, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(700); // viewport save is debounced
  const mainView = await viewport();

  await page.keyboard.press('Alt+2');
  await expect(tab('Research')).toHaveAttribute('aria-selected', 'true');
  await expect(consoleNode(page, bex.id)).toHaveCount(1);
  await expect.poll(viewport).not.toBe(mainView);

  await tab('Main').click();
  await expect.poll(viewport).toBe(mainView);
});

test('a tab shows how many of its agents need you while you look at another one', async () => {
  await expect(tab('Main')).toHaveAttribute('aria-selected', 'true');
  await expectStatus(page, ada.id, 'idle');
  await server.api('POST', `/api/consoles/${bex.id}/send`, { text: 'ask' });
  await expect(tab('Research').getByTestId('workspace-needs-you')).toHaveText('1', { timeout: 20_000 });
  // Agents on other tabs keep running: answer it from here through the API
  await expect.poll(async () => (await state()).consoles.find((c) => c.id === bex.id)?.status).toBe('needs_you');
});

test('move a console to another workspace from its header', async () => {
  await consoleNode(page, ada.id).getByTestId('console-move-workspace').click();
  await page.getByTestId('workspace-pick-Research').click();
  await expect(consoleNode(page, ada.id)).toHaveCount(0);
  await expect.poll(async () => (await state()).consoles.find((c) => c.id === ada.id)?.workspaceId).not.toBe('main');

  // Clicking it in the sidebar switches to its workspace and flies there
  await page.locator(`[data-testid="mission-item"][data-console-id="${ada.id}"]`).click();
  await expect(tab('Research')).toHaveAttribute('aria-selected', 'true');
  await expect(consoleNode(page, ada.id)).toBeVisible();
});

test('reorder tabs by dragging, close an empty tab, and close a full one by moving its contents', async () => {
  await page.getByTestId('workspace-new').click();
  await expect(page.getByTestId('workspace-tab')).toHaveCount(3);
  const third = page.getByTestId('workspace-tab').nth(2);
  const thirdName = (await third.getAttribute('data-workspace'))!;
  // Drag the new tab to the front
  await third.dragTo(tab('Main'), { targetPosition: { x: 4, y: 10 } });
  await expect(page.getByTestId('workspace-tab').first()).toHaveAttribute('data-workspace', thirdName);
  await expect.poll(async () => (await server.api<WorkspacesState>('GET', '/api/workspaces')).workspaces[0].name).toBe(thirdName);

  // Empty: closes right away
  await tab(thirdName).getByTestId('workspace-close').click();
  await expect(page.getByTestId('workspace-tab')).toHaveCount(2);

  // Research has two agents and a note: closing asks where they go
  await tab('Research').click();
  await tab('Research').getByTestId('workspace-close').click();
  await expect(page.getByTestId('workspace-picker')).toContainText('Move 2 agents, 1 item to');
  await page.getByTestId('workspace-pick-Main').click();
  await expect(page.getByTestId('workspace-tab')).toHaveCount(1);
  await expect(tab('Main')).toHaveAttribute('aria-selected', 'true');
  await expect(consoleNode(page, ada.id)).toHaveCount(1);
  await expect(consoleNode(page, bex.id)).toHaveCount(1);
  await expect(page.getByTestId('item-note')).toHaveCount(1);
  const s = await state();
  expect(s.workspaces.map((w) => w.id)).toEqual(['main']);
  expect(new Set([...s.consoles.map((c) => c.workspaceId), ...s.items.map((i) => i.workspaceId)])).toEqual(new Set(['main']));
});

test('the open tab survives a reload', async () => {
  await page.getByTestId('workspace-new').click();
  await expect(tab('Workspace 2')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(tab('Workspace 2')).toHaveAttribute('aria-selected', 'true');
  await expect(consoleNode(page, ada.id)).toHaveCount(0);
});
