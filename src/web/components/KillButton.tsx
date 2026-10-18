import { Skull } from 'lucide-react';
import { askKill } from '../lib/board-actions';
import { useBoard } from '../lib/store';

// Number of selected consoles/browser tiles (the multi-selection, else the focused one)
export function useKillCount(): number {
  return useBoard((s) => {
    const ids = s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : [];
    return ids.filter((id) => s.consoles[id] || s.browsers[id]).length;
  });
}

// Red "Kill" / "Kill 3": stops and removes the selection after a confirm (also the Delete key)
export function KillButton({ compact = false }: { compact?: boolean }) {
  const count = useKillCount();
  if (!count) return null;
  return (
    <button
      type="button"
      data-testid="kill-button"
      onClick={askKill}
      title="Stop and remove the selection (Delete)"
      className={`inline-flex items-center gap-1.5 font-semibold text-white shadow-black/20
                  bg-[var(--aa-danger,var(--aa-error))]
                  hover:brightness-110
                  ${compact ? 'h-7 rounded-md px-2' : 'h-8 rounded-lg px-3 shadow-lg'}`}
    >
      <Skull size={compact ? 13 : 15} />
      {count > 1 ? `Kill ${count}` : 'Kill'}
    </button>
  );
}
