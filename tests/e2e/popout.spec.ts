import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo, Project } from '../../src/shared/protocol';
import { consoleNode } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Pop-out windows: ?view=console, ?view=project and ?view=focus render on their own, stay live,
// and the main board marks what is open elsewhere (BroadcastChannel between pages).
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let context: BrowserContext;
let board: Page;
let ada: ConsoleInfo;
let bex: ConsoleInfo;
let project: Project;

async function readState(): Promise<BoardState> {
  return server.api<BoardState>('GET', '/api/state');
}

async function waitStatus(id: string, status: string): Promise<void> {
  await waitFor(async () => (await readState()).consoles.find((c) => c.id === id)?.status === status, {
    message: `${id} -> ${status}`,
  });
}

async function popoutText(page: Page): Promise<string> {
  const text = (await page.locator('.xterm-rows').first().textContent({ timeout: 2000 }).catch(() => '')) ?? '';
  return text.replace(/ /g, ' ');
}

async function openView(query: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${server.origin}/${query}`);
  return page;
}

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('popout');
  const dir = path.join(home, 'popout-project');
  fs.mkdirSync(dir);
  server = await AgentArmyServer.start({ home, env: { FAKE_CLAUDE_DELAY_MS: '1200' } });
  ada = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Ada', layout: { x: 0, y: 0 } });
  bex = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Bex', layout: { x: 820, y: 0 } });
  project = await server.api<Project>('POST', '/api/projects', { name: 'Shop', consoleIds: [ada.id, bex.id] });
  await waitStatus(ada.id, 'idle');
  await waitStatus(bex.id, 'idle');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  board = await context.newPage();
  // The first visit carries ?token= and sets the auth cookie that the pop-outs reuse
  await board.goto(server.url);
  await expect(consoleNode(board, ada.id)).toBeVisible();
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('console view renders one live terminal with its header and command input', async ({}, testInfo) => {
  const page = await openView(`?view=console&id=${ada.id}`);
  const view = page.getByTestId('popout-console');
  await expect(view).toBeVisible();
  await expect(view).toContainText('Ada');
  await expect(page.getByTestId('console-kill')).toBeVisible();
  await expect(page.getByTestId('console-restart')).toBeVisible();
  await expect(page).toHaveTitle('Ada · AgentArmy');

  // The main board marks it as living in another window (BroadcastChannel)
  await expect(consoleNode(board, ada.id).getByTestId('console-popped-out')).toBeVisible();
  await expect(consoleNode(board, bex.id).getByTestId('console-popped-out')).toHaveCount(0);

  // Commands typed in the pop-out reach the agent, and its status updates live
  await page.getByTestId('popout-command-input').fill('hello from the popout');
  await page.getByTestId('popout-command-input').press('Enter');
  await expect.poll(() => popoutText(page), { timeout: 15_000 }).toContain('Done: hello from the popout');
  await expect(view).toHaveAttribute('data-status', 'resting', { timeout: 15_000 });

  // A needs-you prompt raised elsewhere shows up here and in the title
  await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'ask' });
  await expect(view).toHaveAttribute('data-status', 'needs_you', { timeout: 15_000 });
  await expect(page).toHaveTitle('(1) Ada · AgentArmy');
  await expect(page.getByTestId('console-status-detail')).toContainText('Fake needs permission');
  await page.screenshot({ path: testInfo.outputPath('console-view.png') });
  await board.screenshot({ path: testInfo.outputPath('board-popped-out.png') });
  // Answer it from the pop-out's terminal
  await page.locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.press('1');
  await expect(view).toHaveAttribute('data-status', 'resting', { timeout: 15_000 });

  // "Bring back" on the board closes the pop-out (or sends it to the board) and un-dims the console
  await consoleNode(board, ada.id).getByTestId('popout-bring-back').click();
  await expect(consoleNode(board, ada.id).getByTestId('console-popped-out')).toHaveCount(0);
  await expect
    .poll(() => page.isClosed() || !page.url().includes('view='), { timeout: 5000 })
    .toBe(true);
  if (!page.isClosed()) await page.close();
});

test('the header button opens a named pop-up and a second click reuses it', async () => {
  const popup = context.waitForEvent('page');
  await consoleNode(board, bex.id).getByTestId('console-popout').click();
  const page = await popup;
  await page.waitForLoadState();
  await expect(page).toHaveURL(new RegExp(`view=console&id=${bex.id}`));
  await expect(page.getByTestId('popout-console')).toBeVisible();
  await expect(consoleNode(board, bex.id).getByTestId('console-popped-out')).toBeVisible();
  const pages = context.pages().length;
  await consoleNode(board, bex.id).getByTestId('popout-focus').click();
  await board.waitForTimeout(300);
  expect(context.pages().length).toBe(pages);
  // Closing the pop-out brings the console back to the board
  await page.close();
  await expect(consoleNode(board, bex.id).getByTestId('console-popped-out')).toHaveCount(0);
  await expect(consoleNode(board, bex.id).locator('.xterm-rows')).toBeVisible();
});

test('project view shows only that project and updates live', async ({}, testInfo) => {
  const loner = await server.api<ConsoleInfo>('POST', '/api/consoles', {
    cwd: path.join(home, 'popout-project'),
    name: 'Cy',
    layout: { x: 0, y: 700 },
  });
  const page = await openView(`?view=project&id=${project.id}`);
  await expect(page.getByTestId('popout-project')).toBeVisible();
  await expect(page.getByTestId('console-node')).toHaveCount(2);
  await expect(consoleNode(page, loner.id)).toHaveCount(0);
  await expect(page.getByTestId('project-frame')).toHaveCount(1);
  await expect(page).toHaveTitle('Shop · AgentArmy');

  await server.api('POST', `/api/consoles/${bex.id}/send`, { text: 'ask' });
  await expect(consoleNode(page, bex.id)).toHaveAttribute('data-status', 'needs_you', { timeout: 15_000 });
  await expect(page.getByTestId('popout-project-summary')).toContainText('1 needs you');
  await expect(page).toHaveTitle('(1) Shop · AgentArmy');

  // The board dims both members and tags the frame
  await expect(consoleNode(board, ada.id).getByTestId('console-popped-out')).toBeVisible();
  await expect(consoleNode(board, bex.id).getByTestId('console-popped-out')).toBeVisible();
  await expect(consoleNode(board, loner.id).getByTestId('console-popped-out')).toHaveCount(0);
  await expect(board.getByTestId('project-bring-back')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('project-view.png') });

  await board.getByTestId('project-bring-back').click();
  await expect(consoleNode(board, ada.id).getByTestId('console-popped-out')).toHaveCount(0);
  if (!page.isClosed()) await page.close();
  await server.api('DELETE', `/api/consoles/${loner.id}`);
});

test('focus wall shows consoles that need you or are working', async ({}, testInfo) => {
  const page = await openView('?view=focus');
  await expect(page.getByTestId('popout-focus')).toBeVisible();
  // Bex is still waiting on the permission prompt from the previous test
  const tile = page.locator(`[data-testid="wall-tile"][data-console-id="${bex.id}"]`);
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('data-status', 'needs_you');
  await expect(page.locator(`[data-testid="wall-tile"][data-console-id="${ada.id}"]`)).toHaveCount(0);
  await expect(page).toHaveTitle(/^\(1\) Focus wall · AgentArmy$/);
  await expect(tile.locator('.xterm-rows')).toContainText('Allow', { timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath('focus-wall.png') });

  // Answering leaves the wall; a new turn on Ada brings Ada in while it works
  await server.api('POST', `/api/consoles/${bex.id}/send`, { text: '1' }).catch(() => undefined);
  await expect(tile).toHaveCount(0, { timeout: 15_000 });
  await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'long job' });
  await expect(page.locator(`[data-testid="wall-tile"][data-console-id="${ada.id}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('wall-empty')).toBeVisible({ timeout: 15_000 });
  await page.close();
});

