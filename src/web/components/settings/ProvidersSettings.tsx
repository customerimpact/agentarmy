import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, LogIn, Plus, RefreshCw, UserRound } from 'lucide-react';
import { PATH_OVERRIDE_AGENTS, type AgentKind } from '../../../shared/agents';
import type { ProviderAccountStatus, ProviderStatus } from '../../../shared/providers';
import { accountsApi } from '../../lib/accounts';
import { installProvider, loginProvider, providersApi, useProviderHub } from '../../lib/providers-hub';
import { useServerSettings } from '../../lib/settings';
import { useBoard } from '../../lib/store';
import { useAgents } from '../../lib/agents';
import { AgentIcon } from '../AgentIcon';
import { AccountsBelow } from './AccountsSettings';
import { LimitFallbackSetting, ProviderKeyField } from './FallbackSettings';
import { Note, SmallButton, TextSave } from './fields';

// Settings › Agents & accounts: one card per agent CLI (Claude Code, Codex, Gemini CLI, OpenCode,
// Grok). Installed? Logged in? Its accounts, a path override and "use as default agent".
// Install and Log in open a terminal on the board; nothing is typed for the user.

const toast = (message: string) => useBoard.getState().toast(message);

async function run<T>(what: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const result = await fn();
    if (ok) toast(ok);
    return result;
  } catch (e) {
    toast(`${what} failed: ${(e as Error).message}`);
    return undefined;
  }
}

function StatusLine({ ok, okText, badText, testId, children }: { ok: boolean; okText: string; badText: string; testId: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 text-[12.5px]" data-testid={testId} data-ok={String(ok)}>
      {ok ? (
        <CheckCircle2 size={14} className="shrink-0 text-resting" aria-hidden />
      ) : (
        <AlertTriangle size={14} className="shrink-0 text-needs" aria-hidden />
      )}
      <span className={`min-w-0 truncate ${ok ? 'text-fg' : 'text-fg-muted'}`}>{ok ? okText : badText}</span>
      <span className="ml-auto" />
      {children}
    </div>
  );
}

function AccountRow({ provider, account }: { provider: ProviderStatus; account: ProviderAccountStatus }) {
  const [renaming, setRenaming] = useState(false);
  const remove = () =>
    useBoard.getState().askConfirm({
      title: `Remove ${account.name}?`,
      message: `AgentArmy forgets this ${provider.label} account and deletes its config folder, including its login.`,
      confirmLabel: 'Remove account',
      danger: true,
      onConfirm: async () => {
        await run('Remove', () => accountsApi.remove(account.id), `${account.name} removed`);
        void useProviderHub.getState().load(true);
      },
    });
  return (
    <li data-testid="provider-account" data-account-id={account.id} data-logged-in={String(account.loggedIn)} className="rounded-lg border border-line bg-canvas/40 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <UserRound size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-[12.5px] font-medium text-fg">{account.name}</span>
        {account.isDefault && <span className="aa-label rounded-md bg-hover px-1.5 py-[1px] text-fg-muted">CLI default</span>}
        <span
          className={`aa-label inline-flex h-5 items-center rounded-full px-2 ${account.loggedIn ? 'bg-resting/15 text-resting ring-1 ring-resting/35' : 'bg-needs/15 text-needs ring-1 ring-needs/40'}`}
        >
          {account.loggedIn ? 'Logged in' : 'Not logged in'}
        </span>
        <span className="ml-auto" />
        {provider.installed && (
          <SmallButton testId="provider-account-login" tone={account.loggedIn ? 'default' : 'primary'} onClick={() => void loginProvider(provider, account.id)}>
            <LogIn size={12} />
            {account.loginConsoleId ? 'Open login terminal' : account.loggedIn ? 'Log in again' : 'Log in'}
          </SmallButton>
        )}
        {!account.isDefault && (
          <>
            <SmallButton onClick={() => setRenaming((v) => !v)}>{renaming ? 'Cancel' : 'Rename'}</SmallButton>
            <SmallButton tone="danger" testId="provider-account-remove" onClick={remove}>
              Remove
            </SmallButton>
          </>
        )}
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={account.configDir}>
        {provider.accountEnvVar && !account.isDefault ? `${provider.accountEnvVar}=` : ''}
        {account.configDir}
      </div>
      {renaming && (
        <div className="mt-2">
          <TextSave
            label={`Name of ${account.name}`}
            value={account.name}
            mono={false}
            onSave={async (name) => {
              if (await run('Rename', () => accountsApi.rename(account.id, name))) {
                setRenaming(false);
                void useProviderHub.getState().load(true);
              }
            }}
          />
        </div>
      )}
    </li>
  );
}

