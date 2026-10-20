import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardState, ConsoleInfo, SwitchAgentResponse } from '../../src/shared/protocol';
import { consoleNode, expectStatus, expectTerminalToContain, flyToConsole } from './helpers/board';
import { AgentArmyServer, REPO_ROOT, waitFor } from './helpers/server';

// Switch a running agent to another CLI: a fake Claude console "Ada" moves to the fake Codex. The new
// console takes the same spot and name, gets the handoff brief once it is idle, the old one is removed,
// and the handoff job links them. A CLI that is not installed is refused with an install hint.
test.describe.configure({ mode: 'serial' });

const BASE = process.env.AA_E2E_TMP ?? path.join(os.tmpdir(), 'aa-v04-B');
const SHOTS = process.env.AA_E2E_SHOTS ?? BASE;
const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'fake-cli');
const FAKE_CODEX = path.join(FAKE_CLI, process.platform === 'win32' ? 'codex.cmd' : 'codex');
let home: string;
let dir: string;
let server: AgentArmyServer;
let page: Page;
let ada: ConsoleInfo;

async function state(): Promise<BoardState> {
  return server.api<BoardState>('GET', '/api/state');
}

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(BASE, { recursive: true });
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(BASE, 'switch-')));
  dir = path.join(home, 'shop');
  fs.mkdirSync(dir, { recursive: true });
  server = await AgentArmyServer.start({
    home,
    port: process.env.AA_E2E_PORT ? Number(process.env.AA_E2E_PORT) : undefined,
    env: { FAKE_CLAUDE_REAL_TRANSCRIPTS: '1', FAKE_CLAUDE_DELAY_MS: '600', FAKE_CODEX_DELAY_MS: '600' },
  });
  await server.api('PATCH', '/api/settings', { agentPaths: { codex: FAKE_CODEX, gemini: path.join(home, 'missing', 'gemini.exe') } });
  ada = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Ada', layout: { x: 0, y: 0, width: 640, height: 400 } });
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // a CLI that is still exiting may hold the folder on Windows; it is a temp dir
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a CLI that is not installed is refused with an install hint', async () => {
  await page.goto(server.url);
  await expectStatus(page, ada.id, 'idle');
  const res = await fetch(`${server.origin}/api/consoles/${ada.id}/switch-agent`, {
    method: 'POST',
    headers: { 'x-agentarmy-token': server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'gemini' }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; code: string; installCommand: string };
  expect(body).toMatchObject({ code: 'not_installed', installCommand: 'npm install -g @google/gemini-cli' });
  expect(body.error).toContain('Gemini CLI is not installed');
  expect((await state()).consoles).toHaveLength(1);
});

test('fake Claude console switches to fake Codex in the same spot: brief typed in, old one removed, job line', async () => {
  // Some history for the brief
  await server.api('POST', `/api/consoles/${ada.id}/send`, { text: 'plan' });
  await expectTerminalToContain(page, ada.id, 'Done: plan');
  await expectStatus(page, ada.id, 'resting');
  const before = (await state()).consoles.find((c) => c.id === ada.id)!;

  const res = await server.api<SwitchAgentResponse>('POST', `/api/consoles/${ada.id}/switch-agent`, { agent: 'codex', briefMode: 'quick' });
  expect(res.console).toMatchObject({ name: 'Ada', agent: 'codex', cwd: before.cwd });
  expect(res.console.layout).toMatchObject({ x: before.layout.x, y: before.layout.y, width: before.layout.width, height: before.layout.height });
  expect(res.job).toMatchObject({ fromId: ada.id, toId: res.console.id, kind: 'handoff', title: 'Switch: Ada Claude → Codex' });
  expect(res.brief).toMatch(/^\[GridHive handoff from Ada\]/);
  expect(res.brief).toContain('- plan');

  // The header shows the new CLI; the fake Codex submits the pasted brief as one prompt
  const next = res.console.id;
  await expect(consoleNode(page, next).getByTestId('console-agent')).toHaveAttribute('data-agent', 'codex');
  await flyToConsole(page, next);
  await expectTerminalToContain(page, next, 'Done: [GridHive handoff from Ada]', 30_000);

  await waitFor(async () => !(await state()).consoles.some((c) => c.id === ada.id), { message: 'the old console to be removed', timeout: 15_000 });
  await expect(consoleNode(page, ada.id)).toHaveCount(0);
  const after = await state();
  expect(after.consoles).toHaveLength(1);
  expect(after.consoles[0]).toMatchObject({ id: next, name: 'Ada', agent: 'codex', layout: { x: before.layout.x, y: before.layout.y } });
  const job = after.jobs.find((j) => j.id === res.job.id);
  expect(job).toMatchObject({ kind: 'handoff', fromId: ada.id, toId: next });
  await page.screenshot({ path: path.join(SHOTS, 'switch-agent-after.png') });

  // Same CLI again is refused
  await expect(server.api('POST', `/api/consoles/${next}/switch-agent`, { agent: 'codex' })).rejects.toThrow('already runs Codex CLI');
});

test('Settings › Agents & accounts: limit fallback and the masked xAI key on the Grok card', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+,');
  await page.getByTestId('settings-nav-agents').click();
  await expect(page.getByTestId('providers-hub')).toBeVisible();

  // Fallback: Ask by default; the fake Codex is installed but not logged in, so it says it will wait
  const fallback = page.getByTestId('limit-fallback');
  await expect(fallback.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true');
  await expect(fallback.getByTestId('limit-fallback-readiness')).toHaveAttribute('data-ready', 'false');
  await expect(fallback.getByTestId('limit-fallback-readiness')).toContainText('Codex CLI is not logged in');
  await fallback.getByRole('radio', { name: 'Continue on Codex' }).click();
  await waitFor(async () => (await server.api<{ settings: { limitFallback: string } }>('GET', '/api/settings')).settings.limitFallback === 'switch', {
    message: 'limitFallback saved',
  });

  // xAI key: saved, shown as set ••••last4 only, never returned in full, removable
  const grok = page.locator('[data-testid="provider-card"][data-provider="grok"]');
  await expect(grok.getByTestId('provider-billing')).toHaveText('Subscription or API key');
  const key = grok.getByTestId('provider-key');
  await expect(key).toContainText('API key — pay per token at xAI');
  await key.getByLabel('xAI API key').fill('xai-test0123456789WXYZ');
  await key.getByRole('button', { name: 'Save' }).click();
  await expect(key.getByTestId('provider-key-status')).toHaveText('set ••••WXYZ');
  const view = await server.api<Record<string, unknown>>('GET', '/api/settings');
  expect(JSON.stringify(view)).not.toContain('xai-test0123456789');
  expect(view.providerKeys).toEqual({ grok: { set: true, hint: 'WXYZ' } });
  await grok.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'switch-agent-settings.png') });
  await key.getByTestId('provider-key-clear').click();
  await expect(key).toHaveAttribute('data-set', 'false');
  await server.api('PATCH', '/api/settings', { limitFallback: 'ask' });
});
