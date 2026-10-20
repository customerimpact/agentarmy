import fs from 'node:fs';
import os from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppSettings, ConsoleInfo, ServerMessage } from '../shared/protocol.js';
import { PROVIDER_KEY_IDS, type ProviderKeyId } from '../shared/protocol.js';
import {
  defaultAccountId,
  isProviderId,
  PROVIDER_IDS,
  type ProviderEvent,
  type ProviderId,
  type ProviderStatus,
  type ProvidersResponse,
} from '../shared/providers.js';
import { AccountError, AccountNotFound } from './accounts.js';
import type { AccountService } from './account-routes.js';
import { detectAgents } from './agents/index.js';
import { agentForProvider, detectLogin, installCommandFor, installRunFor, loginFiles, PROVIDERS } from './agents/providers.js';
import type { ConsoleManager } from './consoles.js';
import { providerKey } from './settings.js';

// Agents & accounts hub (src/shared/providers.ts): status of every agent CLI, one-click Install and
// Log in consoles, and extra accounts for the CLIs that support a separate config dir.
//
// Install: a custom-command console (role 'Install', name 'Install · Codex') runs the install command
// in the home folder. Exit 0 refreshes detection, broadcasts a provider-event and closes the console.
// Log in: Claude accounts use the existing flow (account-routes.ts). The other CLIs get a 'Login'
// console running their login command (codex login, opencode auth login, or the CLI itself for Gemini)
// with the account's env var (CODEX_HOME, ...). The user finishes the login in that terminal; we never
// type or read credentials. Success = a login file appears or changes (polled), or the command exits 0.

export interface ProviderRouteOptions {
  manager: ConsoleManager;
  broadcast: (msg: ServerMessage) => void;
  accounts: AccountService;
  settings: () => AppSettings;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  closeDelayMs?: number;
  platform?: NodeJS.Platform;
}

const CACHE_MS = 30_000;
const POLL_MS = 1500;
const CLOSE_DELAY_MS = 1500;
const INSTALL_CLOSE_DELAY_MS = 4000;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof AccountNotFound || err instanceof ProviderNotFound ? 404 : 400).send({ error: message });
}

class ProviderNotFound extends Error {}

function requireProvider(id: string): ProviderId {
  if (!isProviderId(id)) throw new ProviderNotFound(`Unknown provider ${id}`);
  return id;
}

// Newest mtime of the files that mean "logged in" (0 = none exists)
export function loginStamp(provider: ProviderId, dir: string): number {
  let newest = 0;
  for (const file of loginFiles(provider, dir)) {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
    } catch {
      // not there
    }
  }
  return newest;
}

// A login finished when a login file appeared or was rewritten since the console opened
export function loginSucceeded(before: number, now: number): boolean {
  return now > 0 && now > before;
}

// The CLI as it appears on PATH (or the path override), quoted for the user's shell
function quoted(file: string): string {
  return /[\s&()^]/.test(file) ? `"${file}"` : file;
}

interface PendingLogin {
  provider: ProviderId;
  accountId: string;
  consoleId: string;
  stamp: number;
}

