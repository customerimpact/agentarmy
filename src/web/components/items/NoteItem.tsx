import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { StickyNote } from 'lucide-react';
import type { NoteData } from '../../../shared/protocol';
import { persistItemLayout } from '../../lib/board-actions';
import { parseMarkdownLite, type Block, type Inline } from '../../lib/markdown-lite';
import { ColorSwatches, DeleteItemButton, itemTint, setItemColor } from './common';
import type { ItemRendererProps } from './registry';

const MAX_AUTO_HEIGHT = 1400;

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'bold':
        return <strong key={i} className="font-semibold text-fg">{renderInline(n.c)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(n.c)}</em>;
      case 'code':
        return (
          <code key={i} className="rounded bg-canvas/70 px-1 py-px font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener"
            className="nodrag text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            onClick={(e) => e.stopPropagation()}
          >
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'heading': {
        const cls = b.level === 1 ? 'text-[17px] font-bold' : b.level === 2 ? 'text-[15px] font-semibold' : 'text-[13px] font-semibold uppercase tracking-wide text-fg-muted';
        return (
          <div key={i} role="heading" aria-level={b.level} className={`${cls} mt-1 mb-0.5 leading-snug text-fg first:mt-0`}>
            {renderInline(b.c)}
          </div>
        );
      }
      case 'para':
        return <p key={i} className="leading-relaxed">{renderInline(b.c)}</p>;
      case 'gap':
        return <div key={i} className="h-2" />;
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag key={i} className={`${b.ordered ? 'list-decimal' : 'list-disc'} my-0.5 pl-5 leading-relaxed marker:text-fg-subtle`}>
            {b.items.map((item, j) => (
              <li key={j} className={item.task ? 'list-none -ml-4' : ''}>
                {item.task && (
                  <span
                    aria-hidden
                    className={`mr-1.5 inline-grid size-3 translate-y-[1px] place-items-center rounded-[3px] border text-[9px] leading-none
                                ${item.done ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong'}`}
                  >
                    {item.done ? '✓' : ''}
                  </span>
                )}
                <span className={item.done ? 'text-fg-subtle line-through' : ''}>{renderInline(item.c)}</span>
              </li>
            ))}
          </Tag>
        );
      }
    }
  });
}

export function NoteItem({ item, selected, setData, remove }: ItemRendererProps<NoteData>) {
  const text = typeof item.data.text === 'string' ? item.data.text : '';
  const [editing, setEditing] = useState(() => !text && Date.now() - item.createdAt < 3000);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  // Auto-grow: never shrink below what the user sized, grow when the text needs more room
  useLayoutEffect(() => {
    const content = editing ? textareaRef.current : contentRef.current;
    const box = boxRef.current;
    if (!content || !box) return;
    const overflow = content.scrollHeight - content.clientHeight;
    if (overflow > 2) {
      const height = Math.min(MAX_AUTO_HEIGHT, item.layout.height + overflow + 4);
      if (height > item.layout.height) persistItemLayout(item.id, { height });
    }
  }, [text, editing, item.layout.height, item.layout.width, item.id]);

  return (
    <div
      ref={boxRef}
      className="group/note flex h-full w-full flex-col overflow-hidden rounded-xl border border-line shadow-xl shadow-black/30"
      style={{ background: itemTint(item.color ?? 'amber', 20) }}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('a, button')) return;
        e.stopPropagation();
        setEditing(true);
      }}
    >
      <div className="aa-drag-handle flex h-7 shrink-0 cursor-grab items-center gap-1.5 px-2 text-fg-subtle select-none">
        <StickyNote size={12} className="shrink-0" />
        <span className="flex-1" />
        <div className={`flex items-center gap-1.5 transition-opacity ${selected || editing ? 'opacity-100' : 'opacity-0 group-hover/note:opacity-100'}`}>
          <ColorSwatches value={item.color ?? 'amber'} onPick={(c) => setItemColor(item.id, c)} />
          <DeleteItemButton remove={remove} />
        </div>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          data-testid="note-textarea"
          value={text}
          placeholder={'# Title\nWrite a note… **bold**, - lists, [links](https://…)'}
          onChange={(e) => setData({ ...item.data, text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          }}
          className="nodrag nowheel aa-scroll min-h-0 flex-1 resize-none bg-transparent px-3 pb-3 font-mono text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle"
        />
      ) : (
        <div
          ref={contentRef}
          data-testid="note-view"
          className="aa-drag-handle aa-scroll min-h-0 flex-1 cursor-grab overflow-hidden px-3 pb-3 text-[13px] break-words text-fg"
          title="Double-click to edit"
        >
          {text.trim() ? (
            renderBlocks(parseMarkdownLite(text))
          ) : (
            <p className="text-fg-subtle italic">Empty note. Double-click to write.</p>
          )}
        </div>
      )}
    </div>
  );
}