function AddProviderAccount({ provider }: { provider: ProviderStatus }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    const created = await run('Add account', () => providersApi.addAccount(provider.id, clean), `${clean} added. Log in to use it.`);
    setBusy(false);
    if (created) {
      setName('');
      void useProviderHub.getState().load(true);
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        data-testid="provider-add-account-name"
        aria-label={`New ${provider.label} account name`}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add();
        }}
        placeholder="Name, e.g. Work"
        className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1 text-[12.5px] text-fg outline-none
                   placeholder:text-fg-subtle
                   focus:border-accent"
      />
      <SmallButton testId="provider-add-account" disabled={!name.trim() || busy} onClick={() => void add()}>
        <Plus size={12} />
        Add account
      </SmallButton>
    </div>
  );
}

function PathOverride({ provider }: { provider: ProviderStatus }) {
  const settings = useServerSettings((s) => s.data?.settings);
  const agent = provider.agent;
  if (!settings || !agent) return null;
  const isClaude = agent === 'claude';
  const overridable = isClaude || (PATH_OVERRIDE_AGENTS as AgentKind[]).includes(agent);
  if (!overridable) return null;
  const paths = settings.agentPaths ?? {};
  const value = isClaude ? settings.claudePath : (paths[agent as (typeof PATH_OVERRIDE_AGENTS)[number]] ?? '');
  const save = async (v: string) => {
    const patch = isClaude ? { claudePath: v } : { agentPaths: { ...paths, [agent]: v } };
    await run('Saving', () => useServerSettings.getState().patch(patch), v ? `${provider.label} path saved` : `${provider.label} path cleared, using PATH`);
    await Promise.all([useProviderHub.getState().load(true), useAgents.getState().load(true)]);
  };
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer text-[11.5px] text-fg-subtle select-none hover:text-fg">Executable path{value ? ' (custom)' : ''}</summary>
      <div className="mt-1.5">
        <TextSave label={`${provider.label} path`} value={value} placeholder={`Auto-detect (${agent} on PATH)`} onSave={save} />
      </div>
    </details>
  );
}

