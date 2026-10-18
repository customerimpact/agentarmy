import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, flyToConsole } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Worktree + review: an agent on its own branch, reviewed, committed and merged from the board
test.describe.configure({ mode: 'serial' });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let home: string;
let repo: string;
let server: AgentArmyServer;
let page: Page;
let agent: ConsoleInfo;

const readState = () => server.api<BoardState>('GET', '/api/state');

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('worktree');
  repo = path.join(home, 'demo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'E2E');
  git(repo, 'config', 'user.email', 'e2e@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  server = await AgentArmyServer.start({
    home,
    port: Number(process.env.E2E_WORKTREE_PORT ?? 0) || undefined,
    // The temp dir may sit inside a repo (a home folder under git); stop git discovery at it
    env: { GIT_CEILING_DIRECTORIES: fs.realpathSync.native(os.tmpdir()) },
  });
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

test('a. create an agent on an isolated branch', async () => {
  await page.goto(server.url);
  await page.getByTestId('empty-state').getByRole('button', { name: 'New agent' }).click();
  const picker = page.getByTestId('folder-picker');
  await picker.getByRole('button', { name: 'demo' }).click();
  const toggle = picker.getByTestId('worktree-toggle');
  await expect(toggle).toBeVisible();
  await toggle.getByTestId('worktree-toggle-input').check();
  await picker.getByTestId('folder-picker-use').click();
  await expect(picker).toBeHidden();

  agent = await waitFor(async () => (await readState()).consoles.find((c) => c.git), {
    message: 'console with git',
  });
  expect(agent.git!.branch).toMatch(/^agentarmy\//);
  expect(agent.git!.baseRef).toBe('main');
  expect(path.dirname(agent.git!.worktree)).toBe(path.join(home, 'demo.worktrees'));
  expect(path.resolve(agent.cwd)).toBe(path.resolve(agent.git!.worktree));
  expect(git(agent.git!.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(agent.git!.branch);
  await expect(consoleNode(page, agent.id).getByTestId('console-review')).toBeVisible();
});

test('b. review shows the agent work, commit and merge into main', async () => {
  // Simulate the agent writing a file in its worktree
  fs.writeFileSync(path.join(agent.git!.worktree, 'feature.txt'), 'hello from the agent\nsecond line\n');
  fs.appendFileSync(path.join(agent.git!.worktree, 'README.md'), 'more docs\n');

  await flyToConsole(page, agent.id);
  await consoleNode(page, agent.id).getByTestId('console-review').click();
  const panel = page.getByTestId('review-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('review-branch')).toHaveText(agent.git!.branch);
  const uncommitted = panel.getByTestId('review-uncommitted');
  await expect(uncommitted.locator('[data-file="feature.txt"]')).toContainText('+2');
  await uncommitted.locator('[data-file="feature.txt"] button').click();
  await expect(uncommitted.getByTestId('review-diff')).toContainText('hello from the agent');
  await uncommitted.locator('[data-file="README.md"] button').click();
  await expect(uncommitted.locator('[data-file="README.md"]').getByTestId('review-diff')).toContainText('more docs');
  await expect(panel.getByTestId('review-merge')).toBeDisabled();
  // The header chip picked up the totals
  await expect(consoleNode(page, agent.id).getByTestId('console-review-stats')).toContainText('+3');
  await panel.screenshot({ path: test.info().outputPath('review-panel.png') });
  if (process.env.E2E_SCREENSHOT_DIR) {
    await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOT_DIR, 'review-panel.png') });
  }

  const message = panel.getByTestId('review-commit-message');
  await expect(message).toHaveValue(new RegExp(`^${agent.name}: `));
  await message.fill('Add feature file');
  await panel.getByTestId('review-commit').click();
  await expect(panel.getByTestId('review-committed').locator('[data-file="feature.txt"]')).toBeVisible();
  await expect(panel.getByTestId('review-ahead')).toContainText('1 ahead');
  expect(git(agent.git!.worktree, 'log', '-1', '--format=%s')).toBe('Add feature file');

  const merge = panel.getByTestId('review-merge');
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(panel.getByTestId('review-ahead')).toContainText('0 ahead');
  expect(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toBe('hello from the agent\nsecond line\n');
  expect(git(repo, 'log', '-1', '--format=%s')).toContain(`Merge ${agent.git!.branch}`);
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
});

test('c. a conflicting merge is aborted and the files are listed', async () => {
  fs.writeFileSync(path.join(agent.git!.worktree, 'README.md'), 'agent rewrite\n');
  git(agent.git!.worktree, 'commit', '-q', '-am', 'agent readme');
  fs.writeFileSync(path.join(repo, 'README.md'), 'main rewrite\n');
  git(repo, 'commit', '-q', '-am', 'main readme');

  const panel = page.getByTestId('review-panel');
  await panel.getByTestId('review-refresh').click();
  await expect(panel.getByTestId('review-ahead')).toContainText('1 ahead');
  await panel.getByTestId('review-merge').click();
  await expect(panel.getByTestId('review-conflicts')).toContainText('README.md');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('main rewrite\n');
});

test('d. discard stops the agent and removes its worktree and branch', async () => {
  const panel = page.getByTestId('review-panel');
  await panel.getByTestId('review-discard').click();
  await page.getByRole('button', { name: 'Discard branch' }).last().click();
  await expect(panel).toBeHidden({ timeout: 30_000 });
  await expect(consoleNode(page, agent.id)).toHaveCount(0);
  // The panel closes as soon as the console is gone; git cleanup finishes right after
  await waitFor(() => !fs.existsSync(agent.git!.worktree), { message: 'worktree removed', timeout: 20_000 });
  await waitFor(() => git(repo, 'branch', '--list', agent.git!.branch) === '', {
    message: 'branch deleted',
    timeout: 20_000,
  });
  expect(git(repo, 'worktree', 'list')).not.toContain('demo.worktrees');
});
