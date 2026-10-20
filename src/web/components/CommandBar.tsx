import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Boxes,
  Check,
  Grid2x2,
  LayoutTemplate,
  Maximize2,
  Network,
  Pause,
  Play,
  Plus,
  SendHorizontal,
  Users,
  X,
  Brain,
} from 'lucide-react';
import type { ConsoleInfo, ConsoleStatus } from '../../shared/protocol';
import { api } from '../lib/api';
import { fitAll, sendLine } from '../lib/board-actions';
import { isDormant } from '../lib/status';
import { consoleList, useBoard } from '../lib/store';
import { StatusDot } from './StatusDot';
import { DictationButton } from './LazyDictationButton';
import { agentsLabel, pauseAll, resumePaused, teamApi, useLoops } from '../lib/loops';
import { parseTeamMention } from '../lib/team-mention';
import { openMemory } from '../lib/handoff-memory';

const ALL = 'all';
const PROJECT = 'project:';
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
  title,
  active,
  hint,
}: {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  title?: string;
  active?: boolean;
  hint?: string; // keyboard shortcut shown as a keycap
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      onClick={onClick}
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium backdrop-blur transition-colors
                  hover:border-line-strong hover:text-fg
                  [&_svg]:text-fg-subtle
                  ${active ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line bg-elevated/90 text-fg-muted'}`}
    >
      {children}
      {hint && <kbd className="aa-kbd ml-0.5">{hint}</kbd>}
    </button>
  );
}

