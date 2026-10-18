import { useEffect, useState } from 'react';
import { Globe, LoaderCircle } from 'lucide-react';
import type { PreviewOffer } from '../../shared/protocol';
import { api } from '../lib/api';
import { usePreviewOffers } from '../lib/previews';
import { useBoard } from '../lib/store';

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function Offer({ offer }: { offer: PreviewOffer }) {
  const [busy, setBusy] = useState(false);
  const remove = usePreviewOffers((s) => s.remove);
  const act = async (open: boolean) => {
    setBusy(true);
    try {
      if (open) await api.acceptPreviewOffer(offer.id);
      else await api.dismissPreviewOffer(offer.id);
    } catch (e) {
      if (open) useBoard.getState().toast(`Could not open the preview: ${(e as Error).message}`);
    } finally {
      remove(offer.id);
    }
  };
  return (
    <div
      role="alertdialog"
      aria-label="Open preview"
      data-testid="preview-offer"
      className="pointer-events-auto flex items-center gap-3 rounded-xl border border-line-strong bg-elevated py-2 pr-2 pl-3.5 shadow-2xl shadow-black/40"
    >
      <Globe size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 text-fg">
        <span className="font-semibold">{offer.consoleName}</span> started{' '}
        <span className="font-mono text-[12px] text-fg-muted">{shortUrl(offer.url)}</span>
        <span className="text-fg-subtle"> — Open preview?</span>
      </span>
      <button
        type="button"
        data-testid="preview-offer-no"
        disabled={busy}
        onClick={() => void act(false)}
        className="shrink-0 rounded-md px-2.5 py-1 font-medium text-fg-muted
                   hover:bg-hover hover:text-fg"
      >
        Not now
      </button>
      <button
        type="button"
        data-testid="preview-offer-yes"
        disabled={busy}
        onClick={() => void act(true)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-semibold text-accent-fg disabled:opacity-60
                   hover:brightness-110"
      >
        {busy && <LoaderCircle size={12} className="animate-spin" />}
        Open
      </button>
    </div>
  );
}

// Stacked under the toolbar, like the "Resume all?" prompt
export function PreviewOfferToasts() {
  const offers = usePreviewOffers((s) => s.offers);
  useEffect(() => {
    void usePreviewOffers.getState().load();
  }, []);
  if (!offers.length) return null;
  return (
    <div className="pointer-events-none absolute top-28 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
      {offers.slice(-3).map((o) => (
        <Offer key={o.id} offer={o} />
      ))}
    </div>
  );
}
