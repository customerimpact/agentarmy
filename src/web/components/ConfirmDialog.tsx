import { useState } from 'react';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';

export function ConfirmDialog() {
  const request = useBoard((s) => s.confirm);
  const [busy, setBusy] = useState(false);
  if (!request) return null;

  const close = () => useBoard.getState().askConfirm(null);
  const confirm = async () => {
    setBusy(true);
    try {
      await request.onConfirm();
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <Modal title={request.title} onClose={close}>
      <div className="p-5">
        <h2 className="text-[15px] font-semibold text-fg">{request.title}</h2>
        <p className="mt-2 leading-relaxed text-fg-muted">{request.message}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
        <button
          type="button"
          onClick={close}
          className="rounded-lg px-3 py-1.5 font-medium text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          data-autofocus
          data-testid="confirm-dialog-confirm"
          disabled={busy}
          onClick={() => void confirm()}
          className={`rounded-lg px-3 py-1.5 font-semibold disabled:opacity-60
                      hover:brightness-110
                      focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-elevated focus-visible:outline-none
                      ${request.danger ? 'bg-error text-white focus-visible:ring-error' : 'aa-btn-primary focus-visible:ring-accent'}`}
        >
          {request.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
