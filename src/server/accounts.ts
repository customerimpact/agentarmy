import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  Account,
  AccountsPatch,
  AccountsState,
  AccountUtilization,
  AutoSwitchMode,
} from '../shared/protocol.js';

// Claude Code accounts. One account = one Claude Code config dir (CLAUDE_CONFIG_DIR).
//
// Layout verified against Claude Code 2.1.302 (2026-10-18; file names and keys only, no values):
// - config dir:   CLAUDE_CONFIG_DIR, else ~/.claude. Holds .credentials.json (Windows/Linux; macOS
//                 keeps the token in the keychain), settings.json and projects/<encoded cwd>/<session>.jsonl
// - global config: join(CLAUDE_CONFIG_DIR || homedir, '.claude.json'), so the default account's is
//                 ~/.claude.json (next to ~/.claude, not inside it) and an extra account's is
//                 <dir>/.claude.json. A legacy <config dir>/.config.json wins when it exists.
//                 Non-secret fields we read: oauthAccount.emailAddress, oauthAccount.organizationType
//                 ('claude_max', 'claude_pro', ...), cachedUsageUtilization.utilization.five_hour /
//                 .seven_day { utilization (percent), resets_at (ISO) } with fetchedAtMs.
// - encoded cwd:  every character that is not [A-Za-z0-9] becomes '-' (C:\dev\x -> C--dev-x).
// We never read token fields: .credentials.json is only checked for existence.
//
// The default account is the user's own config dir; we never write into it except the
// projects/ transcript copy that moves a conversation onto it during an account switch.

export const DEFAULT_ACCOUNT_ID = 'default';
const FILE_VERSION = 1;
const UNKNOWN_RESET_MS = 60 * 60 * 1000; // limited without a known reset time: try again after 1 h
const UTILIZATION_FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_NAME = 40;

export class AccountError extends Error {}

interface StoredAccount {
  id: string;
  name: string;
  configDir?: string; // extra accounts only; the default follows CLAUDE_CONFIG_DIR / ~/.claude
  limitedAt?: number;
  limitResetsAt?: number;
  limitLabel?: string;
  utilization?: AccountUtilization; // from limit banners in the terminal
  lastSeenAt: number;
  createdAt: number;
}

interface AccountsFile {
  version: number;
  accounts: StoredAccount[]; // priority order
  autoSwitch: AutoSwitchMode;
  newAgentAccount: string;
}

export interface AccountMeta {
  loggedIn: boolean;
  email?: string;
  plan?: string;
  utilization?: AccountUtilization; // from Claude Code's own cache
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined;
}

// ---------- paths ----------

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

