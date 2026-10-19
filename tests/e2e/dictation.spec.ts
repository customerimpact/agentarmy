import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { ConsoleInfo } from '../../src/shared/protocol';
import { TRANSFORMERS_URL } from '../../src/web/lib/dictation/whisper-protocol';
import { consoleNode, expectStatus } from './helpers/board';
import { AgentArmyServer, makeTempHome } from './helpers/server';

// Voice dictation with the on-device engine. Chromium's fake microphone supplies audio and the
// transformers.js CDN module is replaced by a stub, so no model is downloaded.
test.describe.configure({ mode: 'serial' });
test.use({
  launchOptions: {
    args: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

// Same shape as the real library: pipeline() reports download progress, then transcribes
const STUB = `
export const env = {};
export async function pipeline(task, model, options) {
  for (let i = 1; i <= 8; i++) {
    options.progress_callback?.({ status: 'progress', file: 'onnx/encoder_model.onnx', loaded: i * 5e6, total: 4e7 });
    await new Promise((r) => setTimeout(r, 120));
  }
  let calls = 0;
  return async (audio, opts) => {
    calls++;
    if (!(audio instanceof Float32Array) || audio.length === 0) throw new Error('no audio');
    return { text: calls === 1 ? ' fix the failing' : ' fix the failing tests and send it.' };
  };
}`;

let home: string;
let server: AgentArmyServer;
let context: BrowserContext;
let page: Page;
let agent: ConsoleInfo;

test.beforeAll(async ({ browser }) => {
  home = makeTempHome('dictation');
  const dir = path.join(home, 'proj');
  fs.mkdirSync(dir);
  server = await AgentArmyServer.start({
    home,
    ...(process.env.E2E_PORT ? { port: Number(process.env.E2E_PORT) } : {}),
    ...(process.env.E2E_AGENTARMY_HOME ? { env: { AGENTARMY_HOME: process.env.E2E_AGENTARMY_HOME } } : {}),
  });
  agent = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: dir, name: 'Ada' });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  // Never download transformers.js or a model in tests
  await context.route(`${TRANSFORMERS_URL}**`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB, headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://huggingface.co/**', (route) => route.abort());
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

test('hold Space in the empty command bar dictates on-device and "and send it" sends', async () => {
  await page.goto(server.url);
  await expectStatus(page, agent.id, 'idle');
  await consoleNode(page, agent.id).click({ position: { x: 100, y: 12 } }); // select it: the command bar targets it
  const input = page.getByTestId('command-bar-input');
  await input.focus();
  await expect(page.getByTestId('dictation-status')).toContainText('Hold');

  await page.keyboard.down(' ');
  await expect(page.getByTestId('dictation-status')).toHaveAttribute('data-phase', /starting|listening/);
  await expect(page.getByTestId('dictation-progress')).toBeVisible();
  await expect(page.getByTestId('dictation-status')).toHaveAttribute('data-phase', 'listening');
  if (process.env.E2E_SHOTS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'dictation-listening.png') });
  }
  // Interim text streams into the input while still holding Space
  await expect(input).toHaveValue('Fix the failing', { timeout: 10_000 });
  await page.keyboard.up(' ');
  await expect(page.getByTestId('command-bar-feedback')).toContainText('Sent to Ada');
  await expect(input).toHaveValue('');
});

test('Alt+V toggles dictation from anywhere; Esc cancels and keeps the draft', async () => {
  const input = page.getByTestId('command-bar-input');
  await input.fill('@Ada keep this');
  // Leave the input without clicking a fixed spot: console headers (e.g. the provider chip) may sit there
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Alt+v');
  await expect(page.getByTestId('dictation-status')).toHaveAttribute('data-phase', 'listening');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dictation-status')).toHaveCount(0);
  await expect(input).toHaveValue('@Ada keep this');
});
