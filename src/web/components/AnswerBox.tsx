import { useEffect, useState, type RefObject } from 'react';
import { ChevronRight, CornerDownLeft } from 'lucide-react';
import type { ActionItem, ActionOption } from '../../shared/protocol';
import { api } from '../lib/api';
import { useBoard } from '../lib/store';

// Answer buttons on an Actions item: the dialog's numbered options (needs_you) or
// Nudge / Interrupt / Ignore (stuck). Digits 1-9 pick an option while the item has focus.

type Tone = 'primary' | 'neutral' | 'danger';

function toneOf(option: ActionOption, index: number, options: ActionOption[]): Tone {
  if (option.key === 'nudge') return 'primary';
  if (option.key === 'interrupt') return 'danger';
  if (/^no\b/i.test(option.label)) return 'danger';
  // Only the first plain "Yes" is the primary choice; "Yes, and don't ask again" stays neutral
  const firstYes = options.findIndex((o) => /^yes\b/i.test(o.label));
  return index === firstYes ? 'primary' : 'neutral';
}

const TONE: Record<Tone, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110',
  neutral: 'bg-elevated text-fg ring-1 ring-line-strong hover:bg-hover',
  danger: 'bg-error/10 text-error ring-1 ring-error/40 hover:bg-error/20',
};

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
}

export function AnswerBox({ action, itemRef }: { action: ActionItem; itemRef: RefObject<HTMLLIElement | null> }) {
  const options = action.options ?? [];
  const stuck = action.kind === 'stuck';
  const [sent, setSent] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [showContext, setShowContext] = useState(false);

  // A new dialog on the same item (Claude redrew a different question) can be answered again
  const signature = JSON.stringify([action.question, options]);
  useEffect(() => setSent(null), [signature]);

  const send = (answer: { key?: string; text?: string }, label: string): void => {
    if (sent) return;
    setSent(label);
    api
      .answerAction(action.id, answer)
      // No upsert from the reply: the socket's update (often already resolved) may have arrived first
      .then(() => {
        if (answer.text) setReply('');
      })
      .catch((error: unknown) => {
        setSent(null);
        useBoard.getState().toast(`Answer failed: ${(error as Error).message}`);
      });
  };

  useEffect(() => {
    const el = itemRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const option = stuck ? options[Number(e.key) - 1] : options.find((o) => o.key === e.key);
      if (!option) return;
      e.preventDefault();
      e.stopPropagation();
      send({ key: option.key }, option.label);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  });

  return (
    <div data-testid="answer-box" className="mt-2 flex flex-col gap-1.5 pl-[38px]">
      {action.question && (
        <p data-testid="answer-question" className="text-[12.5px] leading-[18px] font-medium text-fg">
          {action.question}
        </p>
      )}
      <div className={stuck ? 'flex flex-wrap gap-1.5' : 'flex flex-col gap-1'}>
        {options.map((option, i) => (
          <button
            key={option.key}
            type="button"
            data-testid="answer-option"
            data-key={option.key}
            data-tone={toneOf(option, i, options)}
            disabled={!!sent}
            title={option.label}
            onClick={() => send({ key: option.key }, option.label)}
            className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] font-medium
                        disabled:cursor-default disabled:opacity-50
                        ${TONE[toneOf(option, i, options)]}`}
          >
            <kbd
              className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-black/15 font-mono text-[10px]
                         leading-none"
            >
              {stuck ? i + 1 : option.key}
            </kbd>
            <span className={`min-w-0 ${stuck ? 'truncate' : 'line-clamp-2 leading-[16px]'}`}>{option.label}</span>
          </button>
        ))}
      </div>
      {action.allowText && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const text = reply.trim();
            if (text) send({ text }, 'reply');
          }}
        >
          <input
            data-testid="answer-reply"
            value={reply}
            disabled={!!sent}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Or tell Claude what to do instead…"
            aria-label="Typed answer"
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px] text-fg
                       placeholder:text-fg-subtle
                       focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!!sent || !reply.trim()}
            title="Send typed answer"
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-muted ring-1 ring-line-strong
                       hover:bg-hover hover:text-fg
                       disabled:opacity-40"
          >
            <CornerDownLeft size={13} />
          </button>
        </form>
      )}
      {sent && (
        <p data-testid="answer-sent" className="text-[11px] text-fg-subtle">
          Sent “{sent === 'reply' ? 'your reply' : sent}” · waiting for Claude…
        </p>
      )}
      {!!action.context?.length && (
        <div>
          <button
            type="button"
            aria-expanded={showContext}
            onClick={() => setShowContext(!showContext)}
            className="flex items-center gap-0.5 text-[11px] text-fg-subtle hover:text-fg-muted"
          >
            <ChevronRight size={11} className={`transition-transform ${showContext ? 'rotate-90' : ''}`} />
            {showContext ? 'Hide context' : 'Show context'}
          </button>
          {showContext && (
            <pre
              data-testid="answer-context"
              className="aa-scroll mt-1 max-h-32 overflow-auto rounded-md bg-surface px-2 py-1.5 font-mono text-[11px]
                         leading-4 whitespace-pre-wrap text-fg-muted"
            >
              {action.context.slice(-6).join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
