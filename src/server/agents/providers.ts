import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAgentKind, type AgentKind } from '../../shared/agents.js';
import type { ProviderId } from '../../shared/providers.js';

// Provider registry for the Agents & accounts hub: where each CLI comes from, how to install it,
// how to log in, which env var gives it a separate config dir (one per account) and which file shows
// that it is logged in. Detection only checks that files EXIST (and a non-secret settings field for
// Gemini); credential values are never read.
//
// Verified 2026-10-19 (`npm view <pkg> name bin`, `codex --help`, strings in the shipped binaries/bundles):
// - npm packages: @anthropic-ai/claude-code (bin claude), @openai/codex (bin codex), @google/gemini-cli
//   (bin gemini), opencode-ai (bin opencode).
// - Claude Code: CLAUDE_CONFIG_DIR, <dir>/.credentials.json (see accounts.ts); login with /login inside claude.
// - Codex 0.142.5: CODEX_HOME (default ~/.codex) holds auth.json; `codex login` (browser OAuth or API key).
// - Gemini CLI 0.64.0: GEMINI_CLI_HOME replaces the home dir, so state lives in <GEMINI_CLI_HOME>/.gemini
//   (docs/cli/enterprise.md); OAuth tokens in .gemini/oauth_creds.json (unless
//   GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true); auth choice in .gemini/settings.json security.auth.selectedType.
//   There is no login subcommand: starting `gemini` asks how to authenticate.
// - OpenCode 1.19.3: auth.json in <XDG_DATA_HOME or ~/.local/share>/opencode/ (also on Windows);
//   `opencode auth login` (alias of `opencode providers login`). XDG_DATA_HOME also moves OpenCode's
//   sessions database, and other XDG-aware tools started inside that console see it too.
// Not verified: Grok Build (install lines from docs.x.ai via AGENT_META; login file unknown; one account).

export interface ProviderDef {
  id: ProviderId;
  label: string;
  vendor: string;
  website: string;
  signupUrl: string;
  billing: string;
  // Shown to the user; win32Run = the same through cmd.exe when the shown line is PowerShell
  install: { npm?: string; win32?: string; win32Run?: string; darwin?: string; linux?: string; note?: string };
  installVerified: boolean;
  loginCommand: string; // shown in the UI
  loginArgs: string[] | null; // CLI args of the login console; null = start the CLI itself (Claude, Gemini)
  loginHint: string;
  accountEnvVar: string | null; // separate config dir per account; null = one account only
  apiKeyEnv: string[]; // presence of any of these counts as logged in (values never read)
  usageAvailable: boolean;
  notes?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    website: 'https://www.anthropic.com/claude-code',
    signupUrl: 'https://claude.ai/login',
    billing: 'Subscription login',
    install: {
      npm: 'npm i -g @anthropic-ai/claude-code',
      note: 'Or use the native installer from code.claude.com/docs/en/setup.',
    },
    installVerified: true,
    loginCommand: '/login inside claude',
    loginArgs: null,
    loginHint: 'Claude Code opens; pick a theme if asked, then log in with your browser.',
    accountEnvVar: 'CLAUDE_CONFIG_DIR',
    apiKeyEnv: [], // API keys are withheld from Claude Code consoles on purpose (they bill API credits)
    usageAvailable: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    vendor: 'OpenAI',
    website: 'https://developers.openai.com/codex/cli',
    signupUrl: 'https://chatgpt.com/',
    billing: 'Subscription or API key',
    install: { npm: 'npm i -g @openai/codex' },
    installVerified: true,
    loginCommand: 'codex login',
    loginArgs: ['login'],
    loginHint: 'Codex opens a browser to sign in with ChatGPT; finish there.',
    accountEnvVar: 'CODEX_HOME',
    apiKeyEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    usageAvailable: false,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    vendor: 'Google',
    website: 'https://github.com/google-gemini/gemini-cli',
    signupUrl: 'https://aistudio.google.com/',
    billing: 'Google login (free tier) or API key',
    install: { npm: 'npm i -g @google/gemini-cli' },
    installVerified: true,
    loginCommand: 'gemini (asks how to sign in on first start)',
    loginArgs: null,
    loginHint: 'Gemini CLI starts and asks how to authenticate; choose "Login with Google". Close the terminal when it shows the prompt.',
    accountEnvVar: 'GEMINI_CLI_HOME',
    apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    usageAvailable: false,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'opencode (SST)',
    website: 'https://opencode.ai/',
    signupUrl: 'https://opencode.ai/auth',
    billing: 'API key per provider (or a provider subscription)',
    install: { npm: 'npm i -g opencode-ai' },
    installVerified: true,
    loginCommand: 'opencode auth login',
    loginArgs: ['auth', 'login'],
    loginHint: 'Pick a provider in the terminal and paste its key or finish its browser login.',
    accountEnvVar: 'XDG_DATA_HOME',
    apiKeyEnv: [],
    usageAvailable: false,
    notes: 'A separate account moves XDG_DATA_HOME for that console, so its OpenCode sessions are separate too.',
  },
  // xAI Grok Build (adapter: grok.ts). Install lines from AGENT_META (docs.x.ai); not run here.
  grok: {
    id: 'grok',
    label: 'Grok Build',
    vendor: 'xAI',
    website: 'https://docs.x.ai/build/overview',
    signupUrl: 'https://x.ai',
    billing: 'Subscription or API key',
    install: {
      win32: 'irm https://x.ai/cli/install.ps1 | iex',
      win32Run: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"',
      darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      linux: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    },
    installVerified: false,
    loginCommand: 'grok (browser sign-in on first start), or an xAI API key',
    loginArgs: null,
    loginHint: 'Grok Build opens a browser sign-in on first start (SuperGrok / X Premium+). Or save an xAI API key.',
    accountEnvVar: null, // GROK_HOME would also move sessions and skills; not verified, so one account
    apiKeyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    usageAvailable: false,
    notes: 'One account. Login file not verified: shows logged in only with an API key (environment or Settings).',
  },
};

