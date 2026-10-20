import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ConsoleInfo, ShareStatus } from '../../src/shared/protocol';
import { expectTerminalToContain } from './helpers/board';
import { GUEST_COOKIE, startFakeCloud, writeLinkedCloud, type FakeCloud } from './helpers/fake-cloud';
import { AgentArmyServer, makeTempHome, REPO_ROOT } from './helpers/server';

// Live sharing, phase 1: the owner creates a Viewer link; a signed-in guest opens it in a browser,
// sees the board and a live terminal, and sees the owner's pointer. Runs against a local stand-in
// for gridhive.dev and the relay (helpers/fake-cloud.ts) with the real viewer build (site/app).
// SHARE_SHOTS=<dir> saves screenshots of the owner and guest views
const SHOTS = process.env.SHARE_SHOTS;

test('a viewer follows a shared board live, with pointers', async ({ browser }) => {
  test.setTimeout(90_000);
  test.skip(!fs.existsSync(path.join(REPO_ROOT, 'site', 'app', 'viewer.html')), 'run npm run build:viewer first');
  const cloud: FakeCloud = await startFakeCloud();
  const home = makeTempHome('share');
  fs.mkdirSync(path.join(home, 'shop'));
  writeLinkedCloud(path.join(home, '.agentarmy'));
  const server = await AgentArmyServer.start({ home, env: { GRIDHIVE_CLOUD_URL: cloud.url } });
  try {
    const ada = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: path.join(home, 'shop'), name: 'Ada' });
    const owner = await browser.newPage();
    await owner.goto(server.url);
    await expectTerminalToContain(owner, ada.id, 'Fake Claude Code');

    // Owner: toolbar Share -> name -> Create link
    await owner.getByTestId('share-button').click();
    const dialog = owner.getByTestId('share-dialog');
    await dialog.getByTestId('share-title').fill('Shop');
    await dialog.getByTestId('share-create').click();
    const link = await dialog.getByTestId('share-links').locator('input').inputValue();
    if (SHOTS) await owner.screenshot({ path: path.join(SHOTS, 'dialog.png') });
    expect(link).toMatch(/\/s\/abcdefghijkl#k=/);
    await expect.poll(async () => (await server.api<ShareStatus>('GET', '/api/share')).shares[0].connected).toBe(true);

    const guestContext = await browser.newContext();
    await guestContext.addCookies([{ name: GUEST_COOKIE.split('=')[0], value: GUEST_COOKIE.split('=')[1], url: cloud.url }]);
    const guest = await guestContext.newPage();
    await guest.goto(link);
    const node = guest.getByTestId('viewer-console').filter({ hasText: 'Ada' });
    await expect(node).toBeVisible({ timeout: 20_000 });
    await expect(node).toContainText('Fake Claude Code', { timeout: 20_000 });
    // The key is gone from the address bar
    expect(new URL(guest.url()).hash).toBe('');

    await expect.poll(async () => (await server.api<ShareStatus>('GET', '/api/share')).shares[0].guests.map((g) => g.name)).toEqual(['Tim']);
    await expect(guest.getByTestId('viewer-peers')).toContainText('O');

    // The guest's pointer shows up on the owner's board with their name
    await dialog.press('Escape');
    await guest.mouse.move(400, 300);
    await guest.mouse.move(420, 320);
    await expect(owner.getByTestId('share-pointer')).toContainText('Tim');
    await expect(owner.getByTestId('share-presence')).toContainText('T');
    if (SHOTS) await owner.screenshot({ path: path.join(SHOTS, 'owner.png') });

    // The owner's pointer shows up on the guest's screen with their name
    await server.api('POST', '/api/share/cursor', { c: { x: ada.layout.x + 40, y: ada.layout.y + 40 } });
    await expect(guest.getByTestId('viewer-cursor')).toContainText('Owner');
    if (SHOTS) await guest.screenshot({ path: path.join(SHOTS, 'guest.png') });

    // Revoking ends the guest's session
    await server.api('DELETE', '/api/share/abcdefghijkl');
    await expect(guest.getByText('The owner stopped sharing')).toBeVisible();
    await guestContext.close();
  } finally {
    await server.stop();
    await cloud.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
