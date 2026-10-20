import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { AgentArmyServer, makeTempHome } from './helpers/server';

// First start asks to link this computer to a gridhive.dev account; Skip never blocks the board.
// The site URL points at a closed port, so "Sign in" shows a readable error instead of a browser tab.
test('first start asks to sign in, Skip hides it for good, and sign-in errors are readable', async ({ page }) => {
  const home = makeTempHome('cloud');
  const server = await AgentArmyServer.start({ home, env: { AGENTARMY_NO_SIGNIN_PROMPT: '0' } });
  try {
    await page.goto(server.url);
    const prompt = page.getByTestId('cloud-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByTestId('cloud-signin')).toContainText('Continue with GitHub');
    await expect(prompt.getByTestId('cloud-signin-google')).toContainText('Continue with Google');
    if (process.env.CLOUD_SHOT) await page.screenshot({ path: process.env.CLOUD_SHOT });
    await prompt.getByTestId('cloud-signin').click();
    await expect(prompt).toContainText('Could not reach 127.0.0.1:9');
    await prompt.getByTestId('cloud-skip').click();
    await expect(prompt).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('command-bar-templates')).toBeVisible();
    await expect(page.getByTestId('cloud-prompt')).toHaveCount(0);
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
