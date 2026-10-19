import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRightLeft, Copy, LoaderCircle, Plus, Send, Sparkles, Zap } from 'lucide-react';
import type { ConsoleInfo, HandoffMode, HandoffPreview } from '../../shared/protocol';
import { canType, handoffApi, useHandoffMemory } from '../lib/handoff-memory';
import { useServerSettings } from '../lib/settings';
import { useBoard } from '../lib/store';
import { STATUS_META, basename } from '../lib/status';
import { Modal } from './Modal';

// "Hand off to…": pick a target (or a new agent in the same folder), build a brief, edit it, send it

const toast = (m: string) => useBoard.getState().toast(m);
const NEW = '__new__';

function ModeButton({
  active,
  onClick,
  icon,
  label,
  hint,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={`flex flex-1 items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors
                  ${active ? 'border-accent/70 bg-accent/10' : 'border-line hover:border-line-strong hover:bg-hover'}`}
    >
      <span className={`mt-0.5 ${active ? 'text-accent' : 'text-fg-subtle'}`}>{icon}</span>
      <span>
        <span className="block text-[12.5px] font-semibold text-fg">{label}</span>
        <span className="block text-[11.5px] leading-4 text-fg-subtle">{hint}</span>
      </span>
    </button>
  );
}

function TargetRow({ c, checked, onPick }: { c: ConsoleInfo; checked: boolean; onPick: () => void }) {
  const ok = canType(c);
  const meta = STATUS_META[c.status];
  return (
    <label
      data-testid="handoff-target"
      data-console-id={c.id}
      className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 transition-colors
                  ${checked ? 'border-accent/70 bg-accent/10' : 'border-line'}
                  ${ok ? 'cursor-pointer hover:bg-hover' : 'cursor-not-allowed opacity-50'}`}
      title={ok ? undefined : `${c.name} cannot take typing right now (${meta.label.toLowerCase()})`}
    >
      <input type="radio" name="handoff-target" checked={checked} disabled={!ok} onChange={onPick} className="accent-[var(--aa-accent)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">
          {c.name}
          {c.role && <span className="ml-1.5 text-[11px] font-normal text-fg-subtle">{c.role}</span>}
        </span>
        <span className="block truncate font-mono text-[11px] text-fg-subtle">{basename(c.cwd)}</span>
      </span>
      <span className={`aa-label shrink-0 rounded-full px-2 py-[2px] ${meta.pill}`}>{meta.label}</span>
    </label>
  );
}

export function HandoffDialog({ fromId }: { fromId: string }) {
  const close = useHandoffMemory((s) => s.closeHandoff);
  const consoles = useBoard((s) => s.consoles);
  const from = consoles[fromId];
  const defaultMode = useServerSettings((s) => s.data?.settings.handoffMode) ?? 'quick';
  const others = useMemo(
    () => Object.values(consoles).filter((c) => c.id !== fromId).sort((a, b) => Number(canType(b)) - Number(canType(a))),
    [consoles, fromId],
  );
  const [target, setTarget] = useState<string>(() => others.find(canType)?.id ?? NEW);
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<HandoffMode>(defaultMode);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState<'build' | 'send' | null>(null);
  const [error, setError] = useState('');

  if (!from) return null;
  const isNew = target === NEW;
  const targetName = isNew ? newName.trim() || 'a new agent' : (consoles[target]?.name ?? 'the agent');
  const destination = isNew ? { newAgent: { cwd: from.cwd, ...(newName.trim() ? { name: newName.trim() } : {}) } } : { toId: target };

  const build = async () => {
    setBusy('build');
    setError('');
    try {
      const p = await handoffApi.preview({ fromId, mode, ...(note.trim() ? { note: note.trim() } : {}), ...destination });
      setPreview(p);
      setBrief(p.brief);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy('send');
    setError('');
    try {
      const res = await handoffApi.send({ fromId, brief, ...destination });
      toast(isNew ? `Handing off to ${res.console.name}: the brief is typed in once it is ready` : `Handed off to ${res.console.name}`);
      useBoard.getState().select(res.console.id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const copy = () =>
    void navigator.clipboard?.writeText(brief).then(
      () => toast('Brief copied'),
      () => toast('Could not copy'),
    );

  return (
    <Modal title={`Hand off ${from.name}'s work`} onClose={close} width="max-w-2xl" testId="handoff-dialog">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <ArrowRightLeft size={15} className="text-accent" />
        <h2 className="text-[14px] font-semibold text-fg">
          Hand off {from.name}'s work{preview ? ` to ${targetName}` : ''}
        </h2>
        <span className="ml-auto truncate font-mono text-[11px] text-fg-subtle" title={from.cwd}>
          {basename(from.cwd)}
        </span>
      </div>

      {!preview ? (
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-4 py-4">
          <section>
            <h3 className="aa-label mb-1.5 text-fg-subtle">Hand off to</h3>
            <div className="flex flex-col gap-1.5">
              {others.map((c) => (
                <TargetRow key={c.id} c={c} checked={target === c.id} onPick={() => setTarget(c.id)} />
              ))}
              <label
                data-testid="handoff-target-new"
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 transition-colors hover:bg-hover
                            ${isNew ? 'border-accent/70 bg-accent/10' : 'border-line border-dashed'}`}
              >
                <input type="radio" name="handoff-target" checked={isNew} onChange={() => setTarget(NEW)} className="accent-[var(--aa-accent)]" />
                <Plus size={14} className="text-accent" />
                <span className="text-[13px] font-medium text-fg">New agent here</span>
                {isNew && (
                  <input
                    data-testid="handoff-new-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Name (optional)"
                    className="ml-auto h-7 w-40 rounded-md border border-line bg-canvas px-2 text-[12px] text-fg outline-none focus:border-accent"
                  />
                )}
              </label>
            </div>
          </section>

          <section>
            <h3 className="aa-label mb-1.5 text-fg-subtle">Brief</h3>
            <div className="flex gap-2">
              <ModeButton
                testId="handoff-mode-quick"
                active={mode === 'quick'}
                onClick={() => setMode('quick')}
                icon={<Zap size={14} />}
                label="Quick (free)"
                hint="Built from the transcript: prompts, last status, tasks, files, jobs, git"
              />
              <ModeButton
                testId="handoff-mode-smart"
                active={mode === 'smart'}
                onClick={() => setMode('smart')}
                icon={<Sparkles size={14} />}
                label="Smart (uses Claude)"
                hint="The quick brief summarized by Haiku with claude -p on this agent's account"
              />
            </div>
          </section>

          <section>
            <h3 className="aa-label mb-1.5 text-fg-subtle">Note for {targetName} (optional)</h3>
            <textarea
              data-testid="handoff-note"
              data-autofocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What should it do next? Decisions, gotchas…"
              className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
            />
          </section>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-4 py-4">
          {preview.warning && (
            <p data-testid="handoff-warning" className="rounded-md border border-needs/40 bg-needs/10 px-3 py-1.5 text-[12px] text-needs">
              {preview.warning}
            </p>
          )}
          <div className="flex items-center gap-2 text-[11.5px] text-fg-subtle">
            {preview.mode === 'smart' ? <Sparkles size={12} /> : <Zap size={12} />}
            {preview.mode === 'smart' ? 'Smart brief' : 'Quick brief'} · edit it before sending · {brief.length} characters
          </div>
          <textarea
            data-testid="handoff-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            spellCheck={false}
            className="h-[48vh] w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-[18px] text-fg outline-none focus:border-accent"
          />
        </div>
      )}

      {error && (
        <p data-testid="handoff-error" className="px-4 pb-2 text-[12px] text-error">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        {preview ? (
          <>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <ArrowLeft size={13} /> Back
            </button>
            <button
              type="button"
              data-testid="handoff-copy"
              onClick={copy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <Copy size={13} /> Copy
            </button>
          </>
        ) : null}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={close}
          className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
        {preview ? (
          <button
            type="button"
            data-testid="handoff-send"
            disabled={!brief.trim() || busy !== null}
            onClick={() => void send()}
            className="aa-btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold disabled:opacity-50"
          >
            {busy === 'send' ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}
            Send to {targetName}
          </button>
        ) : (
          <button
            type="button"
            data-testid="handoff-build"
            disabled={busy !== null}
            onClick={() => void build()}
            className="aa-btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold disabled:opacity-50"
          >
            {busy === 'build' ? <LoaderCircle size={13} className="animate-spin" /> : <ArrowRightLeft size={13} />}
            {busy === 'build' ? (mode === 'smart' ? 'Asking Claude…' : 'Building…') : 'Build brief'}
          </button>
        )}
      </div>
    </Modal>
  );
}
