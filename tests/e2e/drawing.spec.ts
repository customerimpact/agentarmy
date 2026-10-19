import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConsoleInfo } from '../../src/shared/protocol';
import type { Shape } from '../../src/shared/drawings';
import { consoleNode } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Drawing layer: a rectangle and an arrow glued to a console; the arrow follows the console when it
// moves, everything survives a reload, and undo / redo work in draw mode.
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let agent: ConsoleInfo;

const LAYOUT = { x: 700, y: 120, width: 560, height: 360 };

async function shapes(): Promise<Shape[]> {
  return (await server.api<{ shapes: Shape[] }>('GET', '/api/drawings')).shapes;
}

// Screen position of a flow (board) point, from React Flow's viewport transform
async function screenOf(x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([fx, fy]) => {
      const vp = document.querySelector('.react-flow__viewport') as HTMLElement;
      const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(vp.style.transform)!;
      const box = vp.parentElement!.getBoundingClientRect();
      return { x: box.left + Number(m[1]) + fx * Number(m[3]), y: box.top + Number(m[2]) + fy * Number(m[3]) };
    },
    [x, y],
  );
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

// The drawn end of the arrow (flow coordinates), read from its SVG path "M x y L x y"
async function arrowEnd(): Promise<{ x: number; y: number }> {
  const d = await page.locator('[data-shape-kind="arrow"] path').nth(1).getAttribute('d');
  const m = /^M([-\d.e]+) ([-\d.e]+)L([-\d.e]+) ([-\d.e]+)$/.exec(d ?? '');
  if (!m) throw new Error(`unexpected arrow path ${d}`);
  return { x: Number(m[3]), y: Number(m[4]) };
}

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('drawing');
  const dir = path.join(home, 'proj');
  fs.mkdirSync(dir);
  // E2E_PORT / E2E_AGENTARMY_HOME let a developer pin the port and data folder
  server = await AgentArmyServer.start({
    home,
    ...(process.env.E2E_PORT ? { port: Number(process.env.E2E_PORT) } : {}),
    ...(process.env.E2E_AGENTARMY_HOME ? { env: { AGENTARMY_HOME: process.env.E2E_AGENTARMY_HOME } } : {}),
  });
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Ada', layout: LAYOUT });
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

test('draws a rectangle and an arrow anchored to a console', async () => {
  await page.goto(server.url);
  await expect(consoleNode(page, agent.id)).toBeVisible();
  await page.getByTestId('draw-toggle').click();
  await expect(page.getByTestId('draw-tool-rect')).toBeVisible();
  // Everything is placed relative to the console on screen (the board fits it into view)
  const box = (await consoleNode(page, agent.id).boundingBox())!;

  await page.getByTestId('draw-tool-rect').click();
  await page.getByTestId('draw-color-teal').click();
  await drag({ x: box.x + 20, y: box.y + box.height + 20 }, { x: box.x + 320, y: box.y + box.height + 110 });
  await waitFor(async () => (await shapes()).some((s) => s.kind === 'rect'), { message: 'rect saved' });
  const rect = (await shapes()).find((s) => s.kind === 'rect')!;
  expect(rect.style.color).toBe('teal');
  expect(rect.w).toBeGreaterThan(150);

  await page.getByTestId('draw-tool-arrow').click();
  await drag({ x: box.x - 120, y: box.y - 50 }, { x: box.x + 200, y: box.y + 180 });
  const arrow = await waitFor(async () => (await shapes()).find((s) => s.kind === 'arrow'), { message: 'arrow saved' });
  expect(arrow.end?.nodeId).toBe(agent.id);
  expect(arrow.start ?? null).toBeNull();
  // The visible end stops just before the console's left border
  const end = await arrowEnd();
  expect(end.x).toBeGreaterThan(LAYOUT.x - 12);
  expect(end.x).toBeLessThan(LAYOUT.x);
});

