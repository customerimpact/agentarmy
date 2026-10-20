import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import type { ProviderStatus, ProvidersResponse } from '../../src/shared/providers';
import { consoleNode, expectTerminalToContain, typeInTerminal } from './helpers/board';
import { AgentArmyServer, REPO_ROOT, waitFor } from './helpers/server';

// Agents & accounts hub with fake CLIs: status per provider, one-click Install (fake npm that drops a
// gemini shim), Log in to Codex in a terminal (fake `codex login` writes auth.json into CODEX_HOME when
// the user presses Enter), an extra Codex account with its own CODEX_HOME, and its agent console.
// No real CLI, login or ~/.codex is ever touched: every config dir lives in the temp home.
test.describe.configure({ mode: 'serial' });

const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'fake-cli');
const FAKE_CODEX = path.join(FAKE_CLI, process.platform === 'win32' ? 'codex.cmd' : 'codex');
const FAKE_INSTALL = path.join(FAKE_CLI, 'fake-install.mjs');
const SHOTS = process.env.PROVIDERS_SCREENSHOT_DIR;

let root: string;
let home: string;
let codexHome: string;
let geminiShim: string;
let server: AgentArmyServer;
let page: Page;

const providers = async (fresh = true) => (await server.api<ProvidersResponse>('GET', `/api/providers${fresh ? '?fresh=1' : ''}`)).providers;
const provider = async (id: string): Promise<ProviderStatus> => (await providers()).find((p) => p.id === id)!;
const consoles = async () => (await server.api<BoardState>('GET', '/api/state')).consoles;
const card = (id: string) => page.locator(`[data-testid="provider-card"][data-provider="${id}"]`);