test('phone notifications: generate a topic, show the QR, send a test and push on needs-you', async ({}, testInfo) => {
  // A stand-in ntfy server on this machine (plain http is allowed for 127.0.0.1)
  const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const ntfy = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  const port = (ntfy.address() as AddressInfo).port;
  try {
    await board.getByTestId('sidebar-tab-settings').click();
    await board.getByTestId('settings-nav-integrations').click();
    const row = board.locator('[data-setting-id="ntfy"]');
    await row.scrollIntoViewIfNeeded();
    await row.getByTestId('ntfy-generate').click();
    const topic = await row.getByTestId('ntfy-topic-input').inputValue();
    expect(topic).toMatch(/^agentarmy-[A-Za-z0-9]{16}$/);
    await row.getByTestId('ntfy-server-input').fill(`http://127.0.0.1:${port}/`);
    await row.getByTestId('ntfy-save').click();

    await expect(row.getByTestId('ntfy-status')).toContainText(topic.slice(-4));
    await expect(row.getByTestId('ntfy-qr')).toBeVisible();
    await expect(row.getByTestId('ntfy-link')).toHaveText(`http://127.0.0.1:${port}/${topic}`);
    // The topic never comes back in plain GET /api/settings
    expect(JSON.stringify(await server.api('GET', '/api/settings'))).not.toContain(topic);
    await row.screenshot({ path: testInfo.outputPath('ntfy-settings.png') });

    await row.getByTestId('test-ntfy').click();
    await expect.poll(() => received.length).toBe(1);
    expect(received[0].url).toBe(`/${topic}`);
    expect(received[0].headers.title).toBe('AgentArmy test');

    // A console that starts waiting on you pushes with high priority and a deep link
    await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'ask' });
    await expect.poll(() => received.length, { timeout: 15_000 }).toBe(2);
    expect(received[1].headers.priority).toBe('high');
    expect(received[1].headers.click).toBe(`http://127.0.0.1:${server.port}/?view=console&id=${ada.id}`);
    expect(received[1].body).toContain('Fake needs permission');

    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row.getByTestId('ntfy-generate')).toBeVisible();
  } finally {
    ntfy.close();
  }
});
