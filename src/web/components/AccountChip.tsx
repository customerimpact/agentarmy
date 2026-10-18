import { UserRound } from 'lucide-react';
import type { ConsoleInfo } from '../../shared/protocol';
import { accountFor, formatReset, newAgentAccount, peakUtilization, useAccountList, useAccounts } from '../lib/accounts';
import { useBoard } from '../lib/store';

// Sidebar header: which account new agents get (Auto resolves to the first available one) and how
// much of its plan limit is used. Click opens Settings › Accounts.
export function AccountSwitcherChip() {
  const state = useAccounts((s) => s.state);
  const account = newAgentAccount(state);
  if (!state || !account) return null;
  const auto = state.newAgentAccount === 'auto';
  const pct = peakUtilization(account);
  const tone =
    account.status === 'limited' ? 'text-error' : account.status === 'needs_login' ? 'text-needs' : pct !== undefined && pct >= 80 ? 'text-needs' : 'text-fg-muted';
  const title = [
    `New agents: ${auto ? `Auto → ${account.name}` : account.name}`,
    account.email,
    account.utilization?.fiveHour !== undefined ? `5-hour limit ${Math.round(account.utilization.fiveHour)}% used` : '',
    account.utilization?.sevenDay !== undefined ? `Weekly limit ${Math.round(account.utilization.sevenDay)}% used` : '',
    account.status === 'limited' && account.limitResetsAt ? `Limited until ${formatReset(account.limitResetsAt)}` : '',
    'Click to manage accounts',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button
      type="button"
      data-testid="account-chip"
      title={title}
      onClick={() => useBoard.getState().openSettings('accounts')}
      className="flex h-7 max-w-[112px] min-w-0 items-center gap-1 rounded-full border border-line px-2 text-[11.5px] font-medium hover:border-line-strong hover:bg-hover"
    >
      <UserRound size={12} className={`shrink-0 ${tone}`} />
      <span className="truncate text-fg">{account.name}</span>
      {pct !== undefined && <span className={`shrink-0 tabular-nums ${tone}`}>{Math.round(pct)}%</span>}
    </button>
  );
}

// Console header: the account this agent runs on, when there is more than one
export function ConsoleAccountChip({ console: c }: { console: ConsoleInfo }) {
  const accounts = useAccountList();
  if (accounts.length < 2) return null;
  const account = accountFor(accounts, c);
  if (!account) return null;
  const limited = account.status === 'limited';
  return (
    <span
      data-testid="console-account"
      data-account-id={account.id}
      title={`Account: ${account.name}${account.email ? ` (${account.email})` : ''}${limited && account.limitResetsAt ? ` · limited until ${formatReset(account.limitResetsAt)}` : ''}`}
      className={`inline-flex h-[18px] max-w-[90px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium
                  ${limited ? 'bg-error/12 text-error' : 'bg-hover text-fg-muted'}`}
    >
      <UserRound size={10} className="shrink-0" />
      <span className="truncate">{account.name}</span>
    </span>
  );
}
