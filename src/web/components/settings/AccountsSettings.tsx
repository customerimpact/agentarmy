import { useState } from 'react';
import { ArrowDown, ArrowUp, LogIn, Plus, UserRound } from 'lucide-react';
import type { Account, AutoSwitchMode } from '../../../shared/protocol';
import { formatTokens } from '../../../shared/usage';
import { accountsApi, formatReset, useAccountList, useAccounts } from '../../lib/accounts';
import { flyTo } from '../../lib/board-actions';
import { useBoard } from '../../lib/store';
import { useUsage } from '../../lib/usage';
import { Note, Segmented, Select, SmallButton, TextSave } from './fields';

// Settings › Accounts: one card per Claude Code account (config dir), how limits are handled,
// and which account new agents use. Logging in happens in a terminal on the board.

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

function Loading() {
  return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
}

const STATUS: Record<Account['status'], { label: string; pill: string }> = {
  ok: { label: 'Ready', pill: 'bg-resting/15 text-resting ring-1 ring-resting/35' },
  needs_login: { label: 'Needs login', pill: 'bg-needs/15 text-needs ring-1 ring-needs/40' },
  limited: { label: 'Limited', pill: 'bg-error/15 text-error ring-1 ring-error/40' },
};

export function AccountStatusPill({ account }: { account: Account }) {
  const s = STATUS[account.status];
  const label =
    account.status === 'limited' && account.limitResetsAt ? `Limited until ${formatReset(account.limitResetsAt)}` : s.label;
  return (
    <span
      data-testid="account-status"
      data-status={account.status}
      title={account.limitLabel ? `${account.limitLabel} reached` : undefined}
      className={`aa-label inline-flex h-5 shrink-0 items-center rounded-full px-2 ${s.pill}`}
    >
      {label}
    </span>
  );
}

function UsageBar({ label, value, resetsAt }: { label: string; value?: number; resetsAt?: number }) {
  const pct = value === undefined ? undefined : Math.max(0, Math.min(100, value));
  const tone = pct === undefined ? 'bg-line-strong' : pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-needs' : 'bg-resting';
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-medium text-fg-muted">{label}</span>
        <span className="text-fg-subtle tabular-nums">
          {pct === undefined ? '—' : `${Math.round(pct)}%`}
          {resetsAt && resetsAt > Date.now() ? ` · resets ${formatReset(resetsAt)}` : ''}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover" role="meter" aria-label={`${label} used`} aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

function AccountCard({ account, rank }: { account: Account; rank: number }) {
  const state = useAccounts((s) => s.state);
  const usage = useUsage((s) => s.live?.byAccount?.find((u) => u.accountId === account.id));
  const loginConsole = state?.loginConsoles[account.id];
  const [renaming, setRenaming] = useState(false);
  const isNewDefault = state?.newAgentAccount === account.id;
  const u = account.utilization;

  const login = async () => {
    const info = await run('Login', () => accountsApi.login(account.id));
    if (!info) return;
    useBoard.getState().upsertConsole(info);
    useBoard.getState().closeSettings?.();
    window.setTimeout(() => flyTo(info.id), 120);
    toast(`Finish the login for ${account.name} in the terminal "${info.name}"`);
  };

  const remove = () =>
    useBoard.getState().askConfirm({
      title: `Remove ${account.name}?`,
      message:
        'AgentArmy forgets this account and deletes its config folder, including its login and conversations. Agents on it move to the default account the next time they start.',
      confirmLabel: 'Remove account',
      danger: true,
      onConfirm: async () => {
        await run('Remove', () => accountsApi.remove(account.id), `${account.name} removed`);
      },
    });

  return (
    <li
      data-testid="account-card"
      data-account-id={account.id}
      className="rounded-xl border border-line bg-canvas/40 p-3"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent/12 text-[13px] font-semibold text-accent" aria-hidden>
          {account.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-fg" data-testid="account-name">
              {account.name}
            </span>
            <span className="text-[10.5px] text-fg-subtle tabular-nums" title="Priority for Auto">#{rank}</span>
            {account.isDefault && <span className="aa-label rounded-md bg-hover px-1.5 py-[1px] text-fg-muted">~/.claude</span>}
            {isNewDefault && <span className="aa-label rounded-md bg-accent/12 px-1.5 py-[1px] text-accent">New agents</span>}
            <span className="ml-auto" />
            <AccountStatusPill account={account} />
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-fg-subtle" title={account.configDir}>
            {account.email ?? (account.status === 'needs_login' ? 'Not logged in yet' : 'Logged in')}
            {account.plan ? ` · ${account.plan}` : ''}
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-3">
        <UsageBar label="5-hour" value={u?.fiveHour} resetsAt={u?.fiveHourResetsAt} />
        <UsageBar label="7-day" value={u?.sevenDay} resetsAt={u?.sevenDayResetsAt} />
      </div>
      <div className="mt-2 text-[11px] text-fg-subtle tabular-nums" data-testid="account-tokens">
        Tokens today {usage ? formatTokens(usage.today.weighted) : '—'} · 7 days {usage ? formatTokens(usage.last7d.weighted) : '—'}
      </div>

      {renaming && (
        <div className="mt-2">
          <TextSave
            label={`Name of ${account.name}`}
            value={account.name}
            onSave={async (name) => {
              if (await run('Rename', () => accountsApi.rename(account.id, name))) setRenaming(false);
            }}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {loginConsole ? (
          <SmallButton testId="account-login" onClick={() => flyTo(loginConsole)}>
            <LogIn size={12} />
            Open login terminal
          </SmallButton>
        ) : (
          <SmallButton testId="account-login" tone={account.status === 'needs_login' ? 'primary' : 'default'} onClick={() => void login()}>
            <LogIn size={12} />
            {account.status === 'needs_login' ? 'Log in' : 'Log in again'}
          </SmallButton>
        )}
        <SmallButton onClick={() => setRenaming((v) => !v)}>{renaming ? 'Cancel' : 'Rename'}</SmallButton>
        {!isNewDefault && (
          <SmallButton
            testId="account-make-default"
            onClick={() => void run('Saving', () => useAccounts.getState().patch({ newAgentAccount: account.id }), `New agents use ${account.name}`)}
          >
            Use for new agents
          </SmallButton>
        )}
        {account.status === 'limited' && (
          <SmallButton onClick={() => void run('Saving', () => accountsApi.clearLimit(account.id), `${account.name} marked available`)}>
            Mark available
          </SmallButton>
        )}
        {!account.isDefault && (
          <SmallButton tone="danger" testId="account-remove" onClick={remove}>
            Remove
          </SmallButton>
        )}
      </div>
    </li>
  );
}

function AddAccount() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    const created = await run('Add account', () => accountsApi.create(clean), `${clean} added. Log in to use it.`);
    setBusy(false);
    if (created) setName('');
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        data-testid="account-add-name"
        aria-label="New account name"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add();
        }}
        placeholder="Name, e.g. Work or Personal"
        className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 py-1 text-[12.5px] text-fg outline-none
                   placeholder:text-fg-subtle
                   focus:border-accent"
      />
      <SmallButton testId="account-add" tone="primary" disabled={!name.trim() || busy} onClick={() => void add()}>
        <Plus size={12} />
        Add account
      </SmallButton>
    </div>
  );
}

