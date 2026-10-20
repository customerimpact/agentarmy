import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { BoardState } from '../../src/shared/protocol';
import { spawn } from 'node:child_process';
import { consoleNode, expectStatus, typeInTerminal } from '../e2e/helpers/board';
import { FAKE_CLAUDE_SHIM, REPO_ROOT, freePort, waitFor } from '../e2e/helpers/server';

// Smoke test of the Windows desktop app: window + board, a console that reaches idle (node-pty and the
// SessionStart hook relay work inside Electron), close-to-tray keeps the server, Quit shuts it down.
test.describe.configure({ mode: 'serial' });

const ROOT = path.join(os.tmpdir(), 'agentarmy-desktop-test');
let home: string;
let dataDir: string;
let port: number;
let app: ElectronApplication;
let page: Page;
let quitDone = false;
let env: Record<string, string>;
let consoleId = '';

interface Peek {
  tray: () => { count: number; items: { consoleId: string | null; label: string }[] } | null;
  flyTo: (id: string | null) => void;
  ownsServer: () => boolean;
}
const peek = <T>(fn: (p: Peek) => T): Promise<T> =>
  app.evaluate((_electron, source) => {
    const p = (globalThis as unknown as { __agentarmyDesktop: Peek }).__agentarmyDesktop;
    return new Function('p', `return (${source})(p)`)(p) as T;
  }, fn.toString());

async function api<T>(urlPath: string): Promise<T> {
  const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { 'x-agentarmy-token': token },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`${urlPath} -> ${res.status}`);
  return (await res.json()) as T;
}

test.beforeAll(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(ROOT, 'run-')));
  dataDir = path.join(home, '.agentarmy');
  fs.mkdirSync(path.join(home, 'alpha-project'));
  port = await freePort();
  env = {
    ...(process.env as Record<string, string>),
    AGENTARMY_HOME: dataDir,
    AGENTARMY_NO_SIGNIN_PROMPT: '1',
    GRIDHIVE_CLOUD_URL: 'http://127.0.0.1:9',
    AGENTARMY_PORT: String(port),
    AGENTARMY_CLAUDE_PATH: FAKE_CLAUDE_SHIM,
    AGENTARMY_DISABLE_UPDATES: '1',
    HOME: home,
    USERPROFILE: home,
    FAKE_CLAUDE_DELAY_MS: '800',
  };
  delete env.CLAUDECODE;
  delete env.AGENTARMY_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.env.DESKTOP_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [path.join(REPO_ROOT, 'dist', 'desktop', 'main.js')] }),
    env,
    cwd: home,
  });
  // The app's own log ([gridhive] ...) ends up in the test output, which is all CI gives us on failure
  app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[app] ${d}`));
  app.process().stderr?.on('data', (d: Buffer) => process.stdout.write(`[app:err] ${d}`));
  page = await app.firstWindow();
});

test.afterAll(async () => {
  // Only if a test failed before the quit step: make sure nothing we started keeps running
  if (!app || quitDone) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
});

test('the window opens on the board with the desktop title bar', async () => {
  // Generous: the first start of a freshly built exe is slow while Windows scans it
  await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => window.agentarmyDesktop?.isDesktop)).toBe(true);
  await expect(page.locator('[data-desktop-titlebar]')).toBeVisible();
  // Token was used once in the URL and is gone now; the server's cookie carries the session
  expect(page.url()).not.toContain('token=');
  const win = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { visible: w.isVisible(), title: w.getTitle() };
  });
  expect(win.visible).toBe(true);
});

test('a second launch exits and leaves the first window in charge', async () => {
  expect(await peek((p) => p.ownsServer())).toBe(true);
  const exe = process.env.DESKTOP_EXE ?? path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = process.env.DESKTOP_EXE ? [] : [path.join(REPO_ROOT, 'dist', 'desktop', 'main.js')];
  const second = spawn(exe, args, { env, stdio: 'ignore', windowsHide: true });
  const code = await new Promise<number | null>((resolve) => second.once('exit', resolve));
  expect(code).toBe(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test('a console starts in the packaged runtime and reaches idle', async () => {
  await page.getByTestId('empty-state').getByRole('button', { name: 'New agent' }).click();
  const picker = page.getByTestId('folder-picker');
  await picker.getByRole('button', { name: 'alpha-project' }).click();
  await picker.getByTestId('folder-picker-use').click();
  const created = await waitFor(async () => (await api<BoardState>('/api/state')).consoles[0], {
    message: 'console in state',
  });
  // idle needs the SessionStart command hook, which runs through the PowerShell relay in Electron
  await expectStatus(page, created.id, 'idle', 30_000);
  await expect(consoleNode(page, created.id)).toBeVisible();
  consoleId = created.id;
  await page.screenshot({ path: path.join(ROOT, 'desktop-window.png') });
});

test('an agent that needs you shows up in the tray', async () => {
  expect((await peek((p) => p.tray()))?.count).toBe(0);
  await typeInTerminal(page, consoleId, 'ask');
  await expectStatus(page, consoleId, 'needs_you');
  await expect.poll(async () => (await peek((p) => p.tray()))?.count).toBeGreaterThan(0);
  const tray = await peek((p) => p.tray());
  expect(tray?.items.some((item) => item.consoleId === consoleId)).toBe(true);
  // Answer it ("1" = allow) so the agent finishes its turn
  await page.keyboard.press('1');
  await expect.poll(async () => (await peek((p) => p.tray()))?.count).toBe(0);
});

test('closing the window hides it and keeps the server and agents running', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(false);
  const state = await api<BoardState>('/api/state');
  expect(state.consoles).toHaveLength(1);
  expect(state.consoles[0].status).not.toBe('exited');
  // The tray's "needs you" entries bring the window back and fly to the console
  await peek((p) => p.flyTo(null));
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true);
});

test('quit asks first, then saves the board and stops the server', async () => {
  // The "agents are running" confirmation: Cancel first (nothing stops), then Quit
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { __aaAnswers?: number[]; __aaAsked?: number };
    g.__aaAnswers = [1, 0];
    g.__aaAsked = 0;
    dialog.showMessageBox = (async () => {
      g.__aaAsked = (g.__aaAsked ?? 0) + 1;
      return { response: g.__aaAnswers!.shift() ?? 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await expect.poll(() => app.evaluate(() => (globalThis as { __aaAsked?: number }).__aaAsked)).toBe(1);
  expect((await api<BoardState>('/api/state')).consoles).toHaveLength(1); // cancelled: still serving
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await closed;
  quitDone = true;
  await expect.poll(() => api('/api/state').then(() => 'up', () => 'down')).toBe('down');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as BoardState;
  // Saved as it was (not 'exited'), so the next start offers to resume it, like the CLI's Ctrl+C
  expect(saved.consoles[0].status).not.toBe('exited');
  expect(fs.existsSync(path.join(dataDir, 'server.lock'))).toBe(false);
});
