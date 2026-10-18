import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, expectStatus } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Sidebar fly-to (must zoom IN to 1 and center the console) and the red Kill button
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let consoles: ConsoleInfo[] = [];

const SIZE = { width: 760, height: 460 };

async function readState(): Promise<BoardState> {
  return server.api<BoardState>('GET', '/api/state');
}

// React Flow draws the board through one CSS transform: translate(x, y) scale(zoom)
async function viewport(): Promise<{ x: number; y: number; zoom: number }> {
  const transform = await page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(transform);
  if (!m) throw new Error(`Unexpected transform: ${transform}`);
  return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
}

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('board-actions');
  const dir = path.join(home, 'proj');
  fs.mkdirSync(dir);
  server = await AgentArmyServer.start({ home });
  // 12 consoles spread far apart (4 x 3, big gaps), so the whole board only fits zoomed far out
  for (let i = 0; i < 12; i++) {
    const layout = { x: (i % 4) * 2400, y: Math.floor(i / 4) * 1800, ...SIZE };
    consoles.push(await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: `Agent${i}`, layout }));
  }
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

test('clicking a far-away agent in the sidebar flies to it at zoom 1, centered', async () => {
  await page.goto(server.url);
  await expect(page.getByTestId('mission-item')).toHaveCount(12);
  // Start zoomed out over the whole board
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('f');
  await expect.poll(async () => (await viewport()).zoom).toBeLessThan(0.3);

  for (const target of [consoles[11], consoles[0], consoles[6]]) {
    await page.locator(`[data-testid="mission-item"][data-console-id="${target.id}"]`).click();
    await expect.poll(async () => (await viewport()).zoom, { timeout: 3000 }).toBeCloseTo(1, 2);
    await page.waitForTimeout(400); // let the 300 ms glide finish
    const vp = await viewport();
    expect(vp.zoom).toBeCloseTo(1, 2);
    const board = (await page.locator('.react-flow').boundingBox())!;
    const node = (await consoleNode(page, target.id).boundingBox())!;
    // The node's center sits at the board's center
    expect(Math.abs(node.x + node.width / 2 - (board.x + board.width / 2))).toBeLessThan(4);
    expect(Math.abs(node.y + node.height / 2 - (board.y + board.height / 2))).toBeLessThan(4);
    expect(node.width).toBeCloseTo(SIZE.width, 0);
  }
});

test('Kill removes the selected console after a confirm', async () => {
  const target = consoles[6];
  await expectStatus(page, target.id, 'idle');
  // The sidebar click selected it; the red button shows in the top bar
  const kill = page.getByTestId('kill-button');
  await expect(kill).toHaveText('Kill');
  await kill.click();
  const confirm = page.getByTestId('confirm-dialog-confirm');
  await expect(page.getByText('Stops the Claude process and removes 1 terminal from the board.')).toBeVisible();
  await confirm.click();
  await expect(consoleNode(page, target.id)).toHaveCount(0);
  await waitFor(async () => !(await readState()).consoles.some((c) => c.id === target.id), {
    message: 'console removed on the server',
  });
  await expect(kill).toHaveCount(0);
});

test('Delete on the board kills a multi-selection; Cancel keeps it', async () => {
  const [a, b] = [consoles[0], consoles[1]];
  const item = (id: string) => page.locator(`[data-testid="mission-item"][data-console-id="${id}"]`);
  await item(a.id).click();
  await item(b.id).click({ modifiers: ['Control'] }); // adds to the selection
  const kill = page.getByTestId('selection-bar').getByTestId('kill-button');
  await expect(kill).toHaveText('Kill 2');
  await expect(page.getByTestId('kill-button')).toHaveCount(1); // not duplicated in the top bar

  // Delete with the board focused (not a terminal) asks first
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Delete');
  await expect(page.getByText('Stops the Claude process and removes 2 terminals from the board.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(consoleNode(page, a.id)).toHaveCount(1);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(consoleNode(page, a.id)).toHaveCount(0);
  await expect(consoleNode(page, b.id)).toHaveCount(0);
  await waitFor(async () => (await readState()).consoles.length === 9, { message: '9 consoles left' });
});
