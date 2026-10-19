import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, CircleAlert, LoaderCircle, Repeat2, Sparkles, Zap } from 'lucide-react';
import type { HandoffMode } from '../../shared/protocol';
import { flyTo } from '../lib/board-actions';
import {
  isOrchestratorReady,
  providerKinds,
  providerLabel,
  providerShort,
  READINESS_TEXT,
  readinessOf,
  type ProviderKind,
} from '../lib/provider-readiness';
import { useServerSettings } from '../lib/settings';
import { STATUS_META, basename } from '../lib/status';
import { useBoard } from '../lib/store';
import {
  STEP_ORDER,
  agentOf,
  canSwitch,
  stepAfterResponse,
  stepLabel,
  switchAgentApi,
  useSwitchAgent,
  type SwitchStep,
} from '../lib/switch-agent';
import { AgentIcon } from './AgentIcon';
import { Modal } from './Modal';
import { FixLink, ModelField, ProviderAccountSelect, ReadinessDots, useLoadProviders } from './ProviderPicker';

// "Switch agent…": pick the target CLI, account, model and brief mode; see what will happen; watch
// each console move (Building brief -> Starting Codex -> Sending brief -> Done) and fly to the result.

interface Progress {
  step: SwitchStep;
  newId?: string;
  jobId?: string;
  error?: string;
  warning?: string;
}

const STEP_TIMEOUT_MS = 120_000;

