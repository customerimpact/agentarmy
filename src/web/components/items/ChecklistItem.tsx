import { useState, type DragEvent } from 'react';
import { GripVertical, ListChecks, Plus, Send, X } from 'lucide-react';
import type { ChecklistData, ChecklistEntry } from '../../../shared/protocol';
import { sendLine } from '../../lib/board-actions';
import { newId } from '../../lib/items';
import { useBoard } from '../../lib/store';
import { ConsolePicker, DeleteItemButton, IconBtn, InlineEdit, itemTint } from './common';
import type { ItemRendererProps } from './registry';

const DRAG_TYPE = 'application/x-agentarmy-checklist';

export function checklistPrompt(title: string, entries: ChecklistEntry[]): string {
  const open = entries.filter((e) => !e.done && e.text.trim());
  const heading = title.trim() ? `Please work through these open items from "${title.trim()}":` : 'Please work through these open items:';
  return [heading, ...open.map((e) => `- [ ] ${e.text.trim()}`)].join('\n');
}

// Move entry `from` so it lands before index `to` (to = length appends)
export function moveEntry<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from + 1 === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}

export function ChecklistItem({ item, setData, remove }: ItemRendererProps<ChecklistData>) {
  const title = typeof item.data.title === 'string' ? item.data.title : 'Checklist';
  const entries: ChecklistEntry[] = Array.isArray(item.data.entries) ? item.data.entries : [];
  const [draft, setDraft] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const done = entries.filter((e) => e.done).length;
  const openCount = entries.length - done;

  const save = (next: Partial<ChecklistData>) => setData({ ...item.data, title, entries, ...next });
  const update = (id: string, patch: Partial<ChecklistEntry>) =>
    save({ entries: entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    save({ entries: [...entries, { id: newId(), text, done: false }] });
    setDraft('');
  };

  const onDragOver = (e: DragEvent, index: number) => {
    if (dragIndex === null) return;
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropIndex(e.clientY > box.top + box.height / 2 ? index + 1 : index);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (dragIndex !== null && dropIndex !== null) save({ entries: moveEntry(entries, dragIndex, dropIndex) });
    setDragIndex(null);
    setDropIndex(null);
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-line shadow-xl shadow-black/30"
      style={{ background: itemTint(item.color, 10) }}
    >
      <div className="aa-drag-handle flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line bg-surface-2/70 px-2.5 select-none">
        <ListChecks size={14} className="shrink-0 text-accent" />
        <InlineEdit
          testId="checklist-title"
          value={title}
          onSave={(t) => save({ title: t.trim() || 'Checklist' })}
          className="flex-1 px-1 py-0.5 text-[13px] font-semibold text-fg"
        />
        <span data-testid="checklist-progress" className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] font-semibold text-fg-muted tabular-nums">
          {done}/{entries.length}
        </span>
        <IconBtn
          label="Send open items to agent…"
          testId="checklist-send"
          onClick={setPickerAnchor}
        >
          <Send size={13} />
        </IconBtn>
        <DeleteItemButton remove={remove} />
      </div>
      {entries.length > 0 && (
        <div className="h-1 shrink-0 bg-line/50">
          <div className="h-full bg-resting transition-[width] duration-300" style={{ width: `${(done / entries.length) * 100}%` }} />
        </div>
      )}
      <ul
        className="nodrag nowheel aa-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
        onDragOver={(e) => dragIndex !== null && e.preventDefault()}
        onDrop={onDrop}
      >
        {entries.map((entry, index) => (
          <li
            key={entry.id}
            data-testid="checklist-entry"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, entry.id);
              e.dataTransfer.effectAllowed = 'move';
              setDragIndex(index);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setDropIndex(null);
            }}
            onDragOver={(e) => onDragOver(e, index)}
            className={`group/entry relative flex items-center gap-1.5 rounded-md px-1 py-1
                        hover:bg-hover/60 ${dragIndex === index ? 'opacity-40' : ''}`}
          >
            {dropIndex === index && <span className="absolute -top-px right-1 left-1 h-0.5 rounded bg-accent" />}
            {dropIndex === index + 1 && index === entries.length - 1 && (
              <span className="absolute right-1 -bottom-px left-1 h-0.5 rounded bg-accent" />
            )}
            <GripVertical size={12} className="shrink-0 cursor-grab text-fg-subtle opacity-0 group-hover/entry:opacity-100" />
            <input
              type="checkbox"
              checked={entry.done}
              aria-label={entry.text}
              data-testid="checklist-toggle"
              onChange={(e) => update(entry.id, { done: e.target.checked })}
              className="size-3.5 shrink-0 cursor-pointer accent-[var(--aa-accent)]"
            />
            <InlineEdit
              value={entry.text}
              onSave={(t) => (t.trim() ? update(entry.id, { text: t.trim() }) : save({ entries: entries.filter((x) => x.id !== entry.id) }))}
              className={`flex-1 px-1 text-[12.5px] ${entry.done ? 'text-fg-subtle line-through' : 'text-fg'}`}
            />
            <button
              type="button"
              aria-label="Delete item"
              data-testid="checklist-delete-entry"
              onClick={() => save({ entries: entries.filter((x) => x.id !== entry.id) })}
              className="grid size-5 shrink-0 place-items-center rounded text-fg-subtle opacity-0
                         group-hover/entry:opacity-100 hover:bg-hover hover:text-error"
            >
              <X size={12} />
            </button>
          </li>
        ))}
        {!entries.length && <li className="px-2 py-1 text-[12px] text-fg-subtle italic">Nothing yet. Add the first item below.</li>}
      </ul>
      <form
        className="nodrag flex shrink-0 items-center gap-1.5 border-t border-line px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Plus size={13} className="shrink-0 text-fg-subtle" />
        <input
          data-testid="checklist-add"
          value={draft}
          placeholder="Add an item and press Enter"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
        />
      </form>
      {pickerAnchor && (
        <ConsolePicker
          anchor={pickerAnchor}
          title={openCount ? `Send ${openCount} open item${openCount === 1 ? '' : 's'} to…` : 'Nothing open to send'}
          onClose={() => setPickerAnchor(null)}
          onPick={(consoleId) => {
            setPickerAnchor(null);
            if (!openCount) return;
            sendLine(consoleId, checklistPrompt(title, entries));
            const name = useBoard.getState().consoles[consoleId]?.name ?? 'the agent';
            useBoard.getState().toast(`Sent ${openCount} open item${openCount === 1 ? '' : 's'} to ${name}`);
          }}
        />
      )}
    </div>
  );
}
