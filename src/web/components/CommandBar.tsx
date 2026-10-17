import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowRight, Grid2x2, Maximize2, Play, Plus, SendHorizontal, Users } from 'lucide-react';
import type { ConsoleInfo, ConsoleStatus } from '../../shared/protocol';
import { api } from '../lib/api';
import { fitAll, sendLine } from '../lib/board-actions';
import { isDormant } from '../lib/status';
import { consoleList, useBoard } from '../lib/store';
import { StatusDot } from './StatusDot';

const ALL = 'all';
const HISTORY_KEY = 'agentarmy.commandHistory';
const MAX_HISTORY = 50;
// @all skips consoles that are busy or have no process; interrupting a working agent is never wanted
const READY_STATUSES: ConsoleStatus[] = ['idle', 'resting', 'needs_you'];

interface Option {
  id: string;
  label: string;
  hint: string;
  status?: ConsoleStatus;
}

interface Mention {
  start: number;
  end: number;
  query: string;
}

function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // history is a convenience only
  }
}

// "@que" right before the caret, at the start or after whitespace
function findMention(value: string, caret: number): Mention | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  if (!match) return null;
  const start = match.index + match[1].length;
  return { start, end: caret, query: match[2].toLowerCase() };
}

const isReady = (c: ConsoleInfo) => READY_STATUSES.includes(c.status);

function Chip({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface/90 px-3 text-[12px] font-medium text-fg-muted shadow-lg shadow-black/20 backdrop-blur
                 hover:border-line-strong hover:text-fg"
    >
      {children}
    </button>
  );
}