// Where Claude Code keeps the global config (account metadata) for a config dir
export function globalConfigFiles(configDir: string, isDefault: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  const main = isDefault && !env.CLAUDE_CONFIG_DIR ? path.join(os.homedir(), '.claude.json') : path.join(configDir, '.claude.json');
  return [path.join(configDir, '.config.json'), main];
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptFile(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface CopyResult {
  copied: boolean; // true when the destination now holds the conversation
  source: string;
  dest: string;
  reason?: string;
}

// Copies a session transcript into another account so `claude --resume <id>` finds it there.
// sourceFile (from hook payloads) wins over the computed path; the destination keeps its folder name.
export function copyTranscript(opts: {
  fromDir: string;
  toDir: string;
  cwd: string;
  sessionId: string;
  sourceFile?: string;
}): CopyResult {
  const computed = transcriptFile(opts.fromDir, opts.cwd, opts.sessionId);
  const candidates = [opts.sourceFile, computed].filter(
    (f): f is string => !!f && f.endsWith(`${opts.sessionId}.jsonl`) && fs.existsSync(f),
  );
  const source = candidates[0] ?? computed;
  const folder =
    candidates[0] && isInside(candidates[0], path.join(opts.fromDir, 'projects'))
      ? path.basename(path.dirname(candidates[0]))
      : encodeProjectDir(opts.cwd);
  const dest = path.join(opts.toDir, 'projects', folder, `${opts.sessionId}.jsonl`);
  if (!candidates[0]) return { copied: false, source, dest, reason: 'No transcript found for this conversation' };
  try {
    const src = fs.statSync(source);
    // Switching back: the copy there may be older; the newer (longer) one is a superset
    if (fs.existsSync(dest) && fs.statSync(dest).size >= src.size) return { copied: true, source, dest };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(source, tmp);
    fs.renameSync(tmp, dest);
    return { copied: true, source, dest };
  } catch (err) {
    return { copied: false, source, dest, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- metadata ----------

const PLAN_NAMES: Record<string, string> = {
  claude_max: 'Max',
  claude_pro: 'Pro',
  claude_team: 'Team',
  claude_enterprise: 'Enterprise',
  claude_free: 'Free',
};

function planName(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return PLAN_NAMES[raw] ?? raw.replace(/^claude_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function windowUtil(raw: unknown): { pct?: number; resetsAt?: number } {
  const w = obj(raw);
  if (!w) return {};
  const pct = typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? w.utilization : undefined;
  const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
  return { pct, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined };
}

// Only these fields are ever taken from the file; nothing else is kept or logged
export function metaFromConfig(config: unknown): Omit<AccountMeta, 'loggedIn'> {
  const c = obj(config) ?? {};
  const account = obj(c.oauthAccount);
  const out: Omit<AccountMeta, 'loggedIn'> = {};
  if (account && typeof account.emailAddress === 'string' && account.emailAddress) out.email = account.emailAddress;
  const plan = planName(account?.organizationType);
  if (plan) out.plan = plan;
  const cache = obj(c.cachedUsageUtilization);
  const util = obj(cache?.utilization);
  if (util) {
    const five = windowUtil(util.five_hour);
    const seven = windowUtil(util.seven_day);
    const u: AccountUtilization = {};
    if (five.pct !== undefined) u.fiveHour = five.pct;
    if (five.resetsAt) u.fiveHourResetsAt = five.resetsAt;
    if (seven.pct !== undefined) u.sevenDay = seven.pct;
    if (seven.resetsAt) u.sevenDayResetsAt = seven.resetsAt;
    if (typeof cache?.fetchedAtMs === 'number') u.at = cache.fetchedAtMs;
    if (Object.keys(u).length) out.utilization = u;
  }
  return out;
}

const metaCache = new Map<string, { mtimeMs: number; size: number; meta: Omit<AccountMeta, 'loggedIn'> }>();

function readConfigMeta(file: string): Omit<AccountMeta, 'loggedIn'> | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = metaCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta;
  try {
    const meta = metaFromConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch {
    return cached?.meta ?? null; // mid-write; keep what we had
  }
}

export function readAccountMeta(configDir: string, isDefault: boolean, env: NodeJS.ProcessEnv = process.env): AccountMeta {
  const files = globalConfigFiles(configDir, isDefault, env);
  let meta: Omit<AccountMeta, 'loggedIn'> = {};
  for (const file of files) {
    const found = readConfigMeta(file);
    if (found && (found.email || !meta.email)) meta = { ...meta, ...found };
  }
  const hasCredentials = fs.existsSync(path.join(configDir, '.credentials.json'));
  return { ...meta, loggedIn: !!meta.email || hasCredentials };
}

// ---------- store ----------

export interface AccountStoreOptions {
  file: string | null; // accounts.json; null = in memory (tests)
  accountsDir: string; // extra accounts' config dirs live here
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  defaultDir?: string; // override for tests
}

export interface AccountStoreEvents {
  change: [AccountsState];
}

export class AccountStore extends EventEmitter<AccountStoreEvents> {
  private data: AccountsFile;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  readonly loginConsoles = new Map<string, string>(); // account id -> console id
  private lastJson = '';

  constructor(private readonly options: AccountStoreOptions) {
    super();
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.data = this.load();
    this.lastJson = JSON.stringify(this.state());
  }

  get autoSwitch(): AutoSwitchMode {
    return this.data.autoSwitch;
  }

  private defaultDir(): string {
    return this.options.defaultDir ?? defaultConfigDir(this.env);
  }

  configDirOf(stored: StoredAccount): string {
    if (stored.id === DEFAULT_ACCOUNT_ID) return this.defaultDir();
    return stored.configDir ?? path.join(this.options.accountsDir, stored.id);
  }

  private view(stored: StoredAccount): Account {
    const isDefault = stored.id === DEFAULT_ACCOUNT_ID;
    const configDir = this.configDirOf(stored);
    // A test override of the default dir keeps its metadata inside it, like an extra account
    const meta = readAccountMeta(configDir, isDefault && !this.options.defaultDir, this.env);
    const now = this.now();
    const account: Account = {
      id: stored.id,
      name: stored.name,
      configDir,
      isDefault,
      status: 'ok',
      lastSeenAt: stored.lastSeenAt,
    };
    if (meta.email) account.email = meta.email;
    if (meta.plan) account.plan = meta.plan;
    // Banner numbers are newer than Claude Code's cache when they were seen later
    const util = { ...meta.utilization };
    if (stored.utilization && (stored.utilization.at ?? 0) >= (meta.utilization?.at ?? 0)) Object.assign(util, stored.utilization);
    if (Object.keys(util).length) account.utilization = util;

    let limitedUntil: number | undefined;
    if (stored.limitedAt) {
      limitedUntil = stored.limitResetsAt ?? stored.limitedAt + UNKNOWN_RESET_MS;
      if (limitedUntil <= now) limitedUntil = undefined;
    }
    // Claude Code's own cache says a window is used up
    const fresh = (util.at ?? 0) >= now - UTILIZATION_FRESH_MS;
    if (!limitedUntil && fresh) {
      if ((util.fiveHour ?? 0) >= 100 && (util.fiveHourResetsAt ?? 0) > now) limitedUntil = util.fiveHourResetsAt;
      else if ((util.sevenDay ?? 0) >= 100 && (util.sevenDayResetsAt ?? 0) > now) limitedUntil = util.sevenDayResetsAt;
    }
    if (!meta.loggedIn) account.status = 'needs_login';
    else if (limitedUntil) {
      account.status = 'limited';
      account.limitResetsAt = limitedUntil;
      if (stored.limitLabel) account.limitLabel = stored.limitLabel;
    }
    return account;
  }

  list(): Account[] {
    return this.data.accounts.map((a) => this.view(a));
  }

  get(id: string | undefined): Account | undefined {
    const stored = this.data.accounts.find((a) => a.id === (id ?? DEFAULT_ACCOUNT_ID));
    return stored ? this.view(stored) : undefined;
  }

  require(id: string): Account {
    const account = this.get(id);
    if (!account) throw new AccountNotFound(`Unknown account ${id}`);
    return account;
  }

  state(): AccountsState {
    return {
      accounts: this.list(),
      autoSwitch: this.data.autoSwitch,
      newAgentAccount: this.data.newAgentAccount,
      loginConsoles: Object.fromEntries(this.loginConsoles),
    };
  }

  // Re-reads metadata, expires limits; emits 'change' only when something visible changed
  refresh(): boolean {
    const now = this.now();
    let dirty = false;
    for (const a of this.data.accounts) {
      if (a.limitedAt && (a.limitResetsAt ?? a.limitedAt + UNKNOWN_RESET_MS) <= now) {
        delete a.limitedAt;
        delete a.limitResetsAt;
        delete a.limitLabel;
        dirty = true;
      }
    }
    if (dirty) this.save();
    return this.changed();
  }

  // Emits when the public state differs from the last emitted one
  changed(): boolean {
    const state = this.state();
    const json = JSON.stringify(state);
    if (json === this.lastJson) return false;
    this.lastJson = json;
    this.emit('change', state);
    return true;
  }

  create(name: string): Account {
    const clean = cleanName(name);
    const id = crypto.randomBytes(4).toString('hex');
    const dir = path.join(this.options.accountsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const now = this.now();
    this.data.accounts.push({ id, name: clean, lastSeenAt: now, createdAt: now });
    this.save();
    this.changed();
    return this.require(id);
  }

  rename(id: string, name: string): Account {
    const stored = this.stored(id);
    stored.name = cleanName(name);
    this.save();
    this.changed();
    return this.require(id);
  }

  // Deletes the account and its config dir (never the default one)
  remove(id: string): void {
    if (id === DEFAULT_ACCOUNT_ID) throw new AccountError('The default account cannot be removed');
    const stored = this.stored(id);
    const dir = this.configDirOf(stored);
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.newAgentAccount === id) this.data.newAgentAccount = 'auto';
    this.loginConsoles.delete(id);
    this.save();
    // Only ever delete inside our own accounts folder
    if (isInside(dir, this.options.accountsDir)) fs.rmSync(dir, { recursive: true, force: true });
    this.changed();
  }

  patch(raw: unknown): AccountsState {
    const body = obj(raw);
    if (!body) throw new AccountError('Expected a JSON object');
    const patch = body as AccountsPatch;
    for (const key of Object.keys(body)) {
      if (!['order', 'autoSwitch', 'newAgentAccount'].includes(key)) throw new AccountError(`Unknown field: ${key}`);
    }
    if (patch.order !== undefined) {
      if (!Array.isArray(patch.order) || patch.order.some((id) => typeof id !== 'string')) {
        throw new AccountError('order must be a list of account ids');
      }
      const known = new Map(this.data.accounts.map((a) => [a.id, a]));
      const ordered = patch.order.flatMap((id) => {
        const a = known.get(id);
        if (!a) return [];
        known.delete(id);
        return [a];
      });
      this.data.accounts = [...ordered, ...known.values()];
    }
    if (patch.autoSwitch !== undefined) {
      if (!['on', 'ask', 'off'].includes(patch.autoSwitch)) throw new AccountError('autoSwitch must be on, ask or off');
      this.data.autoSwitch = patch.autoSwitch;
    }
    if (patch.newAgentAccount !== undefined) {
      const v = patch.newAgentAccount;
      if (v !== 'auto' && !this.data.accounts.some((a) => a.id === v)) throw new AccountError(`Unknown account ${String(v)}`);
      this.data.newAgentAccount = v;
    }
    this.save();
    this.changed();
    return this.state();
  }

  markLimited(id: string, limit: { resetsAt?: number; label?: string }): Account | undefined {
    const stored = this.data.accounts.find((a) => a.id === id);
    if (!stored) return undefined;
    const now = this.now();
    stored.limitedAt = now;
    if (limit.resetsAt && limit.resetsAt > now) stored.limitResetsAt = limit.resetsAt;
    else delete stored.limitResetsAt;
    if (limit.label) stored.limitLabel = limit.label;
    this.save();
    this.changed();
    return this.view(stored);
  }

  clearLimit(id: string): Account {
    const stored = this.stored(id);
    delete stored.limitedAt;
    delete stored.limitResetsAt;
    delete stored.limitLabel;
    // A cached "100%" would keep it limited; the next banner or Claude Code refresh sets it again
    if (stored.utilization) {
      delete stored.utilization;
    }
    this.save();
    this.changed();
    return this.require(id);
  }

  // Numbers seen in a warning banner ("You've used 95% of your weekly limit")
  setUtilization(id: string, window: 'session' | 'weekly', percent: number, resetsAt?: number): void {
    const stored = this.data.accounts.find((a) => a.id === id);
    if (!stored) return;
    const u: AccountUtilization = { ...stored.utilization, at: this.now() };
    if (window === 'session') {
      u.fiveHour = percent;
      if (resetsAt) u.fiveHourResetsAt = resetsAt;
    } else {
      u.sevenDay = percent;
      if (resetsAt) u.sevenDayResetsAt = resetsAt;
    }
    stored.utilization = u;
    this.save();
    this.changed();
  }

  touch(id: string | undefined): void {
    const stored = this.data.accounts.find((a) => a.id === (id ?? DEFAULT_ACCOUNT_ID));
    if (!stored) return;
    stored.lastSeenAt = this.now();
    this.save();
  }

  // Environment for a console on this account; the default account changes nothing
  envFor(id: string | undefined): Record<string, string> {
    if (!id || id === DEFAULT_ACCOUNT_ID) return {};
    const stored = this.data.accounts.find((a) => a.id === id);
    if (!stored) return {};
    return { CLAUDE_CONFIG_DIR: this.configDirOf(stored) };
  }

  // First account in priority order that is ok, except the excluded ones
  pickAvailable(exclude: string[] = []): Account | undefined {
    return this.list().find((a) => a.status === 'ok' && !exclude.includes(a.id));
  }

  // 'auto' / undefined -> the "new agents use" choice, else the highest-priority usable account
  resolveForNew(requested?: string): string {
    const want = requested && requested !== 'auto' ? requested : this.data.newAgentAccount;
    if (want && want !== 'auto') {
      if (!this.data.accounts.some((a) => a.id === want)) throw new AccountError(`Unknown account ${want}`);
      return want;
    }
    return this.pickAvailable()?.id ?? DEFAULT_ACCOUNT_ID;
  }

  // One projects/ folder per account, for usage totals per account
  transcriptRoots(): { accountId: string; dir: string }[] {
    return this.data.accounts.map((a) => ({ accountId: a.id, dir: path.join(this.configDirOf(a), 'projects') }));
  }

  private stored(id: string): StoredAccount {
    const stored = this.data.accounts.find((a) => a.id === id);
    if (!stored) throw new AccountNotFound(`Unknown account ${id}`);
    return stored;
  }

  private load(): AccountsFile {
    const now = this.now();
    const fresh: AccountsFile = {
      version: FILE_VERSION,
      accounts: [{ id: DEFAULT_ACCOUNT_ID, name: 'Default', lastSeenAt: now, createdAt: now }],
      autoSwitch: 'on',
      newAgentAccount: 'auto',
    };
    if (!this.options.file) return fresh;
    let parsed: Partial<AccountsFile>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.options.file, 'utf8')) as Partial<AccountsFile>;
    } catch {
      return fresh;
    }
    const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).filter(
      (a): a is StoredAccount => !!a && typeof a.id === 'string' && typeof a.name === 'string',
    );
    if (!accounts.some((a) => a.id === DEFAULT_ACCOUNT_ID)) accounts.unshift(fresh.accounts[0]);
    return {
      version: FILE_VERSION,
      accounts,
      autoSwitch: ['on', 'ask', 'off'].includes(parsed.autoSwitch as string) ? (parsed.autoSwitch as AutoSwitchMode) : 'on',
      newAgentAccount:
        typeof parsed.newAgentAccount === 'string' &&
        (parsed.newAgentAccount === 'auto' || accounts.some((a) => a.id === parsed.newAgentAccount))
          ? parsed.newAgentAccount
          : 'auto',
    };
  }

  private save(): void {
    const file = this.options.file;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmp, json);
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, json);
      fs.rmSync(tmp, { force: true });
    }
  }
}

export class AccountNotFound extends AccountError {}

function cleanName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!clean) throw new AccountError('name is required');
  if (clean.length > MAX_NAME) throw new AccountError(`name is longer than ${MAX_NAME} characters`);
  return clean;
}
