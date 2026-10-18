import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ActionItem, BoardState, ConsoleInfo } from '../../src/shared/protocol';
import type { UsageReport } from '../../src/shared/usage';
import { consoleNode, expectStatus, flyToConsole, typeInTerminal } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// The fake Claude's "usage 5000" prompt appends a real-shaped assistant usage line (twice, like
// streaming does) to its transcript: 100 in, 5000 out, 2000 cache write (1 h), 10000 cache read,
// model claude-sonnet-5-5. Weighted = 100 + 5000 + 2000 + 10000/10 = 8100 -> "8.1k".

test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let page: Page;
let consoleId: string;

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('usage');
  const projectDir = path.join(home, 'usage-project');
  fs.mkdirSync(projectDir);
  server = await AgentArmyServer.start({ home, env: { AGENTARMY_USAGE_TICK_MS: '700', FAKE_CLAUDE_DELAY_MS: '300' } });
  page = await browser.newPage();
  await page.goto(server.url);
  await page.getByTestId('sidebar-tab-agents').waitFor();
  const created = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: projectDir, name: 'Tally' });
  consoleId = created.id;
  await expectStatus(page, consoleId, 'idle');
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
});

test('a turn with usage shows up in the API, the Usage section and the console chip', async () => {
  await flyToConsole(page, consoleId);
  await typeInTerminal(page, consoleId, 'usage 5000');
  await expectStatus(page, consoleId, 'resting');

  const report = await waitFor(
    async () => {
      const r = await server.api<UsageReport>('GET', '/api/usage?range=today');
      return r.totals.output === 5000 ? r : null;
    },
    { message: 'usage counted once (duplicate line deduplicated)' },
  );
  expect(report.totals).toMatchObject({ input: 100, output: 5000, cacheCreate: 2000, cacheRead: 10000, weighted: 8100, messages: 1 });
  expect(report.totals.costUsd).toBeCloseTo(0.0602, 4);
  expect(report.byConsole[0]).toMatchObject({ key: consoleId, label: 'Tally' });
  expect(report.byModel[0].key).toBe('claude-sonnet-5-5');
  expect(report.machineTotals.today.weighted).toBe(8100);

  await expect(consoleNode(page, consoleId).getByTestId('console-tokens')).toHaveText('8.1k tok');

  await page.getByTestId('sidebar-tab-progress').click();
  const section = page.getByTestId('usage-section');
  await expect(section.getByTestId('usage-total')).toHaveText('8.1k');
  await expect(section.getByTestId('usage-cost')).toHaveText('≈$0.06');
  await expect(section.getByTestId('usage-agents')).toContainText('Tally');
  await expect(section.getByTestId('usage-models')).toContainText('Sonnet 5.5');
  await expect(section.getByTestId('usage-sparkline')).toBeVisible();
  await section.getByTestId('usage-range-7d').click();
  await expect(section.getByTestId('usage-total')).toHaveText('8.1k');
});

test('a used-up budget files an action, pauses jobs and shows the banner', async () => {
  await server.api('PATCH', '/api/settings', { budgetDailyTokens: 10_000, pauseJobsAtBudget: true });
  // 8.1k of 10k = 81%: the 80% alert
  await waitFor(
    async () => {
      const state = await server.api<BoardState>('GET', '/api/state');
      return state.actions.some((a: ActionItem) => a.kind === 'budget' && a.title === 'Today budget at 80%' && !a.resolvedAt);
    },
    { message: '80% budget action' },
  );
  const meter = page.locator('[data-testid="usage-budget"][data-budget="daily"]');
  await expect(meter).toContainText('81%');

  await server.api('PATCH', '/api/settings', { budgetDailyTokens: 5000 });
  await waitFor(
    async () => {
      const state = await server.api<BoardState>('GET', '/api/state');
      const open = state.actions.filter((a: ActionItem) => a.kind === 'budget' && !a.resolvedAt);
      return open.length === 1 && open[0].title === 'Today budget at 100%';
    },
    { message: '100% budget action replaces the 80% one' },
  );
  await expect(page.getByTestId('jobs-paused-board-banner')).toBeVisible();
  await expect(meter).toContainText('162%');
  await page.screenshot({
    path: process.env.USAGE_SCREENSHOT ?? path.join(home, 'usage.png'),
  });

  const res = await fetch(`${server.origin}/bridge/${consoleId}/jobs?token=${server.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'nobody', title: 't', message: 'm' }),
  });
  expect(res.status).toBe(429);
  expect(((await res.json()) as { error: string }).error).toMatch(/New jobs are paused/);

  await server.api('PATCH', '/api/settings', { pauseJobsAtBudget: false });
  await expect(page.getByTestId('jobs-paused-board-banner')).toHaveCount(0);
});

test('budgets can be set from Settings › Usage & budgets', async () => {
  await page.getByTestId('sidebar-tab-settings').click();
  await page.getByRole('button', { name: 'Usage & budgets' }).first().click();
  const row = page.locator('[data-setting-id="budget-weekly"]');
  await expect(row).toBeVisible();
  await row.getByRole('textbox', { name: 'Weekly budget' }).fill('2.5M');
  await row.getByRole('button', { name: 'Save' }).click();
  await waitFor(
    async () => (await server.api<{ settings: { budgetWeeklyTokens: number } }>('GET', '/api/settings')).settings.budgetWeeklyTokens === 2_500_000,
    { message: 'weekly budget saved' },
  );
});
