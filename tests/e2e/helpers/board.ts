import { expect, type Locator, type Page } from '@playwright/test';

export function consoleNode(page: Page, id: string): Locator {
  return page.locator(`[data-testid="console-node"][data-console-id="${id}"]`);
}

// xterm's DOM renderer pads with non-breaking spaces; normalize so plain substrings match
export async function terminalText(page: Page, id: string): Promise<string> {
  const rows = consoleNode(page, id).locator('.xterm-rows');
  const text = (await rows.textContent({ timeout: 2000 }).catch(() => '')) ?? '';
  return text.replace(/ /g, ' ');
}

export async function expectTerminalToContain(page: Page, id: string, needle: string, timeout = 15_000) {
  await expect
    .poll(() => terminalText(page, id), { timeout, message: `terminal ${id} should show "${needle}"` })
    .toContain(needle);
}

// Focus the xterm textarea directly: nodes may overlap, so a click could land on another console
export async function typeInTerminal(page: Page, id: string, text: string): Promise<void> {
  await consoleNode(page, id).locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press('Enter');
}

// Click the console in the mission list: the board flies to it so its header buttons are on screen
export async function flyToConsole(page: Page, id: string): Promise<void> {
  await page.locator(`[data-testid="mission-item"][data-console-id="${id}"]`).click();
  await expect(consoleNode(page, id).getByTestId('console-close')).toBeInViewport({ ratio: 1 });
  await page.waitForTimeout(500); // fitView animation is 450ms
}

export async function expectStatus(page: Page, id: string, status: string, timeout = 15_000) {
  await expect(consoleNode(page, id)).toHaveAttribute('data-status', status, { timeout });
}
