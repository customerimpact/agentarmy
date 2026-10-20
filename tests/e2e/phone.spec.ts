import fs from 'node:fs';
import path from 'node:path';
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { ConsoleInfo, PhonePairInfo, PhoneStatus } from '../../src/shared/protocol';
import { AgentArmyServer, freePort, makeTempHome } from './helpers/server';

// Phone on this Wi-Fi: pair with the QR link, follow an agent, answer its permission prompt from
// the phone, launch an agent from the phone, and pass a session between phone and computer.
// The phone server listens on 127.0.0.1 here (no firewall prompt, never 4318).
test.describe.configure({ mode: 'serial' });

let home: string;
let server: AgentArmyServer;
let board: Page;
let phoneContext: BrowserContext;
let phone: Page;
let phonePort: number;
let agent: ConsoleInfo;

// PHONE_SHOTS=<dir> saves screenshots of each step (for reviewing the phone UI)
const SHOTS = process.env.PHONE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const port = process.env.AA_E2E_PORT ? Number(process.env.AA_E2E_PORT) : undefined;

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('phone');
  fs.mkdirSync(path.join(home, 'shop'));
  phonePort = await freePort();
  server = await AgentArmyServer.start({
    home,
    port,
    env: { AGENTARMY_PHONE_PORT: String(phonePort), AGENTARMY_PHONE_HOST: '127.0.0.1' },
  });
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: path.join(home, 'shop'), name: 'Ada' });
  board = await browser.newPage();
  await board.goto(server.url);
  const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 13'];
  phoneContext = await browser.newContext(iphone);
  phone = await phoneContext.newPage();
});

test.afterAll(async () => {
  await phoneContext?.close();
  await board?.close();
  await server?.stop();
  try {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // temp dir
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
  }
});

test('a. an unpaired phone is asked to scan the QR code', async () => {
  const status = await server.api<PhoneStatus>('PUT', '/api/phone', { enabled: true });
  expect(status.listening).toBe(true);
  if (SHOTS) {
    await board.goto(`${server.origin}/?view=settings`);
    await board.getByRole('button', { name: /Integrations/ }).first().click();
    await board.getByTestId('phone-pair-start').click();
    await expect(board.getByTestId('phone-qr')).toBeVisible();
    await board.getByTestId('phone-access').scrollIntoViewIfNeeded();
    await shot(board, 'settings');
    await board.goto(server.url);
  }
  await phone.goto(`http://127.0.0.1:${phonePort}/`);
  await expect(phone.getByRole('heading', { name: 'Pair this phone' })).toBeVisible();
});

test('b. Settings shows a QR code; the link pairs the phone', async () => {
  const info = await server.api<PhonePairInfo>('POST', '/api/phone/pair');
  expect(info.qrSvg).toContain('<svg');
  const code = /#pair=(.+)$/.exec(info.url)![1];
  await phone.goto(`http://127.0.0.1:${phonePort}/#pair=${code}`);
  await expect(phone.getByTestId('phone-agent').filter({ hasText: 'Ada' })).toBeVisible();
  expect(new URL(phone.url()).hash).toBe('');
  await expect(phone.getByTestId('phone-connection')).toHaveAttribute('data-connected', 'true');
  await shot(phone, 'fleet');
  const status = await server.api<PhoneStatus>('GET', '/api/phone');
  expect(status.devices).toHaveLength(1);
  expect(status.devices[0].online).toBe(true);
});

test('c. follow an agent and answer its permission prompt from the phone', async () => {
  await phone.getByTestId('phone-agent').filter({ hasText: 'Ada' }).click();
  await expect(phone.getByTestId('phone-console-status')).toHaveText(/Ready|Idle|Resting/, { timeout: 20_000 });
  await phone.getByTestId('phone-message').fill('ask');
  await phone.getByTestId('phone-message').press('Enter');
  const action = phone.getByTestId('phone-action');
  await expect(action).toContainText('Ada', { timeout: 20_000 });
  await shot(phone, 'needs-you');
  await action.getByRole('button', { name: /^Yes$/ }).click();
  await expect(phone.getByTestId('phone-terminal')).toContainText('Permission granted', { timeout: 20_000 });
  await expect(action).toHaveCount(0);
});

test('d. "On computer" flies the board to that agent; "Continue on phone" opens it on the phone', async () => {
  await phone.getByTestId('phone-to-computer').click();
  await expect(board.getByText('Ada continued from your phone')).toBeVisible();

  await phone.getByRole('button', { name: 'Back' }).click();
  await expect(phone.getByTestId('phone-summary')).toBeVisible();
  const node = board.locator(`[data-testid="console-node"][data-console-id="${agent.id}"]`);
  await node.getByTestId('console-to-phone').click();
  await expect(phone.getByTestId('phone-terminal')).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Ada' })).toBeVisible();
});

test('e. launch an agent from the phone; it starts on the computer', async () => {
  await phone.getByRole('button', { name: 'Back' }).click();
  await phone.getByTestId('phone-launch-open').click();
  await phone.getByTestId('phone-launch-single').click();
  await phone.getByTestId('phone-launch-folder').first().click();
  await shot(phone, 'launch');
  await phone.getByTestId('phone-launch').click();
  await expect(phone.getByTestId('phone-agent')).toHaveCount(2);
  await expect(board.locator('[data-testid="console-node"]')).toHaveCount(2);
});

test('f. removing the phone on the computer locks it out', async () => {
  const status = await server.api<PhoneStatus>('GET', '/api/phone');
  await server.api('DELETE', `/api/phone/devices/${status.devices[0].id}`);
  await expect(phone.getByRole('heading', { name: 'Pair this phone' })).toBeVisible({ timeout: 15_000 });
});