async function openHub(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+,');
  await page.getByTestId('settings-nav-agents').click();
  await expect(page.getByTestId('providers-hub')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  root = process.env.PROVIDERS_E2E_ROOT ?? os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'providers-')));
  codexHome = path.join(home, 'codex-home');
  geminiShim = path.join(home, 'bin', process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
  const noKeys = Object.fromEntries(['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY'].map((k) => [k, '']));
  server = await AgentArmyServer.start({
    home,
    port: Number(process.env.PROVIDERS_E2E_PORT ?? 0) || undefined,
    env: {
      ...noKeys,
      CODEX_HOME: codexHome,
      GEMINI_CLI_HOME: home,
      XDG_DATA_HOME: path.join(home, 'xdg-data'),
      FAKE_CODEX_DELAY_MS: '300',
      AGENTARMY_INSTALL_GEMINI: `node "${FAKE_INSTALL}" "${geminiShim}" 0.64.0-fake`,
    },
  });
  await server.api('PATCH', '/api/settings', { agentPaths: { codex: FAKE_CODEX, gemini: geminiShim } });
  page = await browser.newPage();
  await page.goto(server.url);
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

test('a. GET /api/providers reports install and login per provider', async () => {
  const list = await providers();
  expect(list.map((p) => p.id)).toEqual(['claude', 'codex', 'gemini', 'opencode', 'grok']);
  expect(list.find((p) => p.id === 'codex')).toMatchObject({ installed: true, version: 'codex-cli 0.0.0-fake', loggedIn: false, accountEnvVar: 'CODEX_HOME' });
  expect(list.find((p) => p.id === 'gemini')).toMatchObject({ installed: false, loggedIn: false });
  expect(list.find((p) => p.id === 'claude')?.usageAvailable).toBe(true);
});

test('b. Settings › Agents & accounts shows one card per provider', async () => {
  await openHub();
  await expect(page.getByTestId('provider-card')).toHaveCount(5);
  await expect(card('codex').getByTestId('provider-installed')).toHaveAttribute('data-ok', 'true');
  await expect(card('codex').getByTestId('provider-installed')).toContainText('codex-cli 0.0.0-fake');
  await expect(card('codex').getByTestId('provider-logged-in')).toHaveAttribute('data-ok', 'false');
  await expect(card('codex').getByTestId('provider-billing')).toHaveText('Subscription or API key');
  await expect(card('gemini').getByTestId('provider-installed')).toHaveAttribute('data-ok', 'false');
  await expect(card('codex').getByTestId('provider-signup')).toHaveAttribute('href', 'https://chatgpt.com/');
  // The Claude account cards (usage, auto-switch) live in the Claude Code card
  await expect(card('claude').getByTestId('account-card')).toHaveCount(1);
  await expect(card('claude').getByTestId('provider-default')).toBeChecked();
});

test('c. Install asks first, runs in an Install console and reports success', async () => {
  await card('gemini').getByTestId('provider-install').click();
  await expect(page.getByText('This runs `npm i -g @google/gemini-cli` on your computer')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();
  const install = await waitFor(async () => (await consoles()).find((c) => c.role === 'Install') ?? null);
  expect(install).toMatchObject({ name: 'Install · Gemini', agent: 'custom', cwd: home });
  await expect(page.getByText('Gemini CLI installed').first()).toBeVisible({ timeout: 20_000 });
  expect(await provider('gemini')).toMatchObject({ installed: true, version: '0.64.0-fake' });
  // A successful install closes its terminal after a moment
  await waitFor(async () => !(await consoles()).some((c) => c.id === install.id), { timeout: 15_000, message: 'install console closed' });
});

test('d. Log in to Codex: the user finishes in the terminal, then it closes', async () => {
  await openHub();
  await card('codex').getByTestId('provider-login').click();
  const login = await waitFor(async () => (await consoles()).find((c) => c.role === 'Login') ?? null);
  expect(login).toMatchObject({ name: 'Login · Codex', agent: 'custom' });
  expect(login.accountId).toBeUndefined(); // the CLI default: no env var
  await expectTerminalToContain(page, login.id, 'Press Enter to finish signing in');
  await expectTerminalToContain(page, login.id, `codex-home ${codexHome}`);
  await typeInTerminal(page, login.id, '');
  await expect(page.getByText('Codex CLI: logged in').first()).toBeVisible({ timeout: 20_000 });
  await waitFor(async () => !(await consoles()).some((c) => c.id === login.id), { message: 'login console closed' });
  expect(fs.existsSync(path.join(codexHome, 'auth.json'))).toBe(true);
  expect(await provider('codex')).toMatchObject({ loggedIn: true, loginMethod: 'login file' });
});

test('e. A second Codex account gets its own CODEX_HOME for login and for agents', async () => {
  await openHub();
  await expect(card('codex').getByTestId('provider-logged-in')).toHaveAttribute('data-ok', 'true');
  await card('codex').getByTestId('provider-add-account-name').fill('Work');
  await card('codex').getByTestId('provider-add-account').click();
  const row = card('codex').locator('[data-testid="provider-account"]', { hasText: 'Work' });
  await expect(row).toHaveAttribute('data-logged-in', 'false');
  const work = (await provider('codex')).accounts.find((a) => a.name === 'Work')!;
  expect(work.configDir).toBe(path.join(home, '.agentarmy', 'accounts', 'codex', work.id));
  if (SHOTS) await page.getByTestId('settings-window').screenshot({ path: path.join(SHOTS, 'providers-hub.png') });

  await row.getByTestId('provider-account-login').click();
  const login = await waitFor(async () => (await consoles()).find((c) => c.role === 'Login') ?? null);
  expect(login).toMatchObject({ name: 'Login · Codex Work', accountId: work.id });
  await expectTerminalToContain(page, login.id, `codex-home ${work.configDir}`);
  await typeInTerminal(page, login.id, '');
  await waitFor(async () => (await provider('codex')).accounts.find((a) => a.id === work.id)?.loggedIn === true, { message: 'Work logged in' });
  expect(fs.existsSync(path.join(work.configDir, 'auth.json'))).toBe(true);

  // An agent on that account runs with CODEX_HOME = the account's folder
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: project, agent: 'codex', accountId: work.id });
  expect(agent.accountId).toBe(work.id);
  await expect(consoleNode(page, agent.id)).toBeVisible();
  await expectTerminalToContain(page, agent.id, `codex-home ${work.configDir}`);
  // ...and one on the default account keeps the CLI's own CODEX_HOME
  const plain = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: project, agent: 'codex' });
  expect(plain.accountId).toBeUndefined();
  await expectTerminalToContain(page, plain.id, `codex-home ${codexHome}`);
});

test('f. New agent dialog: Codex lists only Codex accounts; a CLI that is not logged in offers Log in', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.getByRole('button', { name: 'New agent' }).first().click();
  const dialog = page.getByTestId('folder-picker');
  await dialog.getByTestId('agent-option-codex').click();
  const picker = dialog.getByTestId('account-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveText(['Auto', 'Default', 'Work']);
  // Claude (fake, nobody logged in) offers a one-click Log in
  await dialog.getByTestId('agent-option-claude').click();
  await expect(dialog.getByTestId('provider-quickfix')).toHaveAttribute('data-fix', 'login');
  if (SHOTS) await dialog.screenshot({ path: path.join(SHOTS, 'providers-new-agent.png') });
  await page.keyboard.press('Escape');
});
