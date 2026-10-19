import { Skull, Trash2 } from 'lucide-react';
import { askKill } from '../lib/board-actions';
import { useItems } from '../lib/items';
import { useBoard } from '../lib/store';

// Number of selected consoles/browser tiles/board items (the multi-selection, else the focused one)
export function useKillCount(): number {
  const items = useItems((s) => s.items);
  return useBoard((s) => {
    const ids = s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : [];
    return ids.filter((id) => s.consoles[id] || s.browsers[id] || items[id]).length;
  });
}

// True when the selection is only notes / checklists / kanban / files (nothing to kill)
function useOnlyItems(): boolean {
  const items = useItems((s) => s.items);
  return useBoard((s) => {
    const ids = s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : [];
    return ids.length > 0 && ids.every((id) => items[id]);
  });
}

// Red "Kill" / "Kill 3": stops and removes the selection after a confirm (also the Delete key)
export function KillButton({ compact = false }: { compact?: boolean }) {
  const count = useKillCount();
  const onlyItems = useOnlyItems();
  if (!count) return null;
  const verb = onlyItems ? 'Delete' : 'Kill';
  const Icon = onlyItems ? Trash2 : Skull;
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
      <Icon size={compact ? 13 : 15} />
      {count > 1 ? `${verb} ${count}` : verb}
    </button>
  );
}
