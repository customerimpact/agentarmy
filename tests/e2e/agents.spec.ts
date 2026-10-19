import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo } from '../../src/shared/protocol';
import type { AgentsDetectResponse } from '../../src/shared/agents';
import { consoleNode, expectStatus, expectTerminalToContain, flyToConsole, typeInTerminal } from './helpers/board';
import { AgentArmyServer, REPO_ROOT, makeTempHome, waitFor } from './helpers/server';

// Agent adapters end to end, with fake CLIs: a custom command console (status from PTY activity)
// and a fake Codex (OSC 9 notifications, notify relay with the thread id, resume by that id).
test.describe.configure({ mode: 'serial' });

const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'fake-cli');
const FAKE_CODEX = path.join(FAKE_CLI, process.platform === 'win32' ? 'codex.cmd' : 'codex');
const FAKE_TASK = path.join(FAKE_CLI, 'fake-task.mjs');
const SHOTS = process.env.AGENTS_SCREENSHOT_DIR;

let home: string;
let projectDir: string;
let server: AgentArmyServer;
let page: Page;
let codex: ConsoleInfo;

async function consoleState(id: string): Promise<ConsoleInfo | undefined> {
  return (await server.api<BoardState>('GET', '/api/state')).consoles.find((c) => c.id === id);
}

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('agents');
  projectDir = path.join(home, 'agents-project');
  fs.mkdirSync(projectDir);
  server = await AgentArmyServer.start({ home, port: Number(process.env.AGENTS_E2E_PORT ?? 0) || undefined, env: { FAKE_CODEX_DELAY_MS: '1500' } });
  await server.api('PATCH', '/api/settings', { agentPaths: { codex: FAKE_CODEX } });
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

test('a. detection lists every agent; the fake Codex is installed with its version', async () => {
  const res = await server.api<AgentsDetectResponse>('GET', '/api/agents/detect?fresh=1');
  expect(res.agents.map((a) => a.id)).toEqual(['claude', 'codex', 'gemini', 'opencode', 'custom']);
  const found = res.agents.find((a) => a.id === 'codex');
  expect(found).toMatchObject({ installed: true, version: 'codex-cli 0.0.0-fake', supportsResume: true });
  expect(res.agents.find((a) => a.id === 'custom')?.installed).toBe(true);
});

test('b. custom command console from the New agent dialog: working while it prints, then resting', async () => {
  await page.goto(server.url);
  await page.getByTestId('empty-state').getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByTestId('folder-picker');
  const picker = dialog.getByTestId('agent-picker');
  await expect(picker.getByTestId('agent-option-codex')).toHaveAttribute('data-installed', 'true');
  await expect(picker.getByTestId('agent-option-claude')).toHaveAttribute('aria-checked', 'true');

  // A CLI that is not installed shows the install hint and cannot launch
  const gemini = picker.getByTestId('agent-option-gemini');
  if ((await gemini.getAttribute('data-installed')) === 'false') {
    await gemini.click();
    await expect(dialog.getByTestId('agent-install-hint')).toContainText('npm install -g @google/gemini-cli');
    await expect(dialog.getByTestId('folder-picker-use')).toBeDisabled();
    if (SHOTS) await dialog.screenshot({ path: path.join(SHOTS, 'agent-picker-not-installed.png') });
  }

  await picker.getByTestId('agent-option-custom').click();
  const command = `node "${FAKE_TASK}"`;
  await dialog.getByTestId('custom-command').fill(command);
  await dialog.getByRole('button', { name: 'agents-project' }).click();
  if (SHOTS) await dialog.screenshot({ path: path.join(SHOTS, 'agent-picker-custom.png') });
  await dialog.getByTestId('folder-picker-use').click();
  await expect(dialog).toBeHidden();

  const created = await waitFor(async () => (await server.api<BoardState>('GET', '/api/state')).consoles[0], { message: 'custom console' });
  expect(created).toMatchObject({ agent: 'custom', command });
  const node = consoleNode(page, created.id);
  await expect(node.getByTestId('console-command')).toHaveText(command);
  await expectTerminalToContain(page, created.id, 'task output');
  await expectStatus(page, created.id, 'working', 5000);
  await expectTerminalToContain(page, created.id, 'task idle');
  await expectStatus(page, created.id, 'resting', 8000);

  // Typing "again" streams more output: working, then resting once more
  await typeInTerminal(page, created.id, 'again');
  await expectStatus(page, created.id, 'working', 5000);
  await expectStatus(page, created.id, 'resting', 8000);
});

