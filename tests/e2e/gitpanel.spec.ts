import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, flyToConsole } from './helpers/board';
import { AgentArmyServer, makeTempHome } from './helpers/server';

// Git panel for a plain console in a repo (no worktree): branches, stage/commit, push/pull/fetch
// against a local bare remote, recent commits. Never touches a real remote.
test.describe.configure({ mode: 'serial' });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let home: string;
let repo: string;
let remote: string;
let other: string;
let server: AgentArmyServer;
let page: Page;
let agent: ConsoleInfo;

function tempHome(label: string): string {
  const base = process.env.E2E_HOME_BASE;
  if (!base) return makeTempHome(label);
  fs.mkdirSync(base, { recursive: true });
  return fs.realpathSync.native(fs.mkdtempSync(path.join(base, `${label}-`)));
}

function commitIn(dir: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

test.beforeAll(async ({ browser }) => {
  home = tempHome('gitpanel');
  repo = path.join(home, 'demo');
  remote = path.join(home, 'remote.git');
  other = path.join(home, 'other');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.name', 'E2E'],
    ['user.email', 'e2e@example.com'],
    ['core.autocrlf', 'false'],
  ]) git(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const answer = 42;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'remote', 'add', 'origin', remote);

  server = await AgentArmyServer.start({
    home,
    port: Number(process.env.E2E_PORT ?? 0) || undefined,
    // The temp dir may sit inside a repo (a home folder under git); stop git discovery above it
    env: { GIT_CEILING_DIRECTORIES: fs.realpathSync.native(path.dirname(home)) },
  });
  page = await browser.newPage();
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: repo, name: 'Gita' });
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  // The fake claude processes may still hold their folders for a moment on Windows
  if (home) {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      // leftovers stay in the temp folder
    }
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

const panel = () => page.getByTestId('git-panel');

test('a. the console header shows the branch and opens the Git panel', async () => {
  await page.goto(server.url);
  await flyToConsole(page, agent.id);
  const chip = consoleNode(page, agent.id).getByTestId('console-git');
  await expect(chip).toContainText('main');
  // The Agents tab has a Git link too
  await expect(page.locator(`[data-testid="mission-item"][data-console-id="${agent.id}"]`).getByTestId('mission-git')).toBeVisible();
  await chip.click();
  await expect(panel()).toBeVisible();
  await expect(panel().getByTestId('git-repo-name')).toHaveText('demo');
  await expect(panel().getByTestId('git-branch')).toContainText('main');
  await expect(panel().getByTestId('git-no-upstream')).toHaveText('not pushed yet');
  await expect(panel().getByTestId('git-commit')).toBeDisabled();
  await expect(panel().getByTestId('git-log').getByTestId('git-log-entry')).toHaveCount(1);
});

test('b. stage one file, commit, and see it in the log with its diff', async () => {
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const answer = 43;\n');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'new notes\n');
  await panel().getByTestId('git-refresh').click();
  const changes = panel().getByTestId('git-changes');
  await expect(changes.getByTestId('git-file')).toHaveCount(2);
  await changes.locator('[data-file="app.ts"] > div > button').first().click();
  await expect(changes.locator('[data-file="app.ts"]').getByTestId('review-diff')).toContainText('answer = 43');

  await changes.locator('[data-file="app.ts"]').getByTestId('git-stage').click();
  const staged = panel().getByTestId('git-staged');
  await expect(staged.locator('[data-file="app.ts"]')).toBeVisible();
  await expect(changes.getByTestId('git-file')).toHaveCount(1);

  await panel().getByTestId('git-commit-message').fill('Bump the answer');
  await panel().locator('button[data-testid="git-commit"]').click();
  await expect(staged.getByTestId('git-file')).toHaveCount(0);
  const log = panel().getByTestId('git-log');
  await expect(log.getByTestId('git-log-entry').first()).toContainText('Bump the answer');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Bump the answer');
  expect(git(repo, 'status', '--porcelain')).toBe('?? notes.md'); // untracked file stayed out

  await log.getByTestId('git-log-entry').first().locator('button').click();
  const diff = log.getByTestId('git-commit-diff');
  await expect(diff).toContainText('app.ts');
  await expect(diff).toContainText('answer = 43');
});

test('c. first push sets the upstream; fetch and fast-forward pull', async () => {
  await panel().getByTestId('git-push').click();
  await expect(panel().getByTestId('git-remote-note')).toHaveAttribute('data-ok', 'true');
  await expect(panel().getByTestId('git-ahead')).toHaveText('0');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
  expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('Bump the answer');

  git(home, 'clone', '-q', remote, other);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.com');
  git(other, 'config', 'core.autocrlf', 'false');
  commitIn(other, 'other.txt', 'from the other clone\n', 'Other work');
  git(other, 'push', '-q');

  await panel().getByTestId('git-fetch').click();
  await expect(panel().getByTestId('git-behind')).toHaveText('1');
  await panel().getByTestId('git-pull').click();
  await expect(panel().getByTestId('git-remote-note')).toHaveAttribute('data-ok', 'true');
  await expect(panel().getByTestId('git-behind')).toHaveText('0');
  expect(fs.existsSync(path.join(repo, 'other.txt'))).toBe(true);
});