function ProviderCard({
  kind,
  active,
  current,
  onPick,
}: {
  kind: ProviderKind;
  active: boolean;
  current: boolean;
  onPick: () => void;
}) {
  const providers = useLoadProviders();
  const readiness = readinessOf(providers?.find((p) => p.id === kind), kind);
  const disabled = readiness === 'not_installed';
  return (
    <div
      className={`relative flex flex-col rounded-xl border px-3 py-2 transition-colors
                  ${active ? 'border-accent/70 bg-accent/10' : 'border-line bg-surface'}
                  ${disabled ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={active}
        disabled={disabled}
        data-testid={`switch-target-${kind}`}
        data-readiness={readiness}
        onClick={onPick}
        className="flex items-center gap-2 text-left disabled:cursor-not-allowed"
      >
        <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${active ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-fg-muted'}`}>
          <AgentIcon agent={kind} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-fg">{providerShort(kind)}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <ReadinessDots kind={kind} />
            {current ? 'Current' : READINESS_TEXT[readiness]}
          </span>
        </span>
      </button>
      {(readiness === 'not_installed' || readiness === 'logged_out') && (
        <span className="mt-1 -ml-1">
          <FixLink kind={kind} readiness={readiness} />
        </span>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, icon, label, hint, testId }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; hint: string; testId: string }) {
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

function StepTrail({ step, target }: { step: SwitchStep; target: string }) {
  const at = step === 'queued' ? -1 : STEP_ORDER.indexOf(step === 'error' ? 'brief' : step);
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px]" data-testid="switch-steps" data-step={step}>
      {STEP_ORDER.map((s, i) => {
        const done = step === 'done' || (step !== 'error' && i < at);
        const now = step !== 'done' && step !== 'error' && i === at;
        return (
          <li key={s} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className={`h-px w-3 ${done || now ? 'bg-accent/60' : 'bg-line'}`} />}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-[1px]
                          ${done ? 'bg-project-green/12 text-project-green' : now ? 'bg-accent/12 text-accent' : 'text-fg-subtle ring-1 ring-line'}`}
            >
              {done ? <Check size={11} /> : now ? <LoaderCircle size={11} className="animate-spin" /> : null}
              {stepLabel(s, target)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function SwitchAgentDialog({ ids }: { ids: string[] }) {
  const close = useSwitchAgent((s) => s.close);
  const consoles = useBoard((s) => s.consoles);
  const jobs = useBoard((s) => s.jobs);
  const providers = useLoadProviders();
  const sources = useMemo(() => ids.map((id) => consoles[id]).filter((c) => c && canSwitch(c)), [ids, consoles]);
  // Captured once: the old consoles disappear from the store when they are closed
  const [initial] = useState(() => ids.map((id) => useBoard.getState().consoles[id]).filter((c) => c && canSwitch(c)));
  const currentKinds = new Set(initial.map(agentOf));
  const single = initial.length === 1 ? initial[0] : null;
  const defaultMode = useServerSettings((s) => s.data?.settings.handoffMode) ?? 'quick';

  const [target, setTarget] = useState<ProviderKind>(() => {
    const ready = providerKinds().filter((k) => !currentKinds.has(k));
    return ready.includes('codex') ? 'codex' : ready.includes('claude') ? 'claude' : (ready[0] ?? 'codex');
  });
  const [accountId, setAccountId] = useState('auto');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<HandoffMode>(defaultMode);
  const [closeOld, setCloseOld] = useState(true);
  const [progress, setProgress] = useState<Record<string, Progress> | null>(null);
  const flown = useRef(false);

  const readiness = readinessOf(providers?.find((p) => p.id === target), target);
  const blocked = readiness === 'not_installed';
  const allSame = initial.every((c) => agentOf(c) === target);
  const running = progress !== null && Object.values(progress).some((p) => p.step !== 'done' && p.step !== 'error');
  const finished = progress !== null && !running;

  // Advance each switched console from the store (new console status, brief job, old one gone)
  useEffect(() => {
    if (!progress) return;
    let changed = false;
    const next = { ...progress };
    for (const [oldId, p] of Object.entries(progress)) {
      if (!p.newId || p.step === 'done' || p.step === 'error') continue;
      const step = stepAfterResponse(consoles[p.newId], p.jobId ? jobs[p.jobId] : undefined, !consoles[oldId], closeOld);
      if (step !== p.step) {
        next[oldId] = { ...p, step };
        changed = true;
      }
    }
    if (changed) setProgress(next);
  }, [consoles, jobs, progress, closeOld]);

  // A brief that is never picked up (the CLI waits on a trust prompt…) should not spin forever
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      setProgress((p) =>
        p ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.step === 'starting' || v.step === 'sending' ? { ...v, step: 'done' as const, warning: v.warning ?? 'Still starting: the brief is typed in once it is ready' } : v])) : p,
      );
    }, STEP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [running]);

  // Fly to the new console(s) once everything moved
  useEffect(() => {
    if (!finished || flown.current || !progress) return;
    flown.current = true;
    const created = Object.values(progress).filter((p) => p.newId && p.step === 'done');
    const last = created.at(-1)?.newId;
    if (last) void flyTo(last);
    const failed = Object.values(progress).filter((p) => p.step === 'error').length;
    if (!failed) {
      useBoard.getState().toast(created.length === 1 ? `Switched to ${providerShort(target)}` : `Switched ${created.length} agents to ${providerShort(target)}`);
      window.setTimeout(close, 900);
    }
  }, [finished, progress, target, close]);

  const start = async () => {
    if (blocked || running) return;
    const list = initial.filter((c) => agentOf(c) !== target);
    const init: Record<string, Progress> = Object.fromEntries(list.map((c) => [c.id, { step: 'queued' as SwitchStep }]));
    setProgress(init);
    // One at a time: each switch types into a fresh console and may close the old one
    for (const c of list) {
      setProgress((p) => ({ ...(p ?? {}), [c.id]: { step: 'brief' } }));
      try {
        const res = await switchAgentApi.switch(c.id, {
          agent: target,
          ...(accountId && accountId !== 'auto' ? { accountId } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          closeOld,
          briefMode: mode,
        });
        useBoard.getState().upsertConsole(res.console);
        useBoard.getState().upsertJob(res.job);
        setProgress((p) => ({ ...(p ?? {}), [c.id]: { step: 'starting', newId: res.console.id, jobId: res.job.id, warning: res.warning } }));
      } catch (e) {
        setProgress((p) => ({ ...(p ?? {}), [c.id]: { step: 'error', error: (e as Error).message } }));
      }
    }
  };

  if (!initial.length) {
    return (
      <Modal title="Switch agent" onClose={close} width="max-w-md" testId="switch-agent-dialog">
        <p className="px-5 py-6 text-fg-muted">Custom command consoles cannot be switched: there is no conversation to hand off.</p>
      </Modal>
    );
  }

  const title = single ? `Switch ${single.name} to another AI` : `Switch ${initial.length} agents to another AI`;
  const fromLabel = single ? providerShort(agentOf(single)) : currentKinds.size === 1 ? providerShort([...currentKinds][0]) : 'several AIs';

  return (
    <Modal title={title} onClose={close} width="max-w-2xl" testId="switch-agent-dialog">
      <div className="aa-card-glow flex items-center gap-3 border-b border-line px-5 pt-4 pb-3">
        <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent">
          <Repeat2 size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <p className="mt-0.5 truncate text-fg-muted">
            {single ? (
              <>
                Now on <span className="font-medium text-fg">{providerLabel(agentOf(single))}</span> · {basename(single.cwd)}
              </>
            ) : (
              `${initial.map((c) => c.name).join(', ')} · now on ${fromLabel}`
            )}
          </p>
        </div>
      </div>

      {!progress ? (
        <div className="flex max-h-[64vh] flex-col gap-4 overflow-y-auto px-5 py-4">
          <section>
            <h3 className="aa-label mb-1.5 text-fg-subtle">Switch to</h3>
            <div role="radiogroup" aria-label="Target AI" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {providerKinds().map((kind) => (
                <ProviderCard
                  key={kind}
                  kind={kind}
                  active={target === kind}
                  current={single ? agentOf(single) === kind : false}
                  onPick={() => {
                    setTarget(kind);
                    setModel('');
                    setAccountId('auto');
                  }}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex min-w-0 items-center gap-2 text-[12px] text-fg-muted">
              <span className="aa-label text-fg-subtle">Model</span>
              <ModelField kind={target} value={model} onChange={setModel} className="w-52" testId="switch-model" />
            </label>
            <ProviderAccountSelect kind={target} value={accountId} onChange={setAccountId} testId="switch-account" />
          </section>

          <section>
            <h3 className="aa-label mb-1.5 text-fg-subtle">Handoff brief</h3>
            <div className="flex gap-2">
              <ModeButton
                testId="switch-mode-quick"
                active={mode === 'quick'}
                onClick={() => setMode('quick')}
                icon={<Zap size={14} />}
                label="Quick (free)"
                hint="Built from the transcript: prompts, status, tasks, files, git"
              />
              <ModeButton
                testId="switch-mode-smart"
                active={mode === 'smart'}
                onClick={() => setMode('smart')}
                icon={<Sparkles size={14} />}
                label="Smart (uses Claude)"
                hint="The quick brief summarized by Haiku with claude -p"
              />
            </div>
          </section>

          <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-fg select-none">
            <input
              type="checkbox"
              data-testid="switch-close-old"
              checked={closeOld}
              onChange={(e) => setCloseOld(e.target.checked)}
              className="mt-0.5 accent-[var(--aa-accent)]"
            />
            <span>
              Close the old agent after the handoff
              <span className="block text-[11.5px] text-fg-subtle">
                {closeOld ? 'Its conversation stays on disk; you can resume it later.' : 'Both keep running side by side.'}
              </span>
            </span>
          </label>

          <div data-testid="switch-preview" className="rounded-xl border border-line bg-canvas/60 px-3.5 py-2.5">
            {(single ? [single] : initial.slice(0, 4)).map((c) => (
              <div key={c.id} className="flex min-w-0 items-center gap-2 text-[12.5px]">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-muted">
                  <AgentIcon agent={agentOf(c)} size={12} />
                  <span className="truncate font-medium text-fg">{c.name}</span>({providerShort(agentOf(c))})
                </span>
                <ArrowRight size={13} className="shrink-0 text-accent" />
                <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-muted">
                  <AgentIcon agent={target} size={12} className="text-accent" />
                  <span className="truncate font-medium text-fg">{c.name}</span>({providerShort(target)})
                </span>
                {agentOf(c) === target && <span className="text-[11px] text-fg-subtle">already there, skipped</span>}
              </div>
            ))}
            {!single && initial.length > 4 && <div className="text-[11.5px] text-fg-subtle">and {initial.length - 4} more</div>}
            <p className="mt-1 text-[11.5px] text-fg-subtle">
              Same folder, same spot on the board, same name and role; {single ? 'it gets' : 'each gets'} a {mode === 'smart' ? 'smart' : 'quick'} handoff brief
              {closeOld ? ', then the old one closes.' : '. The old one keeps running.'}
            </p>
            {initial.some((c) => c.role === 'Orchestrator') && !isOrchestratorReady(target) && (
              <p className="mt-1 flex items-center gap-1 text-[11.5px] text-needs">
                <CircleAlert size={12} /> Orchestrator jobs need the agentarmy MCP tools (verified on Claude Code and Codex): limited on {providerShort(target)}.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex max-h-[64vh] flex-col gap-2 overflow-y-auto px-5 py-4" data-testid="switch-progress">
          {initial
            .filter((c) => progress[c.id])
            .map((c) => {
              const p = progress[c.id];
              return (
                <div key={c.id} className="rounded-xl border border-line bg-surface px-3 py-2">
                  <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
                    <AgentIcon agent={agentOf(c)} size={12} className="text-fg-muted" />
                    <span className="font-medium text-fg">{c.name}</span>
                    <ArrowRight size={12} className="text-accent" />
                    <AgentIcon agent={target} size={12} className="text-accent" />
                    <span className="text-fg-muted">{providerShort(target)}</span>
                    {p.newId && consoles[p.newId] && (
                      <span className={`aa-label ml-auto rounded-full px-2 py-[1px] ${STATUS_META[consoles[p.newId].status].pill}`}>
                        {STATUS_META[consoles[p.newId].status].label}
                      </span>
                    )}
                  </div>
                  <StepTrail step={p.step} target={providerShort(target)} />
                  {p.error && (
                    <p data-testid="switch-error" className="mt-1.5 text-[12px] text-error">
                      {p.error}
                    </p>
                  )}
                  {p.warning && <p className="mt-1.5 text-[11.5px] text-needs">{p.warning}</p>}
                </div>
              );
            })}
          {sources.length === 0 && finished && <p className="text-[11.5px] text-fg-subtle">The old consoles were closed.</p>}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
        {blocked && !progress && (
          <span className="inline-flex items-center gap-1 text-[12px] text-needs">
            {providerShort(target)} is not installed <FixLink kind={target} readiness="not_installed" />
          </span>
        )}
        <span className="ml-auto" />
        <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 font-medium text-fg-muted hover:bg-hover hover:text-fg">
          {finished ? 'Close' : 'Cancel'}
        </button>
        {!progress && (
          <button
            type="button"
            data-testid="switch-start"
            disabled={blocked || allSame}
            onClick={() => void start()}
            className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
          >
            <Repeat2 size={13} />
            {single ? `Switch to ${providerShort(target)}` : `Switch ${initial.filter((c) => agentOf(c) !== target).length} to ${providerShort(target)}`}
          </button>
        )}
      </div>
    </Modal>
  );
}

// Mounted once (HandoffMemoryHost)
export function SwitchAgentHost() {
  const ids = useSwitchAgent((s) => s.ids);
  return ids ? <SwitchAgentDialog key={ids.join(',')} ids={ids} /> : null;
}
