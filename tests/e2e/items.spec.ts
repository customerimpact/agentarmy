import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BoardItem, BoardState, ConsoleInfo, KanbanData } from '../../src/shared/protocol';
import { expectStatus, expectTerminalToContain } from './helpers/board';
import { startItemsServer } from './helpers/agent-c';
import type { AgentArmyServer } from './helpers/server';

// Notes, checklists and kanban boards on the board, next to a (fake) Claude console
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let agent: ConsoleInfo;

async function items(): Promise<BoardItem[]> {
  return (await server.api<BoardState>('GET', '/api/state')).items;
}

// A screen point where the bare board (nothing drawn on it) is under the mouse
async function emptyBoardPoint(): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.react-flow__pane').boundingBox())!;
  const point = await page.evaluate((b) => {
    for (let y = b.y + 80; y < b.y + b.height - 200; y += 40) {
      for (let x = b.x + 80; x < b.x + b.width - 80; x += 40) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
      }
    }
    return null;
  }, box);
  if (!point) throw new Error('no empty spot on the board');
  return point;
}

async function clickPane(): Promise<void> {
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 300 } });
}

test.beforeAll(async ({ browser }) => {
  const started = await startItemsServer('items');
  server = started.server;
  home = started.home;
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', {
    cwd: started.project,
    name: 'Ada',
    layout: { x: 0, y: 0, width: 760, height: 460 },
  });
  page = await browser.newPage();
  await page.goto(server.url);
  await expectStatus(page, agent.id, 'idle');
});

