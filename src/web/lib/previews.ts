import { create } from 'zustand';
import type { PreviewOffer } from '../../shared/protocol';
import { api } from './api';

// "Ada started http://localhost:5173 — Open preview?" offers (Settings > Browser tiles > Ask first)

interface PreviewOffersStore {
  offers: PreviewOffer[];
  add: (offer: PreviewOffer) => void;
  remove: (id: string) => void;
  load: () => Promise<void>;
}

export const usePreviewOffers = create<PreviewOffersStore>((set) => ({
  offers: [],
  add: (offer) => set((s) => ({ offers: [...s.offers.filter((o) => o.id !== offer.id), offer] })),
  remove: (id) => set((s) => ({ offers: s.offers.filter((o) => o.id !== id) })),
  load: async () => {
    try {
      set({ offers: await api.listPreviewOffers() });
    } catch {
      // offers are a convenience; the next one arrives over the socket
    }
  },
}));