export function providerDef(id: ProviderId): ProviderDef {
  return PROVIDERS[id];
}

// The agent kind that runs this provider, once an adapter exists for it
export function agentForProvider(id: ProviderId): AgentKind | null {
  return isAgentKind(id) ? id : null;
}

export function installCommandFor(def: ProviderDef, platform: NodeJS.Platform = process.platform): string | undefined {
  const own = platform === 'win32' ? def.install.win32 : platform === 'darwin' ? def.install.darwin : def.install.linux;
  return own ?? def.install.npm;
}

// What the Install console runs (custom command: cmd.exe /d /s /c on Windows, $SHELL -lc elsewhere)
export function installRunFor(def: ProviderDef, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32' && def.install.win32Run) return def.install.win32Run;
  return installCommandFor(def, platform);
}

// ---------- config dirs ----------

function envDir(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v && v.trim() ? path.resolve(v) : undefined;
}

// The directory that an account's env var points at, for the CLI's own (default) account
export function defaultProviderDir(id: ProviderId, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  switch (id) {
    case 'claude':
      return envDir(env, 'CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude');
    case 'codex':
      return envDir(env, 'CODEX_HOME') ?? path.join(home, '.codex');
    case 'gemini':
      return envDir(env, 'GEMINI_CLI_HOME') ?? home; // the CLI adds .gemini itself
    case 'opencode':
      return envDir(env, 'XDG_DATA_HOME') ?? path.join(home, '.local', 'share');
    case 'grok':
      return path.join(home, '.grok');
  }
}

// Env for a console on an extra account (dir = its own config dir); the default account changes nothing
export function accountEnvFor(id: ProviderId, dir: string): Record<string, string> {
  const key = PROVIDERS[id].accountEnvVar;
  return key ? { [key]: dir } : {};
}

// ---------- logged in (file presence only) ----------

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Bigger than an empty JSON object: OpenCode leaves "{}" behind after logging out of everything
function nonEmpty(file: string): boolean {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 2;
  } catch {
    return false;
  }
}

// Gemini CLI: only security.auth.selectedType is read from settings.json (no secrets live there)
function geminiAuthType(geminiDir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(geminiDir, 'settings.json'), 'utf8')) as {
      security?: { auth?: { selectedType?: unknown } };
      selectedAuthType?: unknown;
    };
    const t = parsed.security?.auth?.selectedType ?? parsed.selectedAuthType;
    return typeof t === 'string' ? t : undefined;
  } catch {
    return undefined;
  }
}

// The file whose appearance means "logged in" (for login consoles to poll)
export function loginFiles(id: ProviderId, dir: string): string[] {
  switch (id) {
    case 'claude':
      return [path.join(dir, '.credentials.json')];
    case 'codex':
      return [path.join(dir, 'auth.json')];
    case 'gemini':
      return [path.join(dir, '.gemini', 'oauth_creds.json')];
    case 'opencode':
      return [path.join(dir, 'opencode', 'auth.json')];
    case 'grok':
      return []; // not verified
  }
}

export interface LoginState {
  loggedIn: boolean;
  method?: string;
}

// Claude's own check (email in .claude.json, keychain on macOS) lives in accounts.ts; this one is the
// file-based fallback for every provider. env: the CLI's env, for API keys the console would inherit.
export function detectLogin(
  id: ProviderId,
  dir: string,
  options: { env?: NodeJS.ProcessEnv; savedKey?: boolean } = {},
): LoginState {
  const env = options.env ?? process.env;
  if (options.savedKey) return { loggedIn: true, method: 'API key in Settings' };
  const files = loginFiles(id, dir);
  if (id === 'opencode' ? files.some(nonEmpty) : files.some(exists)) return { loggedIn: true, method: 'login file' };
  if (id === 'gemini') {
    const type = geminiAuthType(path.join(dir, '.gemini'));
    if (type && type !== 'oauth-personal') return { loggedIn: true, method: `settings (${type})` };
  }
  // Every console of this CLI inherits the server's env, so a key there works for all its accounts
  const key = PROVIDERS[id].apiKeyEnv.find((k) => !!env[k]);
  if (key) return { loggedIn: true, method: `${key} in environment` };
  return { loggedIn: false };
}
