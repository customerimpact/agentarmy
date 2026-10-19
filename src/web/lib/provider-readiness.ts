import { AGENT_KINDS, AGENT_META, type AgentDetection, type AgentKind } from '../../shared/agents';
import type { AccountsState } from '../../shared/protocol';

// Which AI CLIs can run a console right now (pure helpers; the store is in provider-store.ts): installed, logged in, and their accounts.
// Source: GET /api/providers (installed / loggedIn / accounts per provider). Older servers without it
// fall back to GET /api/agents/detect (installed) + /api/accounts (Claude accounts).

export type ProviderKind = Exclude<AgentKind, 'custom'>;

export interface ProviderAccount {
  id: string;
  name: string;
  status?: string; // 'ok' | 'needs_login' | 'limited' ...
  email?: string;
}

export interface ProviderInfo {
  id: ProviderKind;
  label: string;
  installed: boolean | null; // null = not checked yet
  loggedIn: boolean | null; // null = unknown (the CLI has no way to tell, or not checked yet)
  accounts: ProviderAccount[];
  supportsMcp: boolean;
  version?: string;
}

export type Readiness = 'ready' | 'checking' | 'not_installed' | 'logged_out';

// Every CLI the app knows, minus custom commands (those need a command line)
export function providerKinds(): ProviderKind[] {
  return AGENT_KINDS.filter((k): k is ProviderKind => k !== 'custom');
}

export function providerLabel(kind: AgentKind): string {
  return AGENT_META[kind]?.label ?? kind;
}

export function providerShort(kind: AgentKind): string {
  return AGENT_META[kind]?.short ?? kind;
}

// Orchestrators coordinate the board with the agentarmy MCP tools; these CLIs are verified with them
export const ORCHESTRATOR_AGENTS: ProviderKind[] = ['claude', 'codex'];
export const isOrchestratorReady = (kind: AgentKind): boolean => (ORCHESTRATOR_AGENTS as AgentKind[]).includes(kind);

// Model presets per CLI. Free text is allowed too: these are only suggestions ('' = the CLI's default).
export const MODEL_PRESETS: Partial<Record<AgentKind, { value: string; label: string }[]>> = {
  claude: [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { value: 'gpt-5-codex', label: 'gpt-5-codex' },
    { value: 'gpt-5', label: 'gpt-5' },
    { value: 'gpt-5-mini', label: 'gpt-5-mini' },
  ],
  gemini: [
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  ],
  opencode: [
    { value: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' },
    { value: 'openai/gpt-5', label: 'openai/gpt-5' },
  ],
  grok: [
    { value: 'grok-4', label: 'grok-4' },
    { value: 'grok-code-fast-1', label: 'grok-code-fast-1' },
  ],
} as Partial<Record<AgentKind, { value: string; label: string }[]>>;

export function modelPresets(kind: AgentKind): { value: string; label: string }[] {
  return MODEL_PRESETS[kind] ?? [];
}

const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// Accepts { providers: [...] } or a bare array; tolerant to field names so the UI keeps working while
// the provider hub evolves. Unknown kinds are dropped.
export function normalizeProviders(raw: unknown): ProviderInfo[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { providers?: unknown }).providers : null;
  if (!Array.isArray(list)) return [];
  const known = new Set<string>(providerKinds());
  const out: ProviderInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const id = (p.id ?? p.kind ?? p.agent) as string;
    if (typeof id !== 'string' || !known.has(id)) continue;
    const auth = (p.auth && typeof p.auth === 'object' ? p.auth : {}) as Record<string, unknown>;
    const accounts = Array.isArray(p.accounts)
      ? (p.accounts as Record<string, unknown>[])
          .filter((a) => a && typeof a.id === 'string')
          .map((a) => ({
            id: a.id as string,
            name: (typeof a.name === 'string' && a.name) || (typeof a.label === 'string' && a.label) || (a.id as string),
            ...(typeof a.status === 'string'
              ? { status: a.status }
              : typeof a.loggedIn === 'boolean'
                ? { status: a.loggedIn ? 'ok' : 'needs_login' }
                : {}),
            ...(typeof a.email === 'string' ? { email: a.email } : {}),
          }))
      : [];
    const loggedInRaw = p.loggedIn ?? p.logged_in ?? auth.loggedIn;
    // An account list that is all needs_login reads as logged out
    const loggedIn =
      asBool(loggedInRaw) ?? (accounts.length ? accounts.some((a) => a.status !== 'needs_login') : null);
    out.push({
      id: id as ProviderKind,
      label: (typeof p.label === 'string' && p.label) || providerLabel(id as AgentKind),
      installed: asBool(p.installed),
      loggedIn,
      accounts,
      supportsMcp: typeof p.supportsMcp === 'boolean' ? p.supportsMcp : isOrchestratorReady(id as AgentKind),
      ...(typeof p.version === 'string' ? { version: p.version } : {}),
    });
  }
  return out;
}

// Fallback for servers without /api/providers
export function providersFromDetection(agents: AgentDetection[] | null, accounts: AccountsState | null): ProviderInfo[] {
  return providerKinds().map((id) => {
    const found = agents?.find((a) => a.id === id);
    const claudeAccounts =
      id === 'claude' && accounts ? accounts.accounts.map((a) => ({ id: a.id, name: a.name, status: a.status, ...(a.email ? { email: a.email } : {}) })) : [];
    return {
      id,
      label: providerLabel(id),
      installed: found ? found.installed : null,
      loggedIn: claudeAccounts.length ? claudeAccounts.some((a) => a.status !== 'needs_login') : null,
      accounts: claudeAccounts,
      supportsMcp: found?.supportsMcp ?? isOrchestratorReady(id),
      ...(found?.version ? { version: found.version } : {}),
    };
  });
}

export function readinessOf(p: ProviderInfo | undefined, kind?: AgentKind): Readiness {
  // Claude is assumed present until detection says otherwise (keeps the default flow instant)
  if (!p) return kind === 'claude' ? 'ready' : 'checking';
  if (p.installed === false) return 'not_installed';
  if (p.installed === null) return kind === 'claude' || p.id === 'claude' ? 'ready' : 'checking';
  if (p.loggedIn === false) return 'logged_out';
  return 'ready';
}

export const READINESS_TEXT: Record<Readiness, string> = {
  ready: 'Ready',
  checking: 'Checking…',
  not_installed: 'Not installed',
  logged_out: 'Not logged in',
};