test.afterAll(async () => {
  await page?.close();
  // Stop the agent first so its fake claude releases the project folder (Windows)
  if (agent) await server?.api('DELETE', `/api/consoles/${agent.id}`).catch(() => undefined);
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

test('Add > Note creates a sticky note that renders markdown and is saved', async () => {
  await page.getByTestId('add-item-button').click();
  await page.getByTestId('add-note').click();
  const note = page.getByTestId('item-note');
  await expect(note).toHaveCount(1);
  // A fresh note opens in edit mode
  const textarea = note.getByTestId('note-textarea');
  await expect(textarea).toBeFocused();
  await textarea.fill('# Release plan\n- **ship** it\n- read [docs](https://example.com)');
  await clickPane();
  const view = note.getByTestId('note-view');
  await expect(view.getByRole('heading', { name: 'Release plan' })).toBeVisible();
  await expect(view.locator('strong')).toHaveText('ship');
  await expect(view.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com');
  await expect.poll(async () => (await items())[0]?.data.text).toContain('# Release plan');

  // Double-click edits again
  await view.dblclick();
  await expect(note.getByTestId('note-textarea')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(note.getByTestId('note-view')).toBeVisible();
});

test('a checklist tracks progress and sends its open items to an agent', async () => {
  await clickPane();
  await page.getByTestId('add-item-button').click();
  await page.getByTestId('add-checklist').click();
  const list = page.getByTestId('item-checklist');
  await expect(list).toHaveCount(1);
  const add = list.getByTestId('checklist-add');
  for (const text of ['Write tests', 'Fix lint', 'Update README']) {
    await add.fill(text);
    await add.press('Enter');
  }
  await expect(list.getByTestId('checklist-entry')).toHaveCount(3);
  await expect(list.getByTestId('checklist-progress')).toHaveText('0/3');
  await list.getByTestId('checklist-toggle').nth(1).check();
  await expect(list.getByTestId('checklist-progress')).toHaveText('1/3');

  // Reorder: drag the last item to the top
  const entries = list.getByTestId('checklist-entry');
  await entries.nth(2).dragTo(entries.nth(0), { targetPosition: { x: 20, y: 2 } });
  await expect(entries.nth(0).locator('input:not([type=checkbox])')).toHaveValue('Update README');

  // Delete one
  await entries.nth(0).hover();
  await entries.nth(0).getByTestId('checklist-delete-entry').click();
  await expect(entries).toHaveCount(2);
  await expect
    .poll(async () => ((await items()).find((i) => i.kind === 'checklist')?.data.entries as unknown[] | undefined)?.length)
    .toBe(2);

  await list.getByTestId('checklist-send').click();
  await page.getByTestId('pick-console-Ada').click();
  await expectTerminalToContain(page, agent.id, 'Please work through these open items');
  await expectTerminalToContain(page, agent.id, 'Write tests');
  await expectStatus(page, agent.id, 'resting', 20_000);
});

test('kanban: add a card, drag it between columns, assign it to an agent and see it finish', async () => {
  await clickPane();
  await page.getByTestId('add-item-button').click();
  await page.getByTestId('add-kanban').click();
  const board = page.getByTestId('item-kanban');
  await expect(board.getByTestId('kanban-column')).toHaveCount(3);
  const todo = board.locator('[data-testid="kanban-column"][data-column="To do"]');
  const doing = board.locator('[data-testid="kanban-column"][data-column="Doing"]');
  const done = board.locator('[data-testid="kanban-column"][data-column="Done"]');

  await todo.getByTestId('kanban-add-card').click();
  await todo.getByTestId('kanban-new-card').fill('Add a dark mode toggle');
  await todo.getByTestId('kanban-new-card').press('Enter');
  await todo.getByTestId('kanban-new-card').press('Escape');
  await expect(todo.getByTestId('kanban-card')).toHaveCount(1);

  // Drag to Done and back to To do
  await todo.getByTestId('kanban-card').dragTo(done);
  await expect(done.getByTestId('kanban-card')).toHaveCount(1);
  await done.getByTestId('kanban-card').dragTo(todo);
  await expect(todo.getByTestId('kanban-card')).toHaveCount(1);

  // Assign: the card is typed into the console and moves to Doing
  const card = todo.getByTestId('kanban-card');
  await card.hover();
  await card.getByTestId('kanban-assign').click();
  await page.getByTestId('pick-console-Ada').click();
  await expect(doing.getByTestId('kanban-card')).toHaveCount(1);
  await expect(doing.getByTestId('card-agent-working').or(doing.getByTestId('card-agent-finished'))).toBeVisible();
  await expect(doing.getByTestId('card-agent-finished')).toBeVisible({ timeout: 20_000 });
  await expect(doing.getByTestId('card-agent-finished')).toHaveText('Ada finished');
  const saved = (await items()).find((i) => i.kind === 'kanban')!.data as unknown as KanbanData;
  expect(saved.columns[1].cards[0]).toMatchObject({ title: 'Add a dark mode toggle', assignedConsoleId: agent.id });
  expect(saved.columns[1].cards[0].finishedAt).toBeGreaterThan(0);

  // Columns: add and rename
  await board.getByTestId('kanban-add-column').click();
  await expect(board.getByTestId('kanban-column')).toHaveCount(4);
  const title = board.getByTestId('kanban-column-title').nth(3);
  await title.fill('Review');
  await title.press('Enter');
  await expect(board.locator('[data-testid="kanban-column"][data-column="Review"]')).toHaveCount(1);
});

test('double-clicking the empty board adds an item right there, Shift+N adds a note', async () => {
  await clickPane();
  await page.keyboard.press('f'); // fit everything so there is empty board around it
  await page.waitForTimeout(500);
  const spot = await emptyBoardPoint();
  await page.mouse.dblclick(spot.x, spot.y);
  await expect(page.getByTestId('add-here-popover')).toBeVisible();
  await page.getByTestId('add-here-popover').getByTestId('add-checklist').click();
  await expect(page.getByTestId('item-checklist')).toHaveCount(2);

  await clickPane();
  await page.keyboard.press('Shift+N');
  await expect(page.getByTestId('item-note')).toHaveCount(2);
  await expect.poll(async () => (await items()).length).toBe(5);
});

test('items join the selection: the Kill button reads Delete for items only', async () => {
  await clickPane();
  await page.keyboard.press('Escape');
  const note = page.getByTestId('item-note').last();
  await note.click({ position: { x: 40, y: 10 } });
  await expect(page.getByTestId('kill-button')).toHaveText('Delete');
  // Ctrl+click the console too: it becomes a Kill
  await page.locator(`.react-flow__node[data-id="${agent.id}"]`).click({ modifiers: ['Control'], position: { x: 200, y: 12 } });
  await expect(page.getByTestId('selection-bar').getByTestId('kill-button')).toHaveText('Kill 2');
  await page.keyboard.press('Escape');

  await note.click({ position: { x: 40, y: 10 } });
  await expect(page.getByTestId('kill-button')).toHaveText('Delete');
  await page.getByTestId('kill-button').click();
  await expect(page.getByTestId('confirm-dialog-confirm')).toHaveText('Delete');
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId('item-note')).toHaveCount(1);
  await expect.poll(async () => (await items()).length).toBe(4);
});

test('items survive a reload and Arrange moves them with the consoles', async () => {
  await page.reload();
  await expect(page.getByTestId('item-kanban')).toHaveCount(1);
  await expect(page.getByTestId('item-checklist')).toHaveCount(2);
  await expect(page.getByTestId('item-note')).toHaveCount(1);
  const before = JSON.stringify((await items()).map((i) => i.layout));
  await clickPane();
  await page.keyboard.press('Shift+A');
  await expect.poll(async () => JSON.stringify((await items()).map((i) => i.layout))).not.toBe(before);
});