export function registerProviderRoutes(app: FastifyInstance, options: ProviderRouteOptions): void {
  const { manager, broadcast, accounts } = options;
  const { store } = accounts;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const installs = new Map<ProviderId, string>(); // provider -> Install console id
  const logins = new Map<string, PendingLogin>(); // console id -> pending login (non-Claude)
  let cache: { at: number; result: Promise<ProvidersResponse> } | null = null;

  const emit = (event: ProviderEvent): void => broadcast({ type: 'provider-event', event });
  const invalidate = (): void => {
    cache = null;
  };

  const savedKey = (id: ProviderId): boolean =>
    (PROVIDER_KEY_IDS as string[]).includes(id) && !!providerKey(options.settings(), id as ProviderKeyId);

  const build = async (fresh: boolean): Promise<ProvidersResponse> => {
    const settings = options.settings();
    const detected = await detectAgents(settings, { fresh });
    const loginConsoles = store.state().loginConsoles;
    const providers = PROVIDER_IDS.map((id): ProviderStatus => {
      const def = PROVIDERS[id];
      const agent = agentForProvider(id);
      const found = agent ? detected.agents.find((a) => a.id === agent) : undefined;
      const list = store.list(id);
      const accountsOut = list.map((a) => {
        const loggedIn =
          id === 'claude' ? a.status !== 'needs_login' : a.status === 'ok' || (a.isDefault && savedKey(id));
        return {
          id: a.id,
          name: a.name,
          isDefault: a.isDefault,
          configDir: a.configDir,
          loggedIn,
          ...(a.email ? { email: a.email } : {}),
          ...(a.plan ? { plan: a.plan } : {}),
          status: loggedIn && a.status === 'needs_login' ? ('ok' as const) : a.status,
          ...(loginConsoles[a.id] && manager.get(loginConsoles[a.id]) ? { loginConsoleId: loginConsoles[a.id] } : {}),
        };
      });
      const def0 = list.find((a) => a.isDefault);
      const method =
        id === 'claude'
          ? accountsOut.some((a) => a.loggedIn)
            ? 'Claude login'
            : undefined
          : detectLogin(id, def0?.configDir ?? '', { env, savedKey: savedKey(id) }).method;
      const installConsoleId = installs.get(id);
      const install = installCommandFor(def, platform);
      return {
        id,
        label: def.label,
        vendor: def.vendor,
        website: def.website,
        signupUrl: def.signupUrl,
        billing: def.billing,
        agent,
        ...(install ? { installCommand: install } : {}),
        ...(def.install.note ? { installNote: def.install.note } : {}),
        loginCommand: def.loginCommand,
        loginHint: def.loginHint,
        accountEnvVar: def.accountEnvVar,
        multiAccount: !!def.accountEnvVar,
        usageAvailable: def.usageAvailable,
        installed: found?.installed ?? false,
        ...(found?.version ? { version: found.version } : {}),
        ...(found?.path ? { path: found.path } : {}),
        ...(found?.error ? { error: found.error } : !agent ? { error: 'No adapter for this CLI yet' } : {}),
        loggedIn: accountsOut.some((a) => a.loggedIn),
        ...(method ? { loginMethod: method } : {}),
        accounts: accountsOut,
        ...(installConsoleId && manager.get(installConsoleId) ? { installConsoleId } : {}),
        ...(def.notes || found?.notes ? { notes: [def.notes, found?.notes].filter(Boolean).join(' ') } : {}),
        ...(found ? { supportsMcp: found.supportsMcp } : {}),
      };
    });
    return { providers, defaultAgent: settings.defaultAgent };
  };

  const status = (fresh = false): Promise<ProvidersResponse> => {
    const now = Date.now();
    if (!fresh && cache && now - cache.at < CACHE_MS) return cache.result;
    const result = build(fresh);
    cache = { at: now, result };
    result.catch(() => invalidate());
    return result;
  };

  // ---------- install ----------

  const openInstall = (id: ProviderId): ConsoleInfo => {
    const existing = installs.get(id);
    const open = existing ? manager.get(existing) : undefined;
    if (open && open.status !== 'exited') return open;
    if (open) manager.remove(open.id);
    // AGENTARMY_INSTALL_<ID> replaces the command (end-to-end tests, private npm mirrors)
    const command = env[`AGENTARMY_INSTALL_${id.toUpperCase()}`]?.trim() || installRunFor(PROVIDERS[id], platform);
    if (!command) throw new AccountError(`No install command for ${PROVIDERS[id].label} on this OS`);
    const short = PROVIDERS[id].label.replace(/ (CLI|Code|Build)$/, '');
    const info = manager.create({ cwd: os.homedir(), name: `Install · ${short}`, agent: 'custom', command });
    info.role = 'Install';
    manager.touch(info.id);
    installs.set(id, info.id);
    invalidate();
    return info;
  };

  // ---------- login (non-Claude) ----------

  const openLogin = async (id: ProviderId, accountId: string | undefined): Promise<ConsoleInfo> => {
    const account = store.require(accountId ?? defaultAccountId(id));
    if ((account.provider ?? 'claude') !== id) throw new AccountError(`${account.name} is not a ${PROVIDERS[id].label} account`);
    if (id === 'claude') return accounts.openLogin(account.id);
    const existing = store.loginConsoles.get(account.id);
    const open = existing ? manager.get(existing) : undefined;
    if (open) return open;
    const def = PROVIDERS[id];
    const agent = agentForProvider(id);
    const found = agent ? (await detectAgents(options.settings())).agents.find((a) => a.id === agent) : undefined;
    if (!found?.installed || !found.path) throw new AccountError(`${def.label} is not installed`);
    const command = [quoted(found.path), ...(def.loginArgs ?? [])].join(' ');
    const label = account.isDefault ? def.label.replace(/ (CLI|Code|Build)$/, '') : `${def.label.replace(/ (CLI|Code|Build)$/, '')} ${account.name}`;
    const info = manager.create({
      cwd: os.homedir(),
      name: `Login · ${label}`,
      agent: 'custom',
      command,
      // The account's env var (CODEX_HOME, ...) comes from manager.accountEnv; the default changes nothing
      ...(account.isDefault ? {} : { accountId: account.id }),
    });
    info.role = 'Login';
    manager.touch(info.id);
    store.loginConsoles.set(account.id, info.id);
    logins.set(info.id, { provider: id, accountId: account.id, consoleId: info.id, stamp: loginStamp(id, account.configDir) });
    store.changed();
    invalidate();
    return info;
  };

  const finishLogin = (pending: PendingLogin, ok: boolean): void => {
    logins.delete(pending.consoleId);
    store.loginConsoles.delete(pending.accountId);
    invalidate();
    store.changed();
    const account = store.get(pending.accountId);
    if (ok && account) {
      emit({ kind: 'logged-in', provider: pending.provider, label: PROVIDERS[pending.provider].label, accountId: account.id, accountName: account.name });
    }
    const t = setTimeout(() => {
      if (manager.get(pending.consoleId)) manager.remove(pending.consoleId);
    }, options.closeDelayMs ?? CLOSE_DELAY_MS);
    t.unref?.();
  };

  const checkLogins = (): void => {
    for (const pending of [...logins.values()]) {
      const info = manager.get(pending.consoleId);
      if (!info) {
        logins.delete(pending.consoleId);
        if (store.loginConsoles.get(pending.accountId) === pending.consoleId) store.loginConsoles.delete(pending.accountId);
        store.changed();
        continue;
      }
      const account = store.get(pending.accountId);
      if (!account) continue;
      if (loginSucceeded(pending.stamp, loginStamp(pending.provider, account.configDir))) finishLogin(pending, true);
    }
  };

  manager.on('console', (info) => {
    if (info.status !== 'exited') return;
    const pending = logins.get(info.id);
    if (pending) {
      // `codex login` / `opencode auth login` exit 0 once the credentials are stored
      if (info.exitCode === 0) finishLogin(pending, true);
      return;
    }
    for (const [provider, consoleId] of installs) {
      if (consoleId !== info.id) continue;
      installs.delete(provider);
      invalidate();
      const label = PROVIDERS[provider].label;
      if (info.exitCode === 0) {
        void detectAgents(options.settings(), { fresh: true }).finally(() => {
          invalidate();
          emit({ kind: 'installed', provider, label });
        });
        const t = setTimeout(() => {
          if (manager.get(info.id)?.status === 'exited') manager.remove(info.id);
        }, INSTALL_CLOSE_DELAY_MS);
        t.unref?.();
      } else {
        emit({ kind: 'install-failed', provider, label, ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}) });
      }
    }
  });
  manager.on('removed', (id) => {
    for (const [provider, consoleId] of installs) if (consoleId === id) installs.delete(provider);
    const pending = logins.get(id);
    if (pending) {
      logins.delete(id);
      invalidate();
    }
  });
  // Accounts added / removed / logged in elsewhere
  store.on('change', invalidate);

  const poll = setInterval(() => {
    if (logins.size) checkLogins();
  }, options.pollMs ?? POLL_MS);
  poll.unref?.();
  app.addHook('onClose', async () => clearInterval(poll));

  // ---------- routes ----------

  app.get('/api/providers', async (request) => {
    const { fresh } = request.query as { fresh?: string };
    if (fresh === '1') store.refresh();
    return status(fresh === '1');
  });

  app.post('/api/providers/:id/install', async (request, reply) => {
    try {
      return openInstall(requireProvider((request.params as { id: string }).id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/providers/:id/login', async (request, reply) => {
    try {
      const id = requireProvider((request.params as { id: string }).id);
      const body = (request.body ?? {}) as { accountId?: unknown };
      if (body.accountId !== undefined && typeof body.accountId !== 'string') throw new AccountError('accountId must be a string');
      return await openLogin(id, body.accountId as string | undefined);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/providers/:id/accounts', async (request, reply) => {
    try {
      const id = requireProvider((request.params as { id: string }).id);
      const body = (request.body ?? {}) as { name?: unknown };
      return store.create(body.name as string, id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