function DefaultRadio({ provider }: { provider: ProviderStatus }) {
  const current = useServerSettings((s) => s.data?.settings.defaultAgent);
  const agent = provider.agent;
  if (!agent || current === undefined) return null;
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-fg-muted">
      <input
        type="radio"
        name="default-agent"
        data-testid="provider-default"
        checked={current === agent}
        onChange={() =>
          void run('Saving', () => useServerSettings.getState().patch({ defaultAgent: agent }), `New agents default to ${provider.label}`)
        }
        className="accent-[var(--color-accent)]"
      />
      Default agent
    </label>
  );
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  const p = provider;
  const installing = !!p.installConsoleId;
  const defaultAccount = p.accounts.find((a) => a.isDefault);
  return (
    <li
      data-testid="provider-card"
      data-provider={p.id}
      data-installed={String(p.installed)}
      data-logged-in={String(p.loggedIn)}
      id={`provider-${p.id}`}
      className="rounded-xl border border-line bg-surface p-3.5"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent" aria-hidden>
          <AgentIcon agent={p.agent ?? undefined} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-semibold text-fg">{p.label}</span>
            <span className="text-[12px] text-fg-subtle">{p.vendor}</span>
            <span data-testid="provider-billing" className="aa-label rounded-md bg-hover px-1.5 py-[1px] text-fg-muted">
              {p.billing}
            </span>
            <span className="ml-auto" />
            <DefaultRadio provider={p} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px]">
            <a href={p.signupUrl} target="_blank" rel="noreferrer" data-testid="provider-signup" className="inline-flex items-center gap-1 text-accent hover:underline">
              Sign up <ExternalLink size={11} aria-hidden />
            </a>
            <a href={p.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-subtle hover:text-fg hover:underline">
              Docs <ExternalLink size={11} aria-hidden />
            </a>
          </div>
        </div>
      </div>

      <div className="mt-2.5 divide-y divide-line rounded-lg border border-line bg-canvas/40 px-2.5">
        <StatusLine ok={p.installed} okText={`Installed${p.version ? ` · ${p.version}` : ''}`} badText="Not installed" testId="provider-installed">
          {!p.installed && p.installCommand && (
            <SmallButton
              testId="provider-install"
              tone="primary"
              onClick={() => (installing ? undefined : installProvider(p))}
            >
              <Download size={12} />
              {installing ? 'Installing…' : 'Install'}
            </SmallButton>
          )}
        </StatusLine>
        <StatusLine
          ok={p.loggedIn}
          okText={`Logged in${p.loginMethod ? ` · ${p.loginMethod}` : ''}`}
          badText={p.installed ? 'Not logged in' : 'Not logged in (install first)'}
          testId="provider-logged-in"
        >
          {p.installed && !p.loggedIn && defaultAccount && (
            <SmallButton testId="provider-login" tone="primary" onClick={() => void loginProvider(p, defaultAccount.id)}>
              <LogIn size={12} />
              {defaultAccount.loginConsoleId ? 'Open login terminal' : 'Log in'}
            </SmallButton>
          )}
        </StatusLine>
      </div>
      {!p.installed && p.installCommand && (
        <div className="mt-1.5 text-[11.5px] text-fg-subtle">
          Install runs <code className="font-mono text-fg-muted">{p.installCommand}</code>
          {p.installNote ? ` · ${p.installNote}` : ''}
        </div>
      )}
      {p.installed && p.path && <div className="mt-1.5 truncate font-mono text-[11px] text-fg-subtle" title={p.path}>{p.path}</div>}
      <div className="mt-1 text-[11.5px] text-fg-subtle">
        Log in with <code className="font-mono text-fg-muted">{p.loginCommand}</code>. {p.loginHint}
      </div>

      {p.id === 'claude' ? (
        <div className="mt-3">
          <div className="text-[12px] font-semibold text-fg">Accounts</div>
          <AccountsBelow />
          <LimitFallbackSetting />
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-semibold text-fg">Accounts</span>
            <span className="text-[11px] text-fg-subtle">Usage not available for {p.label}</span>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="provider-accounts">
            {p.accounts.map((a) => (
              <AccountRow key={a.id} provider={p} account={a} />
            ))}
          </ul>
          {p.multiAccount ? (
            <div className="mt-1.5">
              <AddProviderAccount provider={p} />
            </div>
          ) : (
            <div className="mt-1.5 text-[11.5px] text-fg-subtle">One account: {p.label} has no verified way to keep separate logins.</div>
          )}
        </div>
      )}
      {p.id === 'grok' && <ProviderKeyField id="grok" envVar="XAI_API_KEY" vendor="xAI" />}
      {p.notes && <div className="mt-2 text-[11.5px] text-fg-subtle">{p.notes}</div>}
      <PathOverride provider={p} />
    </li>
  );
}

export function ProvidersHubBelow() {
  const data = useProviderHub((s) => s.data);
  const loading = useProviderHub((s) => s.loading);
  const error = useProviderHub((s) => s.error);
  useEffect(() => {
    void useProviderHub.getState().load(true);
  }, []);
  // "Install" / "Log in" links elsewhere scroll here (provider-readiness.ts openProviderSettings)
  useEffect(() => {
    const scroll = (id: string | null) => {
      if (!id) return;
      window.setTimeout(() => document.getElementById(`provider-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
    };
    try {
      scroll(sessionStorage.getItem('agentarmy.settingsProvider'));
      sessionStorage.removeItem('agentarmy.settingsProvider');
    } catch {
      // convenience only
    }
    const onEvent = (e: Event) => scroll(String((e as CustomEvent).detail ?? ''));
    window.addEventListener('agentarmy:settings-provider', onEvent);
    return () => window.removeEventListener('agentarmy:settings-provider', onEvent);
  }, [data !== null]);
  return (
    <div className="mt-3 space-y-2" data-testid="providers-hub">
      <div className="flex items-center justify-end gap-2">
        {error && <span className="text-[11.5px] text-error">{error}</span>}
        <SmallButton testId="providers-refresh" onClick={() => void useProviderHub.getState().load(true)} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Check again
        </SmallButton>
      </div>
      {!data ? (
        <span className="text-[11.5px] text-fg-subtle">Checking agent CLIs…</span>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.providers.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </ul>
      )}
      <Note>
        Logins happen in a terminal on the board, in the CLI itself: AgentArmy never sees your passwords or keys. Extra accounts get
        their own config folder in AgentArmy’s data folder.
      </Note>
    </div>
  );
}
