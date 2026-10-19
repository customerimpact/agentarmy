import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Brain, Eye, FolderOpen, Globe, LoaderCircle, PencilLine, RefreshCw, Save, Send } from 'lucide-react';
import type { ConsoleInfo, MemoryDoc, MemoryScope } from '../../shared/protocol';
import { canType, consoleFolder, memoryApi, sameFolder, useHandoffMemory } from '../lib/handoff-memory';
import { useBoard } from '../lib/store';
import { STATUS_META, basename } from '../lib/status';
import { Modal } from './Modal';

// Project memory: global and per-folder markdown notes, pushed into agents on demand
// (or automatically into new agents in that folder)

const toast = (m: string) => useBoard.getState().toast(m);

interface Entry {
  key: string; // 'global' or the folder path
  scope: MemoryScope;
  folder: string | null;
  consoles: ConsoleInfo[];
  hasMemory: boolean;
}

// Tiny markdown preview: headings, lists, checkboxes, code fences, inline code and bold. No HTML.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
      return <code key={i} className="rounded bg-canvas px-1 font-mono text-[11.5px]">{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

export function MarkdownPreview({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      blocks.push(<pre key={i} className="my-1.5 overflow-x-auto rounded-md bg-canvas p-2 font-mono text-[11.5px]">{code.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const size = h[1].length === 1 ? 'text-[16px]' : h[1].length === 2 ? 'text-[14.5px]' : 'text-[13px]';
      blocks.push(<p key={i} className={`mt-2.5 mb-1 font-semibold text-fg ${size}`}>{inline(h[2])}</p>);
      continue;
    }
    const li = /^\s*[-*]\s+(\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (li) {
      const box = li[1] ? (li[2] === ' ' ? '☐ ' : '☑ ') : '• ';
      blocks.push(<p key={i} className="pl-3 -indent-3 leading-5">{box}{inline(li[3])}</p>);
      continue;
    }
    blocks.push(line.trim() ? <p key={i} className="leading-5">{inline(line)}</p> : <div key={i} className="h-2" />);
  }
  return <div data-testid="memory-preview" className="text-[13px] text-fg-muted">{blocks}</div>;
}

function useEntries(serverFolders: MemoryDoc[]): Entry[] {
  const consoles = useBoard((s) => s.consoles);
  return useMemo(() => {
    const list = Object.values(consoles);
    const entries: Entry[] = [{ key: 'global', scope: 'global', folder: null, consoles: list, hasMemory: false }];
    const add = (folder: string, hasMemory: boolean) => {
      const existing = entries.find((e) => e.folder && sameFolder(e.folder, folder));
      if (existing) existing.hasMemory ||= hasMemory;
      else entries.push({ key: folder, scope: 'folder', folder, consoles: [], hasMemory });
    };
    for (const c of list) add(consoleFolder(c), false);
    for (const d of serverFolders) if (d.path) add(d.path, d.content.trim().length > 0);
    for (const e of entries) if (e.folder) e.consoles = list.filter((c) => sameFolder(consoleFolder(c), e.folder!));
    return entries;
  }, [consoles, serverFolders]);
}

function PushPicker({
  entry,
  onCancel,
  onPush,
  busy,
}: {
  entry: Entry;
  onCancel: () => void;
  onPush: (ids: string[]) => void;
  busy: boolean;
}) {
  const all = Object.values(useBoard((s) => s.consoles));
  const [picked, setPicked] = useState<string[]>(() => entry.consoles.filter(canType).map((c) => c.id));
  const [confirming, setConfirming] = useState(false);
  const toggle = (id: string) => {
    setConfirming(false);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };
  const ordered = [...entry.consoles, ...all.filter((c) => !entry.consoles.includes(c))];
  return (
    <div data-testid="memory-push-picker" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <p className="text-[12px] text-fg-muted">
        Types <span className="font-mono text-fg">Project memory (from AgentArmy):</span> and this memory into each agent you pick.
      </p>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {ordered.map((c) => {
          const ok = canType(c);
          return (
            <label
              key={c.id}
              data-testid="memory-push-target"
              data-console-id={c.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] ${ok ? 'cursor-pointer hover:bg-hover' : 'opacity-50'}`}
            >
              <input type="checkbox" disabled={!ok} checked={picked.includes(c.id)} onChange={() => toggle(c.id)} className="accent-[var(--aa-accent)]" />
              <span className="font-medium text-fg">{c.name}</span>
              <span className="truncate font-mono text-[11px] text-fg-subtle">{basename(c.cwd)}</span>
              <span className={`aa-label ml-auto shrink-0 rounded-full px-2 py-[1px] ${STATUS_META[c.status].pill}`}>{STATUS_META[c.status].label}</span>
            </label>
          );
        })}
        {!ordered.length && <p className="text-[12px] text-fg-subtle">No agents on the board.</p>}
      </div>
      <div className="flex items-center gap-2">
        <span className="ml-auto" />
        <button type="button" onClick={onCancel} className="h-7 rounded-md px-2.5 text-[12px] text-fg-muted hover:bg-hover hover:text-fg">
          Cancel
        </button>
        <button
          type="button"
          data-testid="memory-push-confirm"
          disabled={!picked.length || busy}
          onClick={() => (picked.length > 2 && !confirming ? setConfirming(true) : onPush(picked))}
          className="aa-btn-primary inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold disabled:opacity-50"
        >
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Send size={12} />}
          {confirming ? `Yes, push to all ${picked.length}` : `Push to ${picked.length} ${picked.length === 1 ? 'agent' : 'agents'}`}
        </button>
      </div>
    </div>
  );
}

export function MemoryPanel() {
  const close = useHandoffMemory((s) => s.closeMemory);
  const initialFolder = useHandoffMemory((s) => s.memoryFolder);
  const [serverFolders, setServerFolders] = useState<MemoryDoc[]>([]);
  const entries = useEntries(serverFolders);
  const [selected, setSelected] = useState<string>(initialFolder ?? 'global');
  const entry = entries.find((e) => e.key === selected || (e.folder && sameFolder(e.folder, selected))) ?? entries[0];
  const [loaded, setLoaded] = useState<{ key: string; doc: MemoryDoc } | null>(null);
  // Only the doc of the selected entry counts; right after a switch the old one is still in state
  const doc = loaded?.key === entry.key ? loaded.doc : null;
  const setDoc = (d: MemoryDoc) => setLoaded({ key: entry.key, doc: d });
  const loadSeq = useRef(0);
  const [draft, setDraft] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'push' | null>(null);
  const [error, setError] = useState('');
  const dirty = doc !== null && draft !== doc.content;

  const refreshFolders = useCallback(() => {
    memoryApi.folders().then(setServerFolders, () => undefined);
  }, []);
  useEffect(refreshFolders, [refreshFolders]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const key = entry.key;
    setError('');
    setLoaded(null);
    try {
      const d = await memoryApi.get(entry.scope, entry.folder);
      if (seq !== loadSeq.current) return;
      setLoaded({ key, doc: d });
      setDraft(d.content);
    } catch (e) {
      if (seq === loadSeq.current) setError((e as Error).message);
    }
  }, [entry.key, entry.scope, entry.folder]);
  useEffect(() => {
    setPushing(false);
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    setBusy('save');
    try {
      const d = await memoryApi.put(entry.scope, entry.folder, { content: draft });
      setDoc(d);
      refreshFolders();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const setAutoPush = async (autoPush: boolean) => {
    if (doc) setDoc({ ...doc, autoPush }); // optimistic, so the checkbox follows the click
    try {
      setDoc(await memoryApi.put(entry.scope, entry.folder, { autoPush }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const push = async (ids: string[]) => {
    if (dirty && !(await save())) return;
    setBusy('push');
    try {
      const res = await memoryApi.push({ scope: entry.scope, ...(entry.folder ? { path: entry.folder } : {}), consoleIds: ids });
      const skipped = res.skipped.length ? ` (${res.skipped.length} skipped)` : '';
      toast(`Memory pushed to ${res.sent.length} ${res.sent.length === 1 ? 'agent' : 'agents'}${skipped}`);
      setPushing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pick = (key: string) => {
    if (dirty) void save();
    setSelected(key);
  };

  const title = entry.scope === 'global' ? 'Global memory' : basename(entry.folder!);
  return (
    <Modal title="Project memory" onClose={close} width="max-w-4xl" testId="memory-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Brain size={15} className="text-accent" />
        <h2 className="text-[14px] font-semibold text-fg">Project memory</h2>
        <span className="text-[12px] text-fg-subtle">Notes you push into agents. Agents can read and add to them too.</span>
      </div>
      <div className="flex h-[62vh] min-h-0">
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
          {entries.map((e) => (
            <button
              key={e.key}
              type="button"
              data-testid="memory-scope"
              data-scope={e.scope}
              data-folder={e.folder ?? undefined}
              aria-pressed={e === entry}
              onClick={() => pick(e.key)}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors
                          ${e === entry ? 'bg-accent/10 text-fg ring-1 ring-accent/40' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
              title={e.folder ?? 'Applies to every project'}
            >
              {e.scope === 'global' ? <Globe size={13} className="shrink-0 text-accent" /> : <FolderOpen size={13} className="shrink-0 text-fg-subtle" />}
              <span className="min-w-0 flex-1 truncate">{e.scope === 'global' ? 'Global' : basename(e.folder!)}</span>
              {e.scope === 'folder' && e.consoles.length > 0 && (
                <span className="shrink-0 text-[10.5px] text-fg-subtle tabular-nums">{e.consoles.length}</span>
              )}
              {e.hasMemory && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />}
            </button>
          ))}
        </nav>
        <section className="flex min-w-0 flex-1 flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <div className="min-w-0">
              <p data-testid="memory-title" className="truncate text-[13.5px] font-semibold text-fg">{title}</p>
              <p className="truncate font-mono text-[11px] text-fg-subtle">{entry.folder ?? 'Applies to every project'}</p>
            </div>
            <span className="ml-auto" />
            <button
              type="button"
              title="Reload (agents may have added to it)"
              aria-label="Reload"
              onClick={() => void load()}
              className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              data-testid="memory-preview-toggle"
              onClick={() => setPreviewing((p) => !p)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              {previewing ? <PencilLine size={12} /> : <Eye size={12} />}
              {previewing ? 'Edit' : 'Preview'}
            </button>
          </div>
          {doc === null && !error ? (
            <div className="grid flex-1 place-items-center text-fg-subtle"><LoaderCircle size={16} className="animate-spin" /></div>
          ) : previewing ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface px-3 py-2">
              {draft.trim() ? <MarkdownPreview text={draft} /> : <p className="text-[12.5px] text-fg-subtle">Nothing here yet.</p>}
            </div>
          ) : (
            <textarea
              data-testid="memory-editor"
              data-autofocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              placeholder={
                entry.scope === 'global'
                  ? '# How I like to work\n- Run the tests before saying done\n- Keep commits small'
                  : '# This project\n- Start the app with npm run dev\n- Tests: npx vitest run'
              }
              className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12.5px] leading-[19px] text-fg outline-none focus:border-accent"
            />
          )}
          {pushing && <PushPicker entry={entry} busy={busy === 'push'} onCancel={() => setPushing(false)} onPush={(ids) => void push(ids)} />}
          {error && <p className="text-[12px] text-error">{error}</p>}
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted">
              <input
                type="checkbox"
                data-testid="memory-autopush"
                checked={doc?.autoPush ?? false}
                disabled={!doc}
                onChange={(e) => void setAutoPush(e.target.checked)}
                className="accent-[var(--aa-accent)]"
              />
              {entry.scope === 'global' ? 'Push automatically to every new agent' : 'Push automatically to new agents in this folder'}
            </label>
            <span className="ml-auto" />
            <button
              type="button"
              data-testid="memory-save"
              disabled={!dirty || busy !== null}
              onClick={() => void save().then((ok) => ok && toast('Memory saved'))}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-[12.5px] text-fg hover:bg-hover disabled:opacity-50"
            >
              {busy === 'save' ? <LoaderCircle size={13} className="animate-spin" /> : <Save size={13} />}
              {dirty ? 'Save' : 'Saved'}
            </button>
            <button
              type="button"
              data-testid="memory-push"
              disabled={!draft.trim() || busy !== null}
              onClick={() => setPushing(true)}
              className="aa-btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold disabled:opacity-50"
            >
              <Send size={13} /> Push to agent(s)…
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
