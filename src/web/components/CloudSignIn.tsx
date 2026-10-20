import { useEffect, useState } from 'react';
import { CircleCheck, ExternalLink, LoaderCircle, LogOut, Smartphone } from 'lucide-react';
import type { CloudStatus } from '../../shared/protocol';
import { cloudApi, promptSkipped, skipPrompt, useCloud } from '../lib/cloud';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';
import { SignInButtons } from './SignInButtons';

const toast = (message: string) => useBoard.getState().toast(message);

async function run(action: () => Promise<CloudStatus>): Promise<void> {
  try {
    useCloud.getState().receive(await action());
  } catch (e) {
    toast(`Sign-in failed: ${(e as Error).message}`);
  }
}

// The code, the "open again" link and a cancel button while the browser step is open
function PendingStep({ status }: { status: CloudStatus }) {
  if (!status.pending) return null;
  return (
    <div className="space-y-3 text-center" data-testid="cloud-pending">
      <p className="text-fg-muted">Your browser is open. Sign in there, then check that the code matches and click Link this computer:</p>
      <p className="font-mono text-[26px] font-semibold tracking-[0.15em] text-fg" data-testid="cloud-code">
        {status.pending.userCode}
      </p>
      <div className="flex items-center justify-center gap-3 text-[12.5px]">
        <a href={status.pending.verifyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
          <ExternalLink size={12} /> Open the page again
        </a>
        <button type="button" onClick={() => void run(cloudApi.cancel)} className="text-fg-muted hover:text-fg">
          Cancel
        </button>
      </div>
      <p className="inline-flex items-center gap-1.5 text-[12px] text-fg-subtle">
        <LoaderCircle size={12} className="animate-spin" /> Waiting for gridhive.dev…
      </p>
    </div>
  );
}

// First start: ask to link this computer to a free account; "Skip for now" never blocks the app
export function CloudSignInPrompt() {
  const status = useCloud((s) => s.status);
  const [dismissed, setDismissed] = useState(promptSkipped);
  const [justLinked, setJustLinked] = useState(false);
  const [wasPending, setWasPending] = useState(false);

  useEffect(() => {
    if (status?.pending) setWasPending(true);
    if (status?.linked && wasPending) {
      setJustLinked(true);
      const timer = window.setTimeout(() => setDismissed(true), 1800);
      return () => window.clearTimeout(timer);
    }
  }, [status?.pending, status?.linked]);

  if (!status || status.promptDisabled || dismissed) return null;
  if (status.linked && !justLinked) return null;

  const skip = () => {
    skipPrompt();
    if (status.pending) void run(cloudApi.cancel);
    setDismissed(true);
  };

  return (
    <Modal title="Sign in to GridHive" onClose={skip} width="max-w-md" testId="cloud-prompt">
      <div className="space-y-5 p-6">
        <div className="text-center">
          <img src="/icon.svg" alt="" className="mx-auto mb-3 size-12" />
          <h2 className="text-[18px] font-semibold text-fg">{justLinked ? 'You are signed in' : 'Sign in to GridHive'}</h2>
          {!justLinked && (
            <p className="mt-1.5 text-fg-muted">
              Link this computer to your free account. Then you can follow and answer your agents from your phone anywhere. Your agents and code stay on this computer.
            </p>
          )}
        </div>

        {justLinked && status.user ? (
          <p className="flex items-center justify-center gap-2 text-fg" data-testid="cloud-linked">
            <CircleCheck size={16} className="text-resting" /> {status.user.email}
          </p>
        ) : status.pending ? (
          <PendingStep status={status} />
        ) : (
          <div className="space-y-2">
            <SignInButtons />
            {status.error && <p className="text-center text-[12.5px] text-error">{status.error}</p>}
          </div>
        )}

        {!justLinked && (
          <div className="flex items-center justify-between border-t border-line pt-4 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 text-fg-subtle">
              <Smartphone size={13} /> Free. No credit card.
            </span>
            <button type="button" data-testid="cloud-skip" onClick={skip} className="font-medium text-fg-muted hover:text-fg">
              Skip for now
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// Settings > General: who this computer is linked to
export function CloudAccountBelow() {
  const status = useCloud((s) => s.status);
  useEffect(() => {
    void useCloud.getState().load();
  }, []);
  if (!status) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
  if (status.pending) return <PendingStep status={status} />;
  if (status.linked && status.user) {
    return (
      <div className="flex items-center gap-3" data-testid="cloud-account">
        <span className="inline-flex items-center gap-1.5 text-fg">
          <CircleCheck size={14} className="text-resting" /> {status.user.email}
        </span>
        <button
          type="button"
          onClick={() => void run(cloudApi.unlink)}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:text-fg"
        >
          <LogOut size={12} /> Sign out on this computer
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <SignInButtons compact />
      {status.error && <p className="text-[12px] text-error">{status.error}</p>}
    </div>
  );
}
