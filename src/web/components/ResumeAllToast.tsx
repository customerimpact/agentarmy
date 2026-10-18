import { useState } from 'react';
import { LoaderCircle, Play } from 'lucide-react';
import { api } from '../lib/api';
import { useServerSettings } from '../lib/settings';
import { useBoard } from '../lib/store';

// Offered once per page load: relaunching restored sessions spends tokens, so it's the user's call
export function ResumeAllToast() {
  const suspendedCount = useBoard(
    (s) => Object.values(s.consoles).filter((c) => c.status === 'suspended').length,
  );
  // Settings > General > On startup: 'never' means don't offer it
  const never = useServerSettings((s) => s.data?.settings.startupResume === 'never');
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (dismissed || never || suspendedCount === 0) return null;

  const resumeAll = async () => {
    setBusy(true);
    try {
      await api.resumeAll();
      setDismissed(true);
    } catch (error) {
      useBoard.getState().toast(`Resume failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute top-14 left-1/2 z-20 -translate-x-1/2">
      <div
        role="alertdialog"
        aria-label="Resume conversations"
        data-testid="resume-all-toast"
        className="flex items-center gap-3 rounded-xl border border-line-strong bg-elevated py-2 pr-2 pl-3.5 shadow-2xl shadow-black/40"
      >
        <Play size={14} className="shrink-0 text-accent" />
        <span className="text-fg">
          Resume {suspendedCount} {suspendedCount === 1 ? 'conversation' : 'conversations'}?
        </span>
        <button
          type="button"
          data-testid="resume-all-no"
          onClick={() => setDismissed(true)}
          className="rounded-md px-2.5 py-1 font-medium text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="resume-all-yes"
          disabled={busy}
          onClick={() => void resumeAll()}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-semibold text-accent-fg disabled:opacity-60
                     hover:brightness-110"
        >
          {busy && <LoaderCircle size={12} className="animate-spin" />}
          Resume all
        </button>
      </div>
    </div>
  );
}