export function CommandBar() {
  const consoles = useBoard((s) => s.consoles);
  const selectedId = useBoard((s) => s.selectedId);
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [explicitTarget, setExplicitTarget] = useState<string | null>(null);
  const [optionIndex, setOptionIndex] = useState(0);
  const [suggestionsSuppressed, setSuggestionsSuppressed] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const feedbackTimer = useRef<number | undefined>(undefined);

  // Clicking into another console retargets the bar; an @-picked target lasts until then
  useEffect(() => setExplicitTarget(null), [selectedId]);

  const list = consoleList(consoles);
  const readyCount = list.filter(isReady).length;
  const suspendedCount = list.filter((c) => c.status === 'suspended').length;
  const targetId =
    explicitTarget === ALL
      ? ALL
      : explicitTarget && consoles[explicitTarget]
        ? explicitTarget
        : selectedId && consoles[selectedId]
          ? selectedId
          : null;
  const targetConsole = targetId && targetId !== ALL ? consoles[targetId] : null;

  const mention = suggestionsSuppressed ? null : findMention(value, caret);
  const options: Option[] = mention
    ? [
        { id: ALL, label: 'all', hint: `${readyCount} ready` },
        ...list.map((c) => ({
          id: c.id,
          label: c.name,
          hint: c.status.replace('_', ' '),
          status: c.status,
        })),
      ].filter((o) => o.label.toLowerCase().includes(mention.query))
    : [];
  const suggestionsOpen = options.length > 0;

  const showFeedback = (text: string, ok: boolean) => {
    setFeedback({ text, ok });
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 2800);
  };

  const updateValue = (next: string, nextCaret = next.length) => {
    setValue(next);
    setCaret(nextCaret);
    setSuggestionsSuppressed(false);
    setOptionIndex(0);
  };

  const pick = (option: Option) => {
    if (!mention) return;
    // Drop the "@query" token (and one following space) so only the message remains
    const rest = value.slice(mention.end).replace(/^ /, '');
    const next = value.slice(0, mention.start) + rest;
    setExplicitTarget(option.id);
    updateValue(next, mention.start);
    window.requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(mention.start, mention.start);
    });
  };

  const send = () => {
    const text = value.replace(/\s+$/, '');
    if (!text.trim()) return;

    if (targetId === ALL) {
      const ready = list.filter(isReady);
      if (!ready.length) {
        showFeedback('No agent is ready (idle, resting or needs you)', false);
        return;
      }
      for (const c of ready) sendLine(c.id, text);
      showFeedback(`Sent to ${ready.length} ${ready.length === 1 ? 'agent' : 'agents'}`, true);
    } else if (targetConsole) {
      if (isDormant(targetConsole.status)) {
        showFeedback(`${targetConsole.name} isn't running. Resume it first.`, false);
        return;
      }
      sendLine(targetConsole.id, text);
      showFeedback(`Sent to ${targetConsole.name}`, true);
    } else {
      showFeedback('Select a console or type @ to pick one', false);
      return;
    }

    const nextHistory = [...history.filter((h) => h !== text), text].slice(-MAX_HISTORY);
    setHistory(nextHistory);
    saveHistory(nextHistory);
    setHistoryIndex(null);
    updateValue('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestionsOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setOptionIndex((i) => (i + delta + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(options[Math.min(optionIndex, options.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggestionsSuppressed(true);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.blur();
      return;
    }
    // History only while the draft is a single line, so ↑/↓ still move within multi-line text
    if (e.key === 'ArrowUp' && !value.includes('\n') && history.length) {
      e.preventDefault();
      const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      updateValue(history[index]);
      return;
    }
    if (e.key === 'ArrowDown' && historyIndex !== null && !value.includes('\n')) {
      e.preventDefault();
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(null);
        updateValue('');
      } else {
        setHistoryIndex(index);
        updateValue(history[index]);
      }
    }
  };

  const rows = Math.min(6, value.split('\n').length);
  const { setNewAgentOpen } = useBoard.getState();

  return (
    <div
      data-testid="command-bar"
      className="pointer-events-none absolute bottom-4 left-1/2 z-10 flex w-[min(680px,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2"
    >
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5">
        <Chip onClick={() => setNewAgentOpen(true)}>
          <Plus size={13} />
          New agent
        </Chip>
        <Chip testId="command-bar-spawn4" onClick={() => setNewAgentOpen(true, 4)}>
          <Grid2x2 size={13} />
          Spawn 4
        </Chip>
        <Chip onClick={fitAll}>
          <Maximize2 size={12} />
          Fit all
        </Chip>
        {suspendedCount > 0 && (
          <Chip
            testId="command-bar-resume-all"
            onClick={() => {
              api.resumeAll().catch((error: Error) => {
                useBoard.getState().toast(`Resume failed: ${error.message}`);
              });
            }}
          >
            <Play size={12} />
            Resume all ({suspendedCount})
          </Chip>
        )}
        {feedback && (
          <span
            role="status"
            data-testid="command-bar-feedback"
            className={`inline-flex h-7 items-center rounded-full bg-elevated/95 px-3 text-[12px] font-medium shadow-lg shadow-black/20
                        ${feedback.ok ? 'text-resting' : 'text-needs'}`}
          >
            {feedback.text}
          </span>
        )}
      </div>

      <div className="pointer-events-auto relative">
        {suggestionsOpen && (
          <ul
            role="listbox"
            aria-label="Pick a target"
            className="aa-scroll absolute right-0 bottom-full left-0 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line-strong bg-elevated p-1 shadow-2xl shadow-black/40"
          >
            {options.map((option, index) => (
              <li
                key={option.id}
                role="option"
                aria-selected={index === optionIndex}
                data-testid="command-bar-option"
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the input
                  pick(option);
                }}
                onMouseEnter={() => setOptionIndex(index)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5
                            ${index === optionIndex ? 'bg-accent/15 text-fg' : 'text-fg-muted'}`}
              >
                {option.status ? (
                  <StatusDot status={option.status} />
                ) : (
                  <Users size={13} className="text-accent" />
                )}
                <span className="font-medium">@{option.label}</span>
                <span className="ml-auto text-[11px] text-fg-subtle">{option.hint}</span>
              </li>
            ))}
          </ul>
        )}

        <div
          className="flex items-end gap-2 rounded-2xl border border-line-strong bg-elevated/95 p-2 shadow-2xl shadow-black/40 backdrop-blur
                     focus-within:border-accent/60"
        >
          <button
            type="button"
            data-testid="command-bar-target"
            title="Change target (type @)"
            onClick={() => {
              const next = value.startsWith('@') ? value : `@${value}`;
              updateValue(next, 1);
              inputRef.current?.focus();
              window.requestAnimationFrame(() => inputRef.current?.setSelectionRange(1, 1));
            }}
            className={`inline-flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium
                        hover:brightness-110
                        ${targetId ? 'bg-accent/15 text-fg' : 'bg-surface-2 text-fg-subtle'}`}
          >
            <ArrowRight size={12} className="shrink-0 text-accent" />
            {targetId === ALL ? (
              <span className="truncate">all ({readyCount} ready)</span>
            ) : targetConsole ? (
              <>
                <StatusDot status={targetConsole.status} size={6} />
                <span className="truncate">{targetConsole.name}</span>
              </>
            ) : (
              <span>no target</span>
            )}
          </button>
          <textarea
            ref={inputRef}
            data-testid="command-bar-input"
            rows={rows}
            value={value}
            spellCheck={false}
            placeholder="Message an agent… (@ to pick)"
            onChange={(e) => {
              updateValue(e.target.value, e.target.selectionStart);
              setHistoryIndex(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            className="aa-scroll min-h-8 flex-1 resize-none bg-transparent py-1.5 leading-5 text-fg outline-none placeholder:text-fg-subtle"
          />
          <button
            type="button"
            data-testid="command-bar-send"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!value.trim()}
            onClick={send}
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg disabled:opacity-40
                       hover:brightness-110"
          >
            <SendHorizontal size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