test('d. a diverged pull asks rebase or merge; rebase then push', async () => {
  commitIn(other, 'other2.txt', 'more\n', 'Other work 2');
  git(other, 'push', '-q');
  git(repo, 'add', 'notes.md');
  git(repo, 'commit', '-q', '-m', 'Add notes');
  await panel().getByTestId('git-fetch').click();
  await expect(panel().getByTestId('git-behind')).toHaveText('1');
  await expect(panel().getByTestId('git-ahead')).toHaveText('1');

  await panel().getByTestId('git-pull').click();
  const note = panel().getByTestId('git-remote-note');
  await expect(note).toHaveAttribute('data-reason', 'non-ff');
  await expect(note).toContainText('Pull with rebase or merge?');
  await panel().screenshot({ path: test.info().outputPath('git-panel-diverged.png') });
  await note.getByTestId('git-pull-rebase').click();
  await expect(panel().getByTestId('git-remote-note')).toHaveAttribute('data-ok', 'true');
  await expect(panel().getByTestId('git-behind')).toHaveText('0');
  await expect(panel().getByTestId('git-ahead')).toHaveText('1');
  await panel().getByTestId('git-push').click();
  await expect(panel().getByTestId('git-ahead')).toHaveText('0');
  expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('Add notes');
});

test('e. create a branch, refuse switching with a dirty tree, switch back', async () => {
  await panel().getByTestId('git-branch').click();
  await panel().getByTestId('git-branch-filter').fill('feature/panel');
  await panel().getByTestId('git-branch-create').click();
  await expect(panel().getByTestId('git-branch')).toContainText('feature/panel');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/panel');
  await expect(consoleNode(page, agent.id).getByTestId('console-git')).toContainText('feature/panel');

  fs.appendFileSync(path.join(repo, 'README.md'), 'dirty\n');
  await panel().getByTestId('git-refresh').click();
  await expect(panel().getByTestId('git-changes').getByTestId('git-file')).toHaveCount(1);
  await panel().getByTestId('git-branch').click();
  await panel().locator('[data-testid="git-branch-item"][data-branch="main"]').click();
  await expect(panel().getByTestId('git-error')).toContainText('Commit or stash them before switching branches');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/panel');

  // Stage all and commit, then switching works
  await panel().getByTestId('git-stage-all').click();
  await expect(panel().getByTestId('git-staged').getByTestId('git-file')).toHaveCount(1);
  await panel().getByTestId('git-commit-message').fill('Docs on the branch');
  await panel().getByTestId('git-commit-message').press('Control+Enter');
  await expect(panel().getByTestId('git-staged').getByTestId('git-file')).toHaveCount(0);
  await panel().getByTestId('git-branch').click();
  await panel().locator('[data-testid="git-branch-item"][data-branch="main"]').click();
  await expect(panel().getByTestId('git-branch')).toContainText('main');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
});

test('f. screenshot: the Git panel with changes and history', async () => {
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const answer = 44;\nexport const question = "?";\n');
  fs.writeFileSync(path.join(repo, 'todo.md'), '- ship the git panel\n');
  git(repo, 'add', 'todo.md');
  await panel().getByTestId('git-refresh').click();
  await expect(panel().getByTestId('git-staged').getByTestId('git-file')).toHaveCount(1);
  await panel().getByTestId('git-changes').locator('[data-file="app.ts"] > div > button').first().click();
  await panel().getByTestId('git-log').getByTestId('git-log-entry').nth(1).locator('button').click();
  await expect(panel().getByTestId('git-commit-diff').first()).toBeVisible();
  await page.waitForTimeout(300);
  await panel().screenshot({ path: test.info().outputPath('git-panel.png') });
  if (process.env.E2E_SCREENSHOT_DIR) {
    await panel().screenshot({ path: path.join(process.env.E2E_SCREENSHOT_DIR, 'git-panel.png') });
  }
  // Changed file -> code viewer
  await panel().getByTestId('git-changes').locator('[data-file="app.ts"]').getByTestId('git-file-open').click();
  await expect(page.getByTestId('code-viewer')).toBeVisible();
  await expect(page.getByTestId('code-file-path')).toHaveText('app.ts');
  await expect(page.getByTestId('code-lines')).toContainText('answer = 44');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('code-viewer')).toBeHidden();
  await expect(panel()).toBeVisible(); // Escape closed only the viewer on top
});

test('g. push with no remote reachable shows a clear error', async () => {
  git(repo, 'remote', 'set-url', 'origin', path.join(home, 'missing.git'));
  await panel().getByTestId('git-push').click();
  const note = panel().getByTestId('git-remote-note');
  await expect(note).toHaveAttribute('data-ok', 'false');
  await expect(note).toContainText(/remote|repository/i);
});