export function CommandBar() {
  const consoles = useBoard((s) => s.consoles);
  const selectedId = useBoard((s) => s.selectedId);
  const selectedIds = useBoard((s) => s.selectedIds);
  const projects = useBoard((s) => s.projects);
  const [groupName, setGroupName] = useState<string | null>(null);
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
  const workingCount = list.filter((c) => c.status === 'working').length;
  const pausedCount = list.filter((c) => c.paused).length;
  // "@<project>" (or @team:<name>) targets every running console of that project
  const targetProject = explicitTarget?.startsWith(PROJECT) ? projects[explicitTarget.slice(PROJECT.length)] : undefined;
  const targetId =
    explicitTarget === ALL
      ? ALL
      : targetProject || (explicitTarget && consoles[explicitTarget])
        ? explicitTarget
        : selectedId && consoles[selectedId]
          ? selectedId
          : null;
  const targetConsole = targetId && targetId !== ALL && !targetProject ? consoles[targetId] : null;

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
      ]
        .filter((o) => o.label.toLowerCase().includes(mention.query))
        .concat(
          Object.values(projects)
            .filter((p) => p.open && p.name.toLowerCase().includes(mention.query.replace(/^team:/, '')))
            .map((p) => ({ id: `${PROJECT}${p.id}`, label: p.name, hint: `team · ${agentsLabel(p.consoleIds.length)}` })),
        )
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

    const typedTeam = targetProject ? null : parseTeamMention(text, Object.values(projects), list.map((c) => c.name));
    const teamId = targetProject?.id ?? typedTeam?.projectId;
    if (teamId) {
      const body = typedTeam ? typedTeam.rest : text;
      if (!body.trim()) {
        showFeedback('Type a message after the team name', false);
        return;
      }
      teamApi
        .sendToProject(teamId, body)
        .then((res) =>
          showFeedback(
            res.sent
              ? `Sent to ${agentsLabel(res.sent)}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}`
              : 'No agent in that team is running',
            res.sent > 0,
          ),
        )
        .catch((error: Error) => showFeedback(`Send failed: ${error.message}`, false));
    } else if (targetId === ALL) {
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
  const { setNewAgentOpen, setTemplatesOpen, setMissionMapOpen } = useBoard.getState();
  const groupIds = selectedIds.filter((id) => consoles[id]);

  const startGroup = () => {
    if (groupIds.length < 2) {
      showFeedback('Ctrl+click 2 or more consoles to group them', false);
      return;
    }
    setGroupName('');
  };

  const createGroup = async () => {
    const name = groupName?.trim();
    if (!name) return;
    try {
      const project = await api.createProject({ name, consoleIds: groupIds });
      useBoard.getState().upsertProject(project);
      showFeedback(`Grouped ${groupIds.length} agents as ${project.name}`, true);
      setGroupName(null);
    } catch (error) {
      showFeedback(`Group failed: ${(error as Error).message}`, false);
    }
  };

  return (
    <div
      data-testid="command-bar"
      className="pointer-events-none absolute bottom-4 left-1/2 z-10 flex w-[min(680px,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2"
    >
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5">
        <Chip onClick={() => setNewAgentOpen(true)} hint="N">
          <Plus size={13} />
          New agent
        </Chip>
        <Chip testId="command-bar-templates" onClick={() => setTemplatesOpen(true)}>
          <LayoutTemplate size={13} />
          Templates
        </Chip>
        <Chip testId="command-bar-compose" title="Launch up to 12 agents with roles and first prompts" onClick={() => useLoops.getState().openComposer()}>
          <Users size={13} />
          Compose team
        </Chip>
        <Chip testId="command-bar-spawn4" onClick={() => setNewAgentOpen(true, 4)}>
          <Grid2x2 size={13} />
          Spawn 4
        </Chip>
        {groupName === null ? (
          <Chip
            testId="command-bar-group"
            title="Group the selected consoles into a project (Ctrl+click to select)"
            active={groupIds.length >= 2}
            onClick={startGroup}
          >
            <Boxes size={13} />
            Group{groupIds.length >= 2 ? ` (${groupIds.length})` : ''}
          </Chip>
        ) : (
          <form
            className="inline-flex h-7 items-center gap-1 rounded-full border border-accent/60 bg-elevated/95 pr-1 pl-3 shadow-lg shadow-black/30"
            onSubmit={(e) => {
              e.preventDefault();
              void createGroup();
            }}
          >
            <Boxes size={13} className="text-accent" />
            <input
              autoFocus
              data-testid="command-bar-group-name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setGroupName(null);
              }}
              placeholder={`Name for ${groupIds.length} agents`}
              className="w-40 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-subtle"
            />
            <button
              type="submit"
              aria-label="Create group"
              disabled={!groupName.trim()}
              className="grid size-5 place-items-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              aria-label="Cancel group"
              onClick={() => setGroupName(null)}
              className="grid size-5 place-items-center rounded-full text-fg-subtle
                         hover:text-fg"
            >
              <X size={12} />
            </button>
          </form>
        )}
        <Chip testId="command-bar-memory" onClick={() => openMemory()}>
          <Brain size={12} />
          Memory
        </Chip>
        <Chip testId="command-bar-mission-map" onClick={() => setMissionMapOpen(true)} hint="M">
          <Network size={13} />
          Mission map
        </Chip>
        <Chip onClick={fitAll} hint="F">
          <Maximize2 size={12} />
          Fit all
        </Chip>
        {workingCount > 0 && (
          <Chip testId="command-bar-pause-all" title="Interrupt every working agent (Shift+P)" onClick={() => void pauseAll()}>
            <Pause size={12} />
            Pause all
          </Chip>
        )}
        {pausedCount > 0 && (
          <Chip testId="command-bar-resume-paused" title={`Type "Continue where you left off." into the ${pausedCount} paused agents`} active onClick={() => void resumePaused()}>
            <Play size={12} />
            Resume all ({pausedCount})
          </Chip>
        )}
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
          className="flex items-end gap-2 rounded-xl border border-line-strong bg-elevated/95 p-1.5 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.75)] backdrop-blur-md transition-colors
                     focus-within:border-accent/70"
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
            className={`inline-flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium
                        hover:border-line-strong
                        ${targetId ? 'border-line bg-surface-2 text-fg' : 'border-dashed border-line-strong text-fg-subtle'}`}
          >
            <span className="font-mono text-[10.5px] text-fg-subtle">to</span>
            {targetId === ALL ? (
              <span className="truncate">all ({readyCount} ready)</span>
            ) : targetProject ? (
              <>
                <Users size={12} className="shrink-0 text-accent" />
                <span className="truncate">{targetProject.name}</span>
              </>
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
            placeholder="Message the selected agent · @ to direct · @all or a team for many"
            onChange={(e) => {
              updateValue(e.target.value, e.target.selectionStart);
              setHistoryIndex(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            className="aa-scroll min-h-8 flex-1 resize-none bg-transparent py-1.5 leading-5 text-fg outline-none placeholder:text-fg-subtle"
          />
          {/* Voice dictation: mic button, hold Space / Alt+V (see DictationButton.tsx) */}
          <DictationButton value={value} setValue={(v) => updateValue(v)} send={send} inputRef={inputRef} />
          <button
            type="button"
            data-testid="command-bar-send"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!value.trim()}
            onClick={send}
            className="aa-btn-primary grid size-8 shrink-0 place-items-center rounded-md disabled:opacity-40"
          >
            <SendHorizontal size={15} />
          </button>
        </div>
      </div>
      {/* Palette-style key hints under the input */}
      <div className="pointer-events-none flex items-center justify-center gap-3 text-[10.5px] text-fg-subtle">
        <span className="inline-flex items-center gap-1"><kbd className="aa-kbd">↵</kbd> send</span>
        <span className="inline-flex items-center gap-1"><kbd className="aa-kbd">⇧</kbd><kbd className="aa-kbd">↵</kbd> new line</span>
        <span className="inline-flex items-center gap-1"><kbd className="aa-kbd">@</kbd> target</span>
        <span className="inline-flex items-center gap-1"><kbd className="aa-kbd">↑</kbd> history</span>
        <span className="inline-flex items-center gap-1"><kbd className="aa-kbd">/</kbd> focus</span>
      </div>
    </div>
  );
}
