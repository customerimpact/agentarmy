// Agents & logins hub: one provider per agent CLI vendor (src/server/agents/providers.ts).
// Shared by the server and the browser UI.
//
// GET  /api/providers[?fresh=1]                     -> ProvidersResponse (installed / version / logged in, cached 30 s)
// POST /api/providers/:id/install                   -> ConsoleInfo (an 'Install' console running the install command)
// POST /api/providers/:id/login { accountId? }      -> ConsoleInfo (a 'Login' console for that account)
// POST /api/providers/:id/accounts { name }         -> Account     (extra account with its own config dir)
// Rename / remove accounts: PATCH / DELETE /api/accounts/:id (any provider).
// Server message { type: 'provider-event' } tells the UI when an install or login finished.

import type { AgentKind } from './agents.js';

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'grok';
export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'gemini', 'opencode', 'grok'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

// The provider whose login an agent kind uses; custom commands have none
export function providerOfAgent(agent: AgentKind | string | undefined): ProviderId | null {
  const id = agent ?? 'claude';
  return isProviderId(id) ? id : null;
}

// Id of a provider's built-in account (the CLI's own config dir). Claude's stays 'default' (accounts.json v1).
export function defaultAccountId(provider: ProviderId): string {
  return provider === 'claude' ? 'default' : `${provider}-default`;
}

export interface ProviderAccountStatus {
  id: string;
  name: string;
  isDefault: boolean;
  configDir: string;
  loggedIn: boolean;
  status: 'ok' | 'needs_login' | 'limited'; // like Account.status
  email?: string; // Claude only
  plan?: string; // Claude only
  loginConsoleId?: string; // its open Login console
}

export interface ProviderStatus {
  id: ProviderId;
  label: string; // 'Codex CLI'
  vendor: string; // 'OpenAI'
  website: string;
  signupUrl: string;
  billing: string; // 'Subscription login', 'Subscription or API key', 'API key — pay per token'
  agent: AgentKind | null; // agent kind that runs it (null: no adapter yet)
  installCommand?: string; // for this server's OS
  installNote?: string;
  loginCommand: string; // shown to the user, e.g. 'codex login'
  loginHint: string; // what happens in the login terminal
  accountEnvVar: string | null; // env var that points the CLI at another config dir; null = one account only
  multiAccount: boolean;
  usageAvailable: boolean; // plan usage / limits shown (Claude only for now)
  installed: boolean;
  version?: string;
  path?: string;
  error?: string; // why it was not found
  loggedIn: boolean; // the default account (or any account) can run
  loginMethod?: string; // 'login file' | 'API key in environment' | ...
  accounts: ProviderAccountStatus[];
  installConsoleId?: string; // its open Install console
  supportsMcp?: boolean; // gets the agentarmy MCP tools (from detection)
  notes?: string;
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
  defaultAgent: AgentKind;
}

export type ProviderEvent =
  | { kind: 'installed'; provider: ProviderId; label: string }
  | { kind: 'install-failed'; provider: ProviderId; label: string; exitCode?: number }
  | { kind: 'logged-in'; provider: ProviderId; label: string; accountId: string; accountName: string };
