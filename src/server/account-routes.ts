import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ConsoleInfo, ServerMessage } from '../shared/protocol.js';
import { AccountError, AccountNotFound, AccountStore, DEFAULT_ACCOUNT_ID } from './accounts.js';
import { AccountSwitcher } from './account-switch.js';
import type { ConsoleManager } from './consoles.js';
import { setTranscriptRoots } from './usage.js';

// Accounts REST routes, the launch hook that gives each console its CLAUDE_CONFIG_DIR, the login
// flow and the auto-switcher. See the Accounts section of src/shared/protocol.ts.
//
// Logging in: POST /api/accounts/:id/login opens a console named "Login · <account>" that runs
// claude on that account's config dir in the home folder. A fresh config dir starts with Claude
// Code's own onboarding (theme, then login); an onboarded but logged-out one gets "/login" typed in
// once its session starts. The user finishes the login in that terminal (browser OAuth); we never
// see or handle credentials. We poll the account metadata (and watch for "Login successful") and
// close the console once Claude Code has stored the login.

export interface AccountRouteOptions {
  manager: ConsoleManager;
  broadcast: (msg: ServerMessage) => void;
  dataDir: string | null; // AGENTARMY_HOME; null = in memory (unit tests)
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  defaultDir?: string; // tests: the default account's config dir
  refreshMs?: number;
  loginPollMs?: number;
}

const REFRESH_MS = 30_000;
const LOGIN_POLL_MS = 1500;
const LOGIN_CLOSE_DELAY_MS = 1500;
const LOGIN_TYPE_DELAY_MS = 1200;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof AccountNotFound ? 404 : 400).send({ error: message });
}

export interface AccountService {
  store: AccountStore;
  switcher: AccountSwitcher;
  openLogin(accountId: string): ConsoleInfo;
  checkLogins(): void;
}

export async function registerAccountRoutes(app: FastifyInstance, options: AccountRouteOptions): Promise<AccountService> {
  const { manager, broadcast } = options;
  const accountsDir = options.dataDir
    ? path.join(options.dataDir, 'accounts')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-accounts-'));
  const store = new AccountStore({
    file: options.dataDir ? path.join(options.dataDir, 'accounts.json') : null,
    accountsDir,
    env: options.env,
    now: options.now,
    defaultDir: options.defaultDir,
  });
  const switcher = new AccountSwitcher({ manager, store, broadcast, now: options.now });

  // Usage totals per account (the usage index scans every account's projects/ folder)
  const publishRoots = (): void => {
    if (options.dataDir) setTranscriptRoots(store.transcriptRoots());
  };
  publishRoots();
  store.on('change', (state) => {
    broadcast({ type: 'accounts', accounts: state });
    publishRoots();
  });

  // Every launch: 'auto' becomes a real account; the account's config dir goes into the env
  manager.accountEnv = (info) => {
    const multi = store.list().length > 1;
    if (info.accountId && info.accountId !== 'auto' && !store.get(info.accountId)) delete info.accountId; // removed account
    if (info.accountId === 'auto') {
      const picked = store.resolveForNew('auto');
      if (picked === DEFAULT_ACCOUNT_ID && !multi) delete info.accountId;
      else info.accountId = picked;
    }
    store.touch(info.accountId);
    return store.envFor(info.accountId);
  };

  // ---------- login consoles ----------

  const typedLogin = new Set<string>();

  const checkLogins = (): void => {
    let changed = false;
    for (const [accountId, consoleId] of [...store.loginConsoles]) {
      if (!manager.get(consoleId)) {
        store.loginConsoles.delete(accountId);
        changed = true;
        continue;
      }
      const account = store.get(accountId);
      if (account && account.status === 'needs_login') continue;
      store.loginConsoles.delete(accountId);
      changed = true;
      const t = setTimeout(() => {
        if (manager.get(consoleId)) manager.remove(consoleId);
      }, LOGIN_CLOSE_DELAY_MS);
      t.unref?.();
    }
    if (changed || store.loginConsoles.size) store.changed();
  };

  const openLogin = (accountId: string): ConsoleInfo => {
    const account = store.require(accountId);
    const existing = store.loginConsoles.get(accountId);
    const open = existing ? manager.get(existing) : undefined;
    if (open) return open;
    const info = manager.create({ cwd: os.homedir(), name: `Login · ${account.name}`, accountId });
    info.role = 'Login';
    manager.touch(info.id);
    store.loginConsoles.set(accountId, info.id);
    store.changed();
    return info;
  };

  manager.on('hook', (id, payload) => {
    if (payload.hook_event_name !== 'SessionStart' || typedLogin.has(id)) return;
    const accountId = [...store.loginConsoles].find(([, c]) => c === id)?.[0];
    if (!accountId) return;
    typedLogin.add(id);
    // Onboarded but logged out: start the login for the user (a fresh dir did it during onboarding)
    setTimeout(() => {
      if (store.get(accountId)?.status === 'needs_login' && manager.get(id)) manager.sendText(id, '/login');
    }, LOGIN_TYPE_DELAY_MS).unref?.();
  });
  manager.on('output', (id, data) => {
    if (!/Login\s*successful/i.test(data)) return;
    if (![...store.loginConsoles.values()].includes(id)) return;
    setTimeout(checkLogins, 300).unref?.();
  });
  manager.on('removed', (id) => {
    typedLogin.delete(id);
    for (const [accountId, consoleId] of store.loginConsoles) {
      if (consoleId === id) {
        store.loginConsoles.delete(accountId);
        store.changed();
      }
    }
  });

  const refresh = setInterval(() => store.refresh(), options.refreshMs ?? REFRESH_MS);
  refresh.unref?.();
  const loginPoll = setInterval(() => {
    if (store.loginConsoles.size) checkLogins();
  }, options.loginPollMs ?? LOGIN_POLL_MS);
  loginPoll.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(refresh);
    clearInterval(loginPoll);
    switcher.stop();
    if (manager.accountEnv) manager.accountEnv = null;
  });

  // ---------- routes ----------

  app.get('/api/accounts', async () => {
    store.refresh();
    return store.state();
  });

  app.post('/api/accounts', async (request, reply) => {
    try {
      return store.create((request.body as { name?: unknown } | undefined)?.name as string);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/accounts', async (request, reply) => {
    try {
      return store.patch(request.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const body = (request.body ?? {}) as { name?: unknown };
      if (body.name === undefined) return store.require(id);
      return store.rename(id, body.name as string);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const login = store.loginConsoles.get(id);
      store.remove(id);
      if (login && manager.get(login)) manager.remove(login);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/accounts/:id/login', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return openLogin(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/accounts/:id/clear-limit', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return store.clearLimit(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return { store, switcher, openLogin, checkLogins };
}

export { AccountError };