test('the arrow follows the console when it moves', async () => {
  await page.keyboard.press('Escape'); // leave draw mode so the console header is draggable
  await expect(page.getByTestId('draw-overlay')).toHaveCount(0);
  const before = await arrowEnd();
  const handle = consoleNode(page, agent.id).locator('.aa-drag-handle').first();
  const box = (await handle.boundingBox())!;
  const start = { x: box.x + 60, y: box.y + box.height / 2 };
  await drag(start, { x: start.x + 220, y: start.y + 140 });
  const moved = await waitFor(async () => {
    const c = (await server.api<{ consoles: ConsoleInfo[] }>('GET', '/api/state')).consoles.find((x) => x.id === agent.id)!;
    return c.layout.x !== LAYOUT.x ? c : null;
  }, { message: 'console moved' });
  await expect.poll(async () => (await arrowEnd()).y).toBeGreaterThan(before.y + 60);
  const after = await arrowEnd();
  expect(after.x).toBeGreaterThan(moved.layout.x - 12);
  expect(after.x).toBeLessThanOrEqual(moved.layout.x + 1);
});

test('drawings persist across a reload; undo and redo work in draw mode', async () => {
  await page.reload();
  await expect(consoleNode(page, agent.id)).toBeVisible();
  await expect(page.locator('[data-testid="drawing-layer"] [data-shape-id]')).toHaveCount(2);
  const end = await arrowEnd();
  const c = (await server.api<{ consoles: ConsoleInfo[] }>('GET', '/api/state')).consoles.find((x) => x.id === agent.id)!;
  expect(end.x).toBeGreaterThan(c.layout.x - 12);

  // Outside draw mode, Ctrl+Z is not ours (nothing selected)
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 600 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-testid="drawing-layer"] [data-shape-id]')).toHaveCount(2);

  // Select the arrow by clicking it, delete it, undo brings it back
  await page.getByTestId('draw-toggle').click();
  await page.getByTestId('draw-tool-select').click();
  const arrowPath = page.locator('[data-shape-kind="arrow"]');
  const ab = (await arrowPath.boundingBox())!;
  await page.mouse.click(ab.x + ab.width * 0.3, ab.y + ab.height * 0.3);
  await expect(page.getByTestId('draw-selection')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-shape-kind="arrow"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-kind="arrow"]')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-shape-kind="arrow"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await waitFor(async () => (await shapes()).length === 2, { message: 'undo saved' });
  // The console never got the keystrokes
  await expect(consoleNode(page, agent.id)).toBeVisible();

  if (process.env.E2E_SHOTS) {
    await page.getByTestId('draw-tool-pen').click();
    await drag(await screenOf(160, 420), await screenOf(380, 470));
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'drawing-board.png') });
  }
});

test('a screenshot dropped on the board becomes an image shape you can draw over', async () => {
  await page.keyboard.press('Escape');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const at = { x: pane.x + pane.width * 0.35, y: pane.y + pane.height * 0.7 };
  await page.evaluate(async ([x, y]) => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 120;
    canvas.getContext('2d')!.fillRect(0, 0, 200, 120);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    const target = document.querySelector('.react-flow__pane')!;
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  }, [at.x, at.y]);
  const image = await waitFor(async () => (await shapes()).find((s) => s.kind === 'image'), { message: 'image saved' });
  expect(image.w).toBe(200);
  // Served only with the token; the shape's <image> loads it
  const res = await fetch(`${server.origin}/api/images/${image.imageId}`);
  expect(res.status).toBe(401);
  await expect.poll(() => page.locator(`[data-shape-id="${image.id}"] image`).evaluate((el) => (el as SVGImageElement).getBBox().width)).toBeGreaterThan(0);
  const ok = await fetch(`${server.origin}/api/images/${image.imageId}`, { headers: { 'x-agentarmy-token': server.token } });
  expect(ok.headers.get('content-type')).toBe('image/png');
});
