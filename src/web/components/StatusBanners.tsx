import { WifiOff, X } from 'lucide-react';
import { useBoard } from '../lib/store';

export function ReconnectBanner() {
  const socketState = useBoard((s) => s.socketState);
  const everConnected = useBoard((s) => s.everConnected);
  if (socketState === 'open') return null;
  // The very first connect normally takes a few ms; don't flash a banner for it
  if (!everConnected && socketState === 'connecting') return null;

  return (
    <div className="absolute top-3 left-1/2 z-20 -translate-x-1/2">
      <div
        role="status"
        data-testid="reconnect-banner"
        className="flex items-center gap-2 rounded-full border border-needs/40 bg-elevated px-3.5 py-1.5 text-[12px] font-medium text-needs shadow-xl shadow-black/30"
      >
        <WifiOff size={13} />
        {everConnected
          ? 'Connection lost. Reconnecting…'
          : 'Cannot reach the GridHive server. Retrying…'}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useBoard((s) => s.toasts);
  if (!toasts.length) return null;

  return (
    <div className="absolute bottom-32 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="flex max-w-md items-center gap-3 rounded-lg border border-error/40 bg-elevated px-3.5 py-2 text-fg shadow-xl shadow-black/30"
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => useBoard.getState().dismissToast(t.id)}
            className="text-fg-subtle
                       hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
