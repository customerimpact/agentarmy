import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, flyToConsole } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

// Code viewer: lazy tree that respects .gitignore, search, highlighting, jump to line, VS Code link,
// binary / too-large files, path guard, and a pinned file card that refreshes when the file changes.
test.describe.configure({ mode: 'serial' });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let home: string;
let repo: string;
let plain: string;
let server: AgentArmyServer;
let page: Page;
let agent: ConsoleInfo;
let walker: ConsoleInfo;

function tempHome(label: string): string {
  const base = process.env.E2E_HOME_BASE;
  if (!base) return makeTempHome(label);
  fs.mkdirSync(base, { recursive: true });
  return fs.realpathSync.native(fs.mkdtempSync(path.join(base, `${label}-`)));
}

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const appSource = (version: number) =>
  [
    '// The app entry point',
    `export const VERSION = ${version};`,
    '',
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    ...Array.from({ length: 60 }, (_, i) => `export const value${i + 1} = ${i + 1}; // line ${i + 8}`),
  ].join('\n') + '\n';

test.beforeAll(async ({ browser }) => {
  home = tempHome('codeviewer');
  repo = path.join(home, 'shop');
  plain = path.join(home, 'plain');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, '.gitignore', 'build/\n*.log\n');
  write(repo, 'README.md', '# Shop\n');
  write(repo, 'src/app.ts', appSource(1));
  write(repo, 'src/lib/util.ts', 'export const add = (a: number, b: number) => a + b;\n');
  write(repo, 'build/bundle.js', 'ignored\n');
  write(repo, 'debug.log', 'ignored\n');
  write(repo, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
  write(repo, 'big.txt', 'x'.repeat(1024 * 1024 + 10));
  fs.writeFileSync(path.join(home, 'outside.txt'), 'secret\n');
  write(plain, 'index.js', 'console.log(1);\n');
  write(plain, 'node_modules/dep/index.js', 'module.exports = 1;\n');

  server = await AgentArmyServer.start({
    home,
    port: Number(process.env.E2E_PORT ?? 0) || undefined,
    env: { GIT_CEILING_DIRECTORIES: fs.realpathSync.native(path.dirname(home)) },
  });
  page = await browser.newPage();
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: repo, name: 'Cody' });
  walker = await server.api<ConsoleInfo>('POST', '/api/consoles', {
    cwd: plain,
    name: 'Walt',
    layout: { x: 0, y: 900 },
  });
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

const viewer = () => page.getByTestId('code-viewer');

test('a. the file tree lists git files and hides ignored ones', async () => {
  await page.goto(server.url);
  await flyToConsole(page, agent.id);
  await consoleNode(page, agent.id).getByTestId('console-files').click();
  await expect(viewer()).toBeVisible();
  const tree = viewer().getByTestId('code-tree');
  await expect(tree.getByTestId('code-tree-dir')).toHaveText(['src']);
  await expect(tree.getByTestId('code-tree-file')).toHaveText(['.gitignore', 'big.txt', 'logo.png', 'README.md']);
  await expect(viewer()).toContainText('.gitignore respected');
  await tree.locator('[data-testid="code-tree-dir"][data-path="src"]').click();
  await tree.locator('[data-testid="code-tree-dir"][data-path="src/lib"]').click();
  await expect(tree.locator('[data-testid="code-tree-file"][data-path="src/lib/util.ts"]')).toBeVisible();
});

test('b. open a file: highlighted, line numbers, jump to line, VS Code link', async () => {
  await viewer().locator('[data-testid="code-tree-file"][data-path="src/app.ts"]').click();
  await expect(viewer().getByTestId('code-file-path')).toHaveText('src/app.ts');
  const lines = viewer().getByTestId('code-lines');
  await expect(lines).toContainText('export function greet');
  await expect(lines.locator('.hljs-keyword').first()).toBeVisible(); // highlight.js chunk loaded
  await expect(lines.locator('tr')).toHaveCount(68);
  await viewer().getByTestId('code-goto').fill('50');
  await viewer().getByTestId('code-goto').press('Enter');
  const row = lines.locator('tr[data-line="50"]');
  await expect(row).toHaveClass(/bg-accent/);
  await expect(row).toBeInViewport();
  const href = await viewer().getByTestId('code-open-vscode').getAttribute('href');
  expect(href).toMatch(/^vscode:\/\/file\/.*\/shop\/src\/app\.ts:50$/);
  await viewer().screenshot({ path: test.info().outputPath('code-viewer.png') });
  if (process.env.E2E_SCREENSHOT_DIR) {
    await viewer().screenshot({ path: path.join(process.env.E2E_SCREENSHOT_DIR, 'code-viewer.png') });
  }
});