test('c. Codex console: idle, working, needs you on an approval prompt, answered from the terminal', async () => {
  codex = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: projectDir, agent: 'codex', layout: { x: 900, y: 0 } });
  expect(codex.agent).toBe('codex');
  expect(codex.accountId).toBeUndefined();
  await expect(consoleNode(page, codex.id)).toBeVisible();
  await flyToConsole(page, codex.id);
  await expect(consoleNode(page, codex.id).getByTestId('console-agent')).toHaveText('Codex');
  await expectTerminalToContain(page, codex.id, 'OpenAI Codex');
  await expectTerminalToContain(page, codex.id, 'mcp: agentarmy ready'); // -c mcp_servers.agentarmy.* reached the CLI
  await expectStatus(page, codex.id, 'idle', 10_000);

  await typeInTerminal(page, codex.id, 'hello');
  await expectStatus(page, codex.id, 'working', 5000);
  await expectTerminalToContain(page, codex.id, 'Done: hello');
  await expectStatus(page, codex.id, 'resting', 8000);
  // The notify relay posted the thread id
  const withThread = await waitFor(async () => (await consoleState(codex.id))?.agentSessionId, { message: 'codex thread id' });
  expect(withThread).toMatch(/^[0-9a-f-]{36}$/);

  await typeInTerminal(page, codex.id, 'ask');
  await expectStatus(page, codex.id, 'needs_you', 5000);
  await expect(consoleNode(page, codex.id).getByTestId('console-status-detail')).toContainText('Approval requested');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'codex-needs-you.png') });

  await consoleNode(page, codex.id).locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.press('y');
  await expectTerminalToContain(page, codex.id, 'Approved');
  await expectStatus(page, codex.id, 'working', 5000);
  await expectTerminalToContain(page, codex.id, 'Done: ran npm install left-pad');
  await expectStatus(page, codex.id, 'resting', 8000);
});

test('d. restarting Codex resumes its thread', async () => {
  const before = await consoleState(codex.id);
  await server.api('POST', `/api/consoles/${codex.id}/restart`);
  await expectTerminalToContain(page, codex.id, `Resumed session ${before?.agentSessionId}`);
  await expectStatus(page, codex.id, 'idle', 10_000);
  if (SHOTS) {
    await page.getByRole('button', { name: 'Fit all' }).first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, 'board-codex-custom.png') });
  }
});

test('e. Settings > Agents lists the CLIs and saves the default agent', async () => {
  await page.locator('body').click({ position: { x: 900, y: 120 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('4');
  await expect(page.getByTestId('settings-window')).toBeVisible();
  await page.getByTestId('settings-nav-agents').click();
  await expect(page.getByTestId('settings-title')).toHaveText('Agents');
  const codexRow = page.locator('[data-testid="agent-row"][data-agent="codex"]');
  await expect(codexRow).toHaveAttribute('data-installed', 'true');
  await expect(codexRow).toContainText('codex-cli 0.0.0-fake');
  await page.locator('[data-setting-id="agents-default"]').getByRole('combobox').selectOption('codex');
  await waitFor(async () => (await server.api<{ settings: { defaultAgent: string } }>('GET', '/api/settings')).settings.defaultAgent === 'codex', {
    message: 'default agent saved',
  });
  if (SHOTS) await page.getByTestId('settings-window').screenshot({ path: path.join(SHOTS, 'settings-agents.png') });
});
