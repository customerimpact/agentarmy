import { useEffect } from 'react';
import { Download, LogIn } from 'lucide-react';
import type { AgentKind } from '../../shared/agents';
import { installProvider, loginProvider, useProviderHub, useProviderStatus } from '../lib/providers-hub';
import { useBoard } from '../lib/store';

// One-click Install / Log in for the CLI picked in the New agent dialog (Agents & accounts hub).
// The terminal opens on the board, so the dialog closes first.
export function ProviderQuickFix({ agent }: { agent: AgentKind }) {
  const p = useProviderStatus(agent);
  useEffect(() => {
    if (!useProviderHub.getState().data) void useProviderHub.getState().load();
  }, []);
  if (!p) return null;
  const closeDialog = () => useBoard.getState().setNewAgentOpen(false);
  if (!p.installed && p.installCommand) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-muted" data-testid="provider-quickfix" data-fix="install">
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-error" aria-hidden /> Not installed
        </span>
        <button
          type="button"
          data-testid="provider-quickfix-install"
          onClick={() => {
            closeDialog();
            installProvider(p);
          }}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-[12px] font-semibold text-accent-fg hover:brightness-110"
        >
          <Download size={12} /> Install {p.label}
        </button>
      </div>
    );
  }
  if (p.installed && !p.loggedIn) {
    const account = p.accounts.find((a) => a.isDefault);
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-muted" data-testid="provider-quickfix" data-fix="login">
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-project-green" aria-hidden /> Installed
          <span className="ml-1.5 size-1.5 rounded-full bg-needs" aria-hidden /> Not logged in
        </span>
        <button
          type="button"
          data-testid="provider-quickfix-login"
          onClick={() => {
            closeDialog();
            void loginProvider(p, account?.id);
          }}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-line-strong bg-elevated px-2.5 text-[12px] font-medium text-fg hover:bg-hover"
        >
          <LogIn size={12} /> Log in
        </button>
      </div>
    );
  }
  return null;
}
