import { useState, type DragEvent } from 'react';
import { Bot, CircleCheck, Columns3, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import type { KanbanCard, KanbanColumn, KanbanData } from '../../../shared/protocol';
import { flyTo } from '../../lib/board-actions';
import { flushItemData, itemsApi, newId, useItems } from '../../lib/items';
import { useBoard } from '../../lib/store';
import { ConsolePicker, DeleteItemButton, IconBtn, InlineEdit, itemTint } from './common';
import type { ItemRendererProps } from './registry';

const DRAG_TYPE = 'application/x-agentarmy-card';

interface CardDrag {
  cardId: string;
  fromColumn: string;
}

// Move a card to column `toColumn` before index `toIndex` (-1 / out of range = append)
export function moveCard(columns: KanbanColumn[], cardId: string, toColumn: string, toIndex: number): KanbanColumn[] {
  let card: KanbanCard | undefined;
  let fromIndex = -1;
  let fromColumn = '';
  for (const c of columns) {
    const i = c.cards.findIndex((x) => x.id === cardId);
    if (i !== -1) {
      card = c.cards[i];
      fromIndex = i;
      fromColumn = c.id;
    }
  }
  if (!card) return columns;
  return columns.map((c) => {
    let cards = c.id === fromColumn ? c.cards.filter((x) => x.id !== cardId) : c.cards;
    if (c.id === toColumn) {
      let at = toIndex < 0 || toIndex > c.cards.length ? cards.length : toIndex;
      if (c.id === fromColumn && fromIndex < at) at -= 1;
      cards = [...cards.slice(0, at), card!, ...cards.slice(at)];
    }
    return cards === c.cards ? c : { ...c, cards };
  });
}

function AgentBadge({ card }: { card: KanbanCard }) {
  const agent = useBoard((s) => (card.assignedConsoleId ? s.consoles[card.assignedConsoleId] : undefined));
  if (!card.assignedConsoleId) return null;
  const name = agent?.name ?? 'agent';
  const finished = !!card.finishedAt;
  return (
    <button
      type="button"
      data-testid={finished ? 'card-agent-finished' : 'card-agent-working'}
      title={finished ? `${name} finished its turn. Click to open it.` : `Sent to ${name}. Click to open it.`}
      onClick={(e) => {
        e.stopPropagation();
        if (agent) void flyTo(agent.id);
      }}
      className={`nodrag mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold
                  ${finished ? 'bg-resting/15 text-resting ring-1 ring-resting/40' : 'bg-working/12 text-working ring-1 ring-working/35'}`}
    >
      {finished ? <CircleCheck size={11} /> : <LoaderCircle size={11} className="animate-spin" />}
      <span className="truncate">{finished ? `${name} finished` : `${name} on it`}</span>
    </button>
  );
}

function CardView({
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOver,
  onChange,
  onDelete,
  onAssign,
}: {
  card: KanbanCard;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onChange: (patch: Partial<KanbanCard>) => void;
  onDelete: () => void;
  onAssign: (anchor: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="kanban-card"
      draggable={!open}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      className={`group/card rounded-lg border border-line bg-surface px-2 py-1.5 shadow-sm shadow-black/20
                  hover:border-line-strong ${dragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-start gap-1">
        <InlineEdit
          testId="kanban-card-title"
          value={card.title}
          onSave={(title) => (title.trim() ? onChange({ title: title.trim() }) : onDelete())}
          className="flex-1 px-0.5 text-[12.5px] font-medium text-fg"
        />
        <div className="flex shrink-0 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100">
          <IconBtn label="Assign to agent…" testId="kanban-assign" onClick={onAssign}>
            <Bot size={12} />
          </IconBtn>
          <IconBtn label="Delete card" onClick={onDelete} danger>
            <Trash2 size={12} />
          </IconBtn>
        </div>
      </div>
      {open || card.description ? (
        <textarea
          value={card.description ?? ''}
          placeholder="Description (sent with the card)"
          rows={open ? 3 : Math.min(4, (card.description ?? '').split('\n').length)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => onChange({ description: e.target.value })}
          className="nodrag nowheel mt-0.5 w-full resize-none rounded bg-transparent px-0.5 text-[11.5px] leading-snug text-fg-muted outline-none placeholder:text-fg-subtle focus:bg-canvas/60"
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="nodrag px-0.5 text-[11px] text-fg-subtle opacity-0 group-hover/card:opacity-100 hover:text-fg-muted"
        >
          + description
        </button>
      )}
      <AgentBadge card={card} />
    </div>
  );
}

export function KanbanItem({ item, setData, remove }: ItemRendererProps<KanbanData>) {
  const title = typeof item.data.title === 'string' ? item.data.title : 'Kanban';
  const columns: KanbanColumn[] = Array.isArray(item.data.columns) ? item.data.columns : [];
  const [drag, setDrag] = useState<CardDrag | null>(null);
  const [drop, setDrop] = useState<{ column: string; index: number } | null>(null);
  const [assign, setAssign] = useState<{ cardId: string; anchor: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const save = (next: Partial<KanbanData>) => setData({ ...item.data, title, columns, ...next });
  const setColumns = (next: KanbanColumn[]) => save({ columns: next });
  const updateCard = (cardId: string, patch: Partial<KanbanCard>) =>
    setColumns(columns.map((c) => ({ ...c, cards: c.cards.map((x) => (x.id === cardId ? { ...x, ...patch } : x)) })));
  const deleteCard = (cardId: string) => setColumns(columns.map((c) => ({ ...c, cards: c.cards.filter((x) => x.id !== cardId) })));

  const addCard = (columnId: string) => {
    const text = draft.trim();
    if (!text) return;
    setColumns(columns.map((c) => (c.id === columnId ? { ...c, cards: [...c.cards, { id: newId(), title: text }] } : c)));
    setDraft('');
  };

  const overCard = (e: DragEvent, column: string, index: number) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrop({ column, index: e.clientY > box.top + box.height / 2 ? index + 1 : index });
  };

  const finishDrop = (e: DragEvent, column: string) => {
    e.preventDefault();
    if (drag) setColumns(moveCard(columns, drag.cardId, column, drop?.column === column ? drop.index : -1));
    setDrag(null);
    setDrop(null);
  };

  const assignTo = async (cardId: string, consoleId: string) => {
    setAssign(null);
    try {
      await flushItemData(item.id); // the server moves the card; it must see the latest edits
      const updated = await itemsApi.assignCard(item.id, cardId, consoleId);
      useItems.getState().upsertItem(updated);
      const name = useBoard.getState().consoles[consoleId]?.name ?? 'the agent';
      useBoard.getState().toast(`Card sent to ${name}`);
    } catch (error) {
      useBoard.getState().toast(`Could not assign the card: ${(error as Error).message}`);
    }
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-line shadow-xl shadow-black/30"
      style={{ background: itemTint(item.color, 8) }}
    >
      <div className="aa-drag-handle flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line bg-surface-2/70 px-2.5 select-none">
        <Columns3 size={14} className="shrink-0 text-accent" />
        <InlineEdit
          testId="kanban-title"
          value={title}
          onSave={(t) => save({ title: t.trim() || 'Kanban' })}
          className="flex-1 px-1 py-0.5 text-[13px] font-semibold text-fg"
        />
        <IconBtn
          label="Add column"
          testId="kanban-add-column"
          onClick={() => setColumns([...columns, { id: newId(), title: 'New column', cards: [] }])}
        >
          <Plus size={14} />
        </IconBtn>
        <DeleteItemButton remove={remove} />
      </div>
      <div className="nodrag nowheel aa-scroll flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
        {columns.map((column) => (
          <section
            key={column.id}
            data-testid="kanban-column"
            data-column={column.title}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              if (drop?.column !== column.id) setDrop({ column: column.id, index: column.cards.length });
            }}
            onDrop={(e) => finishDrop(e, column.id)}
            className={`group/col flex w-56 min-w-44 flex-1 shrink-0 flex-col rounded-lg border bg-canvas/40
                        ${drag && drop?.column === column.id ? 'border-accent/60' : 'border-line/70'}`}
          >
            <header className="flex h-8 shrink-0 items-center gap-1 px-2">
              <InlineEdit
                testId="kanban-column-title"
                value={column.title}
                onSave={(t) => setColumns(columns.map((c) => (c.id === column.id ? { ...c, title: t.trim() || c.title } : c)))}
                className="flex-1 px-1 text-[11.5px] font-semibold tracking-wide text-fg-muted uppercase"
              />
              <span className="text-[11px] text-fg-subtle tabular-nums">{column.cards.length}</span>
              <span className="opacity-0 group-hover/col:opacity-100">
                <IconBtn
                  label="Delete column"
                  onClick={() => {
                    if (column.cards.length && !window.confirm(`Delete "${column.title}" and its ${column.cards.length} cards?`)) return;
                    setColumns(columns.filter((c) => c.id !== column.id));
                  }}
                  danger
                >
                  <X size={12} />
                </IconBtn>
              </span>
            </header>
            <ul className="aa-scroll flex min-h-6 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
              {column.cards.map((card, index) => (
                <li key={card.id} className="relative">
                  {drop?.column === column.id && drop.index === index && drag && (
                    <span className="absolute -top-1 right-1 left-1 h-0.5 rounded bg-accent" />
                  )}
                  <CardView
                    card={card}
                    dragging={drag?.cardId === card.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, card.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDrag({ cardId: card.id, fromColumn: column.id });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDrop(null);
                    }}
                    onDragOver={(e) => overCard(e, column.id, index)}
                    onChange={(patch) => updateCard(card.id, patch)}
                    onDelete={() => deleteCard(card.id)}
                    onAssign={(anchor) => setAssign({ cardId: card.id, anchor })}
                  />
                </li>
              ))}
              {drop?.column === column.id && drop.index >= column.cards.length && drag && column.cards.length > 0 && (
                <li className="mx-1 h-0.5 rounded bg-accent" />
              )}
            </ul>
            {adding === column.id ? (
              <form
                className="shrink-0 px-1.5 pb-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  addCard(column.id);
                }}
              >
                <input
                  autoFocus
                  data-testid="kanban-new-card"
                  value={draft}
                  placeholder="Card title, Enter to add"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    addCard(column.id);
                    setAdding(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                      setDraft('');
                      setAdding(null);
                    }
                  }}
                  className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                />
              </form>
            ) : (
              <button
                type="button"
                data-testid="kanban-add-card"
                onClick={() => {
                  setDraft('');
                  setAdding(column.id);
                }}
                className="mx-1.5 mb-1.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-fg-subtle
                           hover:bg-hover hover:text-fg"
              >
                <Plus size={12} /> Add card
              </button>
            )}
          </section>
        ))}
      </div>
      {assign && (
        <ConsolePicker
          anchor={assign.anchor}
          title="Assign card to…"
          onClose={() => setAssign(null)}
          onPick={(consoleId) => void assignTo(assign.cardId, consoleId)}
        />
      )}
    </div>
  );
}