export function AccountsBelow() {
  const state = useAccounts((s) => s.state);
  if (!state) return <Loading />;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <ul className="flex flex-col gap-2" data-testid="account-list">
        {state.accounts.map((a, i) => (
          <AccountCard key={a.id} account={a} rank={i + 1} />
        ))}
      </ul>
      <AddAccount />
      {state.accounts.length === 1 && (
        <Note>
          Add a second Claude account (for example a work and a personal subscription). When one hits its limit, its
          agents can carry on with the other.
        </Note>
      )}
    </div>
  );
}

const SWITCH_OPTIONS: { value: AutoSwitchMode; label: string }[] = [
  { value: 'on', label: 'Switch' },
  { value: 'ask', label: 'Ask first' },
  { value: 'off', label: 'Off' },
];

export function AutoSwitchControl() {
  const mode = useAccounts((s) => s.state?.autoSwitch);
  if (!mode) return <Loading />;
  return (
    <Segmented
      label="When a limit is hit"
      value={mode}
      options={SWITCH_OPTIONS}
      onChange={(autoSwitch) => void run('Saving', () => useAccounts.getState().patch({ autoSwitch }))}
    />
  );
}

export function AutoSwitchBelow() {
  const mode = useAccounts((s) => s.state?.autoSwitch);
  if (mode !== 'on') return null;
  return (
    <Note>
      The agent's conversation is copied to the next account in the priority order below, it restarts there with
      --resume and its last prompt is sent again. Only agents that hit the limit move.
    </Note>
  );
}

export function PriorityBelow() {
  const accounts = useAccountList();
  if (!accounts.length) return <Loading />;
  const move = (index: number, delta: number) => {
    const order = accounts.map((a) => a.id);
    const [id] = order.splice(index, 1);
    order.splice(index + delta, 0, id);
    void run('Saving', () => useAccounts.getState().patch({ order }));
  };
  return (
    <ol className="mt-2 flex flex-col gap-1" data-testid="account-priority">
      {accounts.map((a, i) => (
        <li key={a.id} className="flex items-center gap-2 rounded-md border border-line bg-canvas/40 px-2 py-1">
          <span className="w-4 text-right text-[11px] text-fg-subtle tabular-nums">{i + 1}</span>
          <UserRound size={13} className="text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{a.name}</span>
          <AccountStatusPill account={a} />
          <button
            type="button"
            aria-label={`Move ${a.name} up`}
            disabled={i === 0}
            onClick={() => move(i, -1)}
            className="grid size-6 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-30"
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            aria-label={`Move ${a.name} down`}
            disabled={i === accounts.length - 1}
            onClick={() => move(i, 1)}
            className="grid size-6 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-30"
          >
            <ArrowDown size={13} />
          </button>
        </li>
      ))}
    </ol>
  );
}

export function NewAgentAccountControl() {
  const state = useAccounts((s) => s.state);
  if (!state) return <Loading />;
  return (
    <Select
      label="New agents use"
      value={state.newAgentAccount}
      options={[{ value: 'auto', label: 'Auto (first available)' }, ...state.accounts.map((a) => ({ value: a.id, label: a.name }))]}
      onChange={(newAgentAccount) => void run('Saving', () => useAccounts.getState().patch({ newAgentAccount }))}
    />
  );
}

// Account picker for New agent / templates; only shown when there is more than one account
export function AccountPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const accounts = useAccountList();
  if (accounts.length < 2) return null;
  return (
    <label className="mt-1.5 flex items-center gap-2 text-[11.5px] text-fg-muted">
      Account
      <select
        data-testid="account-picker"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line-strong bg-canvas px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-accent"
      >
        <option value="auto">Auto</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id} disabled={a.status === 'needs_login'}>
            {a.name}
            {a.status === 'limited' ? ' (limited)' : a.status === 'needs_login' ? ' (needs login)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
