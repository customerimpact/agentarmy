import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { AccountsState, BoardState, ConsoleInfo } from '../../src/shared/protocol';
import { consoleNode, expectTerminalToContain } from './helpers/board';
import { AgentArmyServer, makeTempHome, waitFor } from './helpers/server';

const SHOTS = process.env.AGENTARMY_SHOTS_DIR;

// Two Claude Code accounts: the default (~/.claude of the temp home) and one added in the UI and
// "logged in" through the Login console (the fake CLI stores an account on /login, like Claude Code).
// The default account is limited (fake-limited marker), so "limit" there prints the real banner
// and fires StopFailure; the console must move to the other account with --resume.
test('a console that hits its limit moves to the other account and resumes', async ({ page }) => {
  test.setTimeout(120_000);
  const home = makeTempHome('accounts');
  const project = path.join(home, 'delta-project');
  fs.mkdirSync(project);
  const defaultDir = path.join(home, '.claude');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example', organizationType: 'claude_max' } }));
  fs.writeFileSync(path.join(defaultDir, 'fake-limited'), '');
  const server = await AgentArmyServer.start({ home, env: { FAKE_CLAUDE_REAL_TRANSCRIPTS: '1', FAKE_CLAUDE_DELAY_MS: '400' } });
  try {
    await server.api('PATCH', '/api/accounts/default', { name: 'Work' });
    await page.goto(server.url);

    // Add an account and log in to it from Settings › Accounts
    await page.getByTestId('account-chip').click();
    await page.getByTestId('account-add-name').fill('Personal');
    await page.getByTestId('account-add').click();
    const card = page.locator('[data-testid="account-card"]', { hasText: 'Personal' });
    await expect(card.getByTestId('account-status')).toHaveAttribute('data-status', 'needs_login');
    await card.getByTestId('account-login').click();
    const loginConsole = await waitFor(async () => {
      const state = await server.api<BoardState>('GET', '/api/state');
      return state.consoles.find((c) => c.role === 'Login') ?? null;
    });
    expect(loginConsole.name).toBe('Login · Personal');
    // /login is typed for the user; once the account is stored the Login console closes
    await waitFor(async () => (await server.api<AccountsState>('GET', '/api/accounts')).accounts.find((a) => a.name === 'Personal')?.status === 'ok', {
      timeout: 20_000,
      message: 'Personal logged in',
    });
    await waitFor(async () => !(await server.api<BoardState>('GET', '/api/state')).consoles.some((c) => c.id === loginConsole.id), {
      message: 'Login console closed',
    });
    const accounts = await server.api<AccountsState>('GET', '/api/accounts');
    const personal = accounts.accounts.find((a) => a.name === 'Personal')!;
    expect(personal.email).toMatch(/@example\.com$/);

    // Open the board again (the login flew to its console) and launch an agent on Work
    await page.keyboard.press('Escape');
    const created = await server.api<ConsoleInfo>('POST', '/api/consoles', { cwd: project, accountId: 'default' });
    expect(created.accountId).toBe('default');
    await waitFor(async () => (await server.api<BoardState>('GET', '/api/state')).consoles.find((c) => c.id === created.id)?.status === 'idle');
    await expect(consoleNode(page, created.id).getByTestId('console-account')).toHaveText('Work');

    await server.api('POST', `/api/consoles/${created.id}/send`, { text: 'limit' });
    await expect(page.getByText(/switched from Work to Personal/).first()).toBeVisible({ timeout: 20_000 });

    const moved = await waitFor(
      async () => {
        const c = (await server.api<BoardState>('GET', '/api/state')).consoles.find((x) => x.id === created.id);
        return c?.accountId === personal.id && c.status === 'resting' ? c : null;
      },
      { timeout: 30_000, message: 'console resumed on Personal and finished the re-sent prompt' },
    );
    // Same conversation, resumed in the other config dir, prompt sent again
    expect(moved.sessionId).toBe(created.sessionId);
    await expectTerminalToContain(page, created.id, `resumed ${created.sessionId}`);
    await expectTerminalToContain(page, created.id, `config-dir ${personal.configDir}`);
    await expectTerminalToContain(page, created.id, 'Done: limit');
    expect(fs.existsSync(path.join(personal.configDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${created.sessionId}.jsonl`))).toBe(true);
    await expect(consoleNode(page, created.id).getByTestId('console-account')).toHaveText('Personal');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'accounts-board.png') });

    const after = await server.api<AccountsState>('GET', '/api/accounts');
    const work = after.accounts.find((a) => a.id === 'default')!;
    expect(work.status).toBe('limited');
    expect(work.limitResetsAt).toBeGreaterThan(Date.now());

    // The Accounts page shows both, Work limited until 11pm
    await page.getByTestId('account-chip').click();
    const workCard = page.locator('[data-testid="account-card"][data-account-id="default"]');
    await expect(workCard.getByTestId('account-status')).toHaveText(/Limited until/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'accounts-settings.png') });
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