test('c. search file names; binary and too-large files are not shown', async () => {
  await viewer().getByTestId('code-search').fill('util');
  await expect(viewer().getByTestId('code-search-result')).toHaveCount(1);
  await viewer().getByTestId('code-search').fill('bundle');
  await expect(viewer().getByTestId('code-search-results')).toContainText('No file names match');
  await viewer().getByTestId('code-search').fill('');
  await viewer().locator('[data-testid="code-tree-file"][data-path="logo.png"]').click();
  await expect(viewer().getByTestId('code-binary')).toBeVisible();
  await viewer().locator('[data-testid="code-tree-file"][data-path="big.txt"]').click();
  await expect(viewer().getByTestId('code-too-large')).toContainText('too large');
});

test('d. the path guard refuses .., absolute paths and ignored-folder escapes', async () => {
  const get = (p: string) =>
    fetch(`${server.origin}/api/code/${agent.id}/file?path=${encodeURIComponent(p)}`, {
      headers: { 'x-agentarmy-token': server.token },
    });
  expect((await get('../outside.txt')).status).toBe(400);
  expect((await get(path.join(home, 'outside.txt'))).status).toBe(400);
  expect((await get('src/../../outside.txt')).status).toBe(400);
  fs.symlinkSync(home, path.join(repo, 'escape'), 'junction');
  expect((await get('escape/outside.txt')).status).toBe(403);
  fs.rmSync(path.join(repo, 'escape'), { recursive: true, force: true });
  expect((await get('src/app.ts')).status).toBe(200);
});

test('e. pin to board: the card shows the file and refreshes when it changes', async () => {
  await viewer().locator('[data-testid="code-tree-file"][data-path="src/app.ts"]').click();
  await viewer().getByTestId('code-goto').fill('3');
  await viewer().getByTestId('code-goto').press('Enter');
  await viewer().getByTestId('code-pin').click();
  const state = await waitFor(async () => {
    const s = await server.api<BoardState & { items: { kind: string; data: Record<string, unknown> }[] }>('GET', '/api/state');
    return s.items?.find((i) => i.kind === 'file') ? s : null;
  });
  expect(state.items.find((i) => i.kind === 'file')!.data).toEqual({ path: 'src/app.ts', consoleId: agent.id, line: 3 });
  await page.keyboard.press('Escape');
  await expect(viewer()).toBeHidden();

  const card = page.getByTestId('file-card');
  await expect(card).toHaveAttribute('data-path', 'src/app.ts');
  await expect(card.getByTestId('file-card-lines')).toContainText('VERSION = 1');
  await expect(card.getByTestId('file-card-lines').locator('tr')).toHaveCount(40);
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('f');
  await page.waitForTimeout(600);

  write(repo, 'src/app.ts', appSource(2));
  await expect(card.getByTestId('file-card-lines')).toContainText('VERSION = 2', { timeout: 10_000 });
  // Zoom the board in on the card (wheel over its header) so the screenshot is readable
  for (let i = 0; i < 12; i++) {
    const box = await card.boundingBox();
    if (!box || box.width >= 480) break;
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  await card.screenshot({ path: test.info().outputPath('file-card.png') });
  if (process.env.E2E_SCREENSHOT_DIR) {
    await card.screenshot({ path: path.join(process.env.E2E_SCREENSHOT_DIR, 'file-card.png') });
  }

  // Click a line on the card -> the viewer opens there
  await card.locator('tr[data-line="10"] td').nth(1).click();
  await expect(viewer()).toBeVisible();
  await expect(viewer().getByTestId('code-lines').locator('tr[data-line="10"]')).toHaveClass(/bg-accent/);
  await page.keyboard.press('Escape');
});

test('f. a folder outside git uses a directory walk that skips node_modules', async () => {
  await flyToConsole(page, walker.id);
  await expect(consoleNode(page, walker.id).getByTestId('console-git')).toHaveCount(0);
  await consoleNode(page, walker.id).getByTestId('console-files').click();
  const tree = viewer().getByTestId('code-tree');
  await expect(tree.getByTestId('code-tree-file')).toHaveText(['index.js']);
  await expect(tree.getByTestId('code-tree-dir')).toHaveCount(0);
  await expect(viewer()).toContainText('node_modules, .git, dist hidden');
});
