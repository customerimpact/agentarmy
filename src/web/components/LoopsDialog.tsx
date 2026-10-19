import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Bot,
  Clock,
  Flag,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  ScanText,
  Target,
  Terminal,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { Loop, LoopGoal, LoopInput, LoopStop, LoopTarget, LoopTrigger } from '../../shared/protocol';
import { LOOP_SCHEDULE_PRESETS, loopSummary, matcherError, type LoopNames } from '../../shared/loops';
import { loopsApi, useLoops } from '../lib/loops';
import { relativeTime } from '../lib/fleet';
import { consoleList, useBoard, useClock } from '../lib/store';
import { ComposerDialog } from './ComposerDialog';
import { Modal } from './Modal';
import { StatusDot } from './StatusDot';

function useLoopNames(): LoopNames {
  const consoles = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  return useMemo(
    () => ({ console: (id) => consoles[id]?.name, project: (id) => projects[id]?.name }),
    [consoles, projects],
  );
}

const fail = (what: string) => (error: unknown) => useBoard.getState().toast(`${what} failed: ${(error as Error).message}`);

// ---------- List ----------

function loopState(loop: Loop): { label: string; tone: string } {
  if (loop.enabled) return { label: 'Active', tone: 'bg-resting/12 text-resting ring-resting/30' };
  if (loop.retiredAt) return { label: 'Retired', tone: 'bg-hover text-fg-muted ring-line-strong' };
  return { label: 'Paused', tone: 'bg-project-amber/12 text-project-amber ring-project-amber/35' };
}

function IconButton({ label, onClick, children, testId, danger }: { label: string; onClick: () => void; children: ReactNode; testId?: string; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded-md text-fg-subtle
                  hover:bg-hover ${danger ? 'hover:text-error' : 'hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

function LoopRow({ loop, names, now }: { loop: Loop; names: LoopNames; now: number }) {
  const { upsert, remove, setEditing } = useLoops.getState();
  const state = loopState(loop);
  const last = loop.history?.at(-1);
  const toggle = () => loopsApi.update(loop.id, { enabled: !loop.enabled }).then(upsert).catch(fail('Update loop'));
  const runNow = () => loopsApi.runNow(loop.id).then(upsert).catch(fail('Run loop'));
  const del = () =>
    useBoard.getState().askConfirm({
      title: `Delete loop ${loop.name}?`,
      message: 'It stops and its run history is removed.',
      confirmLabel: 'Delete loop',
      danger: true,
      onConfirm: () => loopsApi.remove(loop.id).then(() => remove(loop.id)).catch(fail('Delete loop')),
    });
  return (
    <li
      data-testid="loop-row"
      data-loop-id={loop.id}
      data-enabled={loop.enabled}
      className="group rounded-xl border border-line bg-surface px-3.5 py-3
                 hover:border-line-strong"
    >
      <div className="flex items-center gap-2">
        <Repeat size={14} className={loop.enabled ? 'text-accent' : 'text-fg-subtle'} />
        <span className="truncate font-semibold text-fg">{loop.name}</span>
        <span className={`aa-label shrink-0 rounded-full px-2 py-[1px] ring-1 ${state.tone}`}>{state.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label="Run now" testId="loop-run-now" onClick={() => void runNow()}>
            <Zap size={14} />
          </IconButton>
          <IconButton label={loop.enabled ? 'Pause loop' : 'Resume loop'} testId="loop-toggle" onClick={() => void toggle()}>
            {loop.enabled ? <Pause size={14} /> : <Play size={14} />}
          </IconButton>
          <IconButton label="Edit loop" testId="loop-edit" onClick={() => setEditing({ id: loop.id })}>
            <Pencil size={13} />
          </IconButton>
          <IconButton label="Delete loop" testId="loop-delete" danger onClick={del}>
            <Trash2 size={13} />
          </IconButton>
        </span>
      </div>
      <p data-testid="loop-summary" className="mt-1 text-[12.5px] leading-[18px] text-fg-muted">
        {loopSummary(loop, names)}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-fg-subtle tabular-nums">
        <span data-testid="loop-runs">
          {loop.runs} {loop.runs === 1 ? 'run' : 'runs'}
        </span>
        {loop.lastRunAt && <span>last {relativeTime(loop.lastRunAt, now)}</span>}
        {loop.retiredReason && <span>retired: {loop.retiredReason}</span>}
        {loop.lastGoal && (
          <span className={loop.lastGoal.met ? 'text-resting' : 'text-needs'}>
            goal {loop.lastGoal.met ? 'met' : 'not met'} · {loop.lastGoal.detail}
          </span>
        )}
        {last && !last.note?.startsWith('Retired') && (
          <span className="truncate">
            {last.sentTo.length ? `sent to ${last.sentTo.join(', ')}` : last.note}
            {last.skipped.length > 0 && ` · skipped ${last.skipped.join(', ')}`}
          </span>
        )}
      </div>
    </li>
  );
}

function LoopList() {
  const loops = useLoops((s) => s.loops);
  const names = useLoopNames();
  const now = useClock((s) => s.now);
  const list = Object.values(loops).sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.createdAt - a.createdAt);
  return (
    <div className="aa-scroll max-h-[64vh] overflow-y-auto p-4">
      {list.length === 0 ? (
        <div className="py-12 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-accent/12 text-accent">
            <Repeat size={20} />
          </span>
          <p className="mt-3 font-semibold text-fg">No loops yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-fg-muted">
            A loop types a prompt into your agents on a schedule, when they go idle, or when their output says
            something, until a goal is met.
          </p>
          <button
            type="button"
            data-testid="loop-new-empty"
            onClick={() => useLoops.getState().setEditing({ id: 'new' })}
            className="aa-btn-primary mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold"
          >
            <Plus size={14} />
            New loop
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((l) => (
            <LoopRow key={l.id} loop={l} names={names} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Editor ----------

type WhenKind = LoopTrigger['kind'];
type TargetKind = LoopTarget['kind'];

interface Draft {
  name: string;
  prompt: string;
  when: WhenKind;
  everyMinutes: number;
  idleValue: number;
  idleUnit: 's' | 'min';
  match: string;
  target: TargetKind;
  projectId: string;
  consoleIds: string[];
  useRuns: boolean;
  afterRuns: number;
  useMinutes: boolean;
  afterMinutes: number;
  useGoal: boolean;
  goalKind: LoopGoal['kind'];
  command: string;
  commandCwd: string;
  goalDescription: string;
}

function draftFrom(loop: Loop | null, preset: { projectId?: string; consoleIds?: string[] }): Draft {
  const t = loop?.trigger;
  const target = loop?.target;
  const goal = loop?.stop.whenGoal;
  const idleSeconds = t?.kind === 'idle' ? t.afterSeconds : 60;
  return {
    name: loop?.name ?? '',
    prompt: loop?.prompt ?? '',
    when: t?.kind ?? 'schedule',
    everyMinutes: t?.kind === 'schedule' ? t.everyMinutes : 15,
    idleValue: idleSeconds % 60 === 0 ? idleSeconds / 60 : idleSeconds,
    idleUnit: idleSeconds % 60 === 0 ? 'min' : 's',
    match: t?.kind === 'output' ? t.match : '',
    target: target?.kind ?? (preset.consoleIds?.length ? 'consoles' : preset.projectId ? 'project' : 'all'),
    projectId: target?.kind === 'project' ? target.id : (preset.projectId ?? ''),
    consoleIds: target?.kind === 'consoles' ? target.ids : (preset.consoleIds ?? []),
    useRuns: !!loop?.stop.afterRuns,
    afterRuns: loop?.stop.afterRuns ?? 10,
    useMinutes: !!loop?.stop.afterMinutes,
    afterMinutes: loop?.stop.afterMinutes ?? 120,
    useGoal: !!goal,
    goalKind: goal?.kind ?? 'command',
    command: goal?.kind === 'command' ? goal.command : '',
    commandCwd: goal?.kind === 'command' ? (goal.cwd ?? '') : '',
    goalDescription: goal?.description ?? '',
  };
}

function toInput(d: Draft): LoopInput & { stop: LoopStop } {
  const trigger: LoopTrigger =
    d.when === 'schedule'
      ? { kind: 'schedule', everyMinutes: d.everyMinutes }
      : d.when === 'idle'
        ? { kind: 'idle', afterSeconds: Math.round(d.idleValue * (d.idleUnit === 'min' ? 60 : 1)) }
        : { kind: 'output', match: d.match.trim() };
  const target: LoopTarget =
    d.target === 'all' ? { kind: 'all' } : d.target === 'project' ? { kind: 'project', id: d.projectId } : { kind: 'consoles', ids: d.consoleIds };
  const stop: LoopStop = {};
  if (d.useRuns) stop.afterRuns = d.afterRuns;
  if (d.useMinutes) stop.afterMinutes = d.afterMinutes;
  if (d.useGoal) {
    const description = d.goalDescription.trim() || undefined;
    stop.whenGoal =
      d.goalKind === 'command'
        ? { kind: 'command', command: d.command.trim(), ...(d.commandCwd.trim() ? { cwd: d.commandCwd.trim() } : {}), ...(description ? { description } : {}) }
        : { kind: 'agent', ...(description ? { description } : {}) };
  }
  return { name: d.name.trim() || d.prompt.trim().replace(/\s+/g, ' ').slice(0, 40), prompt: d.prompt.trim(), trigger, target, stop };
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-3.5">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-fg-subtle uppercase">
        <span className="text-accent">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Segment<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: string; icon: ReactNode }[]; onChange: (v: T) => void; testId: string }) {
  return (
    <div role="radiogroup" className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-canvas/60 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          data-testid={`${testId}-${o.id}`}
          onClick={() => onChange(o.id)}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors
                      ${value === o.id ? 'bg-elevated text-fg shadow-sm ring-1 ring-accent/50' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
        >
          <span className={value === o.id ? 'text-accent' : 'text-fg-subtle'}>{o.icon}</span>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const input = `rounded-md border border-line-strong bg-canvas px-2 py-1 text-[12.5px] text-fg outline-none
               placeholder:text-fg-subtle focus:border-accent`;

function NumberField({ value, onChange, min, max, testId, width = 'w-16' }: { value: number; onChange: (n: number) => void; min: number; max: number; testId?: string; width?: string }) {
  return (
    <input
      type="number"
      data-testid={testId}
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`${input} ${width} tabular-nums`}
    />
  );
}

function Check({ checked, onChange, children, testId }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testId?: string }) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2 text-[12.5px] text-fg select-none">
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--aa-accent)]" />
      {children}
    </label>
  );
}

function LoopEditor({ loop, preset }: { loop: Loop | null; preset: { projectId?: string; consoleIds?: string[] } }) {
  const [d, setD] = useState<Draft>(() => draftFrom(loop, preset));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const consoles = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  const names = useLoopNames();
  const list = consoleList(consoles);
  const projectList = Object.values(projects).sort((a, b) => a.createdAt - b.createdAt);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const back = () => useLoops.getState().setEditing(null);

  const inputValue = toInput(d);
  const matchError = d.when === 'output' && d.match.trim() ? matcherError(d.match.trim()) : null;
  const problem =
    !d.prompt.trim()
      ? 'Type the prompt the loop sends'
      : d.when === 'output' && !d.match.trim()
        ? 'Type the text to watch for'
        : matchError
          ? `Invalid regular expression: ${matchError}`
          : d.target === 'project' && !projects[d.projectId]
            ? 'Pick a project'
            : d.target === 'consoles' && !d.consoleIds.length
              ? 'Pick at least one console'
              : d.useGoal && d.goalKind === 'command' && !d.command.trim()
                ? 'Type the goal command'
                : null;
  const oldCommand = loop?.stop.whenGoal?.kind === 'command' ? loop.stop.whenGoal.command : null;
  const needsConfirm = d.useGoal && d.goalKind === 'command' && d.command.trim() !== oldCommand;
  const commandCwd = d.commandCwd.trim() || (d.target === 'consoles' ? consoles[d.consoleIds[0]]?.cwd : d.target === 'project' ? consoles[projects[d.projectId]?.consoleIds[0] ?? '']?.cwd : list[0]?.cwd) || 'the first target’s folder';

  const save = async (confirmed = false) => {
    if (problem || saving) return;
    if (needsConfirm && !confirmed) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = { ...inputValue, ...(needsConfirm ? { confirmCommand: true } : {}) };
      const saved = loop ? await loopsApi.update(loop.id, body) : await loopsApi.create(body);
      useLoops.getState().upsert(saved);
      useBoard.getState().toast(loop ? `Saved loop ${saved.name}` : `Loop ${saved.name} is running`);
      back();
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="loop-editor">
      <div className="aa-scroll max-h-[62vh] overflow-y-auto">
        <div className="grid gap-2 px-5 pt-4 pb-3.5">
          <input
            data-testid="loop-name"
            data-autofocus
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Loop name (optional), e.g. Keep tests green"
            className={`${input} py-1.5 font-semibold`}
          />
          <textarea
            data-testid="loop-prompt"
            value={d.prompt}
            rows={3}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder="The prompt to send each time, e.g. Run the test suite and fix anything that fails."
            className={`${input} aa-scroll resize-y py-1.5 leading-5`}
          />
        </div>

        <Section icon={<Clock size={12} />} title="When">
          <Segment
            testId="loop-when"
            value={d.when}
            onChange={(when) => set({ when })}
            options={[
              { id: 'schedule', label: 'On a schedule', icon: <Clock size={13} /> },
              { id: 'idle', label: 'When an agent goes idle', icon: <Pause size={13} /> },
              { id: 'output', label: 'When output contains…', icon: <ScanText size={13} /> },
            ]}
          />
          <div className="mt-2.5 flex min-h-8 flex-wrap items-center gap-1.5 text-[12.5px] text-fg-muted">
            {d.when === 'schedule' && (
              <>
                Every
                {LOOP_SCHEDULE_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`loop-every-${m}`}
                    aria-pressed={d.everyMinutes === m}
                    onClick={() => set({ everyMinutes: m })}
                    className={`h-7 rounded-full border px-2.5 text-[12px] font-medium tabular-nums
                                ${d.everyMinutes === m ? 'border-accent/60 bg-accent/12 text-fg' : 'border-line-strong text-fg-muted hover:border-accent/40 hover:text-fg'}`}
                  >
                    {m >= 60 ? `${m / 60} h` : `${m} min`}
                  </button>
                ))}
              </>
            )}
            {d.when === 'idle' && (
              <>
                Send when a target has been idle or resting for
                <NumberField testId="loop-idle-value" value={d.idleValue} min={1} max={1440} onChange={(idleValue) => set({ idleValue })} />
                <select value={d.idleUnit} onChange={(e) => set({ idleUnit: e.target.value as 's' | 'min' })} className={input}>
                  <option value="s">seconds</option>
                  <option value="min">minutes</option>
                </select>
              </>
            )}
            {d.when === 'output' && (
              <div className="flex w-full flex-col gap-1">
                <input
                  data-testid="loop-match"
                  value={d.match}
                  onChange={(e) => set({ match: e.target.value })}
                  placeholder="tests failed   or   /\d+ failing/i"
                  className={`${input} w-full font-mono`}
                />
                <span className={`text-[11.5px] ${matchError ? 'text-error' : 'text-fg-subtle'}`}>
                  {matchError ?? 'Plain text matches case-insensitively; wrap in /…/ for a regular expression. Sent once the agent rests.'}
                </span>
              </div>
            )}
          </div>
        </Section>

        <Section icon={<Target size={12} />} title="Target">
          <Segment
            testId="loop-target"
            value={d.target}
            onChange={(target) => set({ target })}
            options={[
              { id: 'all', label: 'All consoles', icon: <Bot size={13} /> },
              { id: 'project', label: 'A project', icon: <Target size={13} /> },
              { id: 'consoles', label: 'Pick consoles', icon: <Terminal size={13} /> },
            ]}
          />
          <div className="mt-2.5">
            {d.target === 'all' && <p className="text-[12px] text-fg-subtle">Every console on the board. Working ones are skipped, never interrupted.</p>}
            {d.target === 'project' &&
              (projectList.length ? (
                <select data-testid="loop-project" value={d.projectId} onChange={(e) => set({ projectId: e.target.value })} className={`${input} w-full`}>
                  <option value="">Pick a project…</option>
                  {projectList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.consoleIds.length})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-[12px] text-fg-subtle">No projects yet. Group consoles first, or pick consoles.</p>
              ))}
            {d.target === 'consoles' && (
              <div className="aa-scroll grid max-h-36 grid-cols-2 gap-1 overflow-y-auto">
                {list.map((c) => {
                  const on = d.consoleIds.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      data-testid="loop-console-option"
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-[12.5px] select-none
                                  ${on ? 'border-accent/50 bg-accent/8 text-fg' : 'border-line text-fg-muted hover:border-line-strong'}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => set({ consoleIds: on ? d.consoleIds.filter((x) => x !== c.id) : [...d.consoleIds, c.id] })}
                        className="accent-[var(--aa-accent)]"
                      />
                      <StatusDot status={c.status} size={6} />
                      <span className="truncate font-medium">{c.name}</span>
                      {c.role && <span className="ml-auto truncate text-[11px] text-fg-subtle">{c.role}</span>}
                    </label>
                  );
                })}
                {list.length === 0 && <p className="col-span-2 text-[12px] text-fg-subtle">No consoles on the board.</p>}
              </div>
            )}
          </div>
        </Section>

        <Section icon={<Flag size={12} />} title="Stop">
          <div className="grid gap-1">
            <Check testId="loop-stop-runs" checked={d.useRuns} onChange={(useRuns) => set({ useRuns })}>
              After
              <NumberField value={d.afterRuns} min={1} max={10000} onChange={(afterRuns) => set({ afterRuns, useRuns: true })} />
              runs
            </Check>
            <Check testId="loop-stop-minutes" checked={d.useMinutes} onChange={(useMinutes) => set({ useMinutes })}>
              After
              <NumberField value={d.afterMinutes} min={1} max={100000} width="w-20" onChange={(afterMinutes) => set({ afterMinutes, useMinutes: true })} />
              minutes
            </Check>
            <Check testId="loop-stop-goal" checked={d.useGoal} onChange={(useGoal) => set({ useGoal })}>
              When a goal is met
            </Check>
            {d.useGoal && (
              <div className="ml-6 grid gap-2 rounded-xl border border-line bg-canvas/50 p-3">
                <input
                  data-testid="loop-goal-description"
                  value={d.goalDescription}
                  onChange={(e) => set({ goalDescription: e.target.value })}
                  placeholder="The goal in plain words, e.g. tests pass"
                  className={`${input} w-full`}
                />
                <div className="flex flex-wrap gap-3 text-[12.5px] text-fg">
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input type="radio" data-testid="loop-goal-command" checked={d.goalKind === 'command'} onChange={() => set({ goalKind: 'command' })} className="accent-[var(--aa-accent)]" />
                    A command passes (exit code 0)
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input type="radio" data-testid="loop-goal-agent" checked={d.goalKind === 'agent'} onChange={() => set({ goalKind: 'agent' })} className="accent-[var(--aa-accent)]" />
                    An agent judges
                  </label>
                </div>
                {d.goalKind === 'command' ? (
                  <div className="grid gap-1.5">
                    <input
                      data-testid="loop-command"
                      value={d.command}
                      onChange={(e) => set({ command: e.target.value })}
                      placeholder="npm test"
                      className={`${input} w-full font-mono`}
                    />
                    <input
                      value={d.commandCwd}
                      onChange={(e) => set({ commandCwd: e.target.value })}
                      placeholder="Folder (default: the first target's folder)"
                      className={`${input} w-full font-mono text-[11.5px]`}
                    />
                    <span className="text-[11.5px] text-fg-subtle">Runs in your OS shell after the targets finish each run, with a 2 minute limit.</span>
                  </div>
                ) : (
                  <span className="text-[11.5px] text-fg-subtle">
                    Each prompt asks the agent to end its reply with GOAL MET or GOAL NOT MET; GOAL MET retires the loop.
                  </span>
                )}
              </div>
            )}
          </div>
        </Section>
      </div>

      <div className="border-t border-line bg-surface-2 px-5 py-3">
        <p data-testid="loop-summary-line" className="flex items-start gap-2 text-[12.5px] leading-[18px] text-fg">
          <Repeat size={13} className="mt-[3px] shrink-0 text-accent" />
          <span>{loopSummary(inputValue.prompt ? inputValue : { ...inputValue, prompt: '…' }, names)}</span>
        </p>
        {confirming && (
          <div data-testid="loop-command-confirm" className="mt-2.5 flex items-start gap-2 rounded-lg border border-needs/40 bg-needs/10 px-3 py-2 text-[12px] text-fg">
            <TriangleAlert size={14} className="mt-[1px] shrink-0 text-needs" />
            <span className="min-w-0 flex-1">
              This runs <code className="rounded bg-canvas px-1 font-mono">{d.command.trim()}</code> on this computer in{' '}
              <span className="font-mono break-all">{commandCwd}</span> after every run. Only save it if you trust the command.
            </span>
          </div>
        )}
        {(error || problem) && (
          <p className={`mt-2 text-[12px] ${error ? 'text-error' : 'text-fg-subtle'}`} data-testid="loop-error">
            {error ?? problem}
          </p>
        )}
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <button type="button" onClick={back} className="rounded-lg px-3 py-1.5 font-medium text-fg-muted hover:bg-hover hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            data-testid={confirming ? 'loop-confirm-save' : 'loop-save'}
            disabled={!!problem || saving}
            onClick={() => void save(confirming)}
            className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
          >
            {saving ? <LoaderCircle size={13} className="animate-spin" /> : <Repeat size={13} />}
            {confirming ? 'Yes, run it and save' : loop ? 'Save loop' : 'Start loop'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function LoopsDialog() {
  const editing = useLoops((s) => s.editing);
  const loops = useLoops((s) => s.loops);
  const { closeLoops, setEditing } = useLoops.getState();
  const loop = editing && editing.id !== 'new' ? (loops[editing.id] ?? null) : null;
  const active = Object.values(loops).filter((l) => l.enabled).length;

  return (
    <Modal title="Loops" onClose={editing ? () => setEditing(null) : closeLoops} width="max-w-2xl" testId="loops-dialog">
      <div className="aa-card-glow flex items-center gap-3 border-b border-line px-5 pt-4 pb-3">
        {editing ? (
          <button
            type="button"
            aria-label="Back to loops"
            onClick={() => setEditing(null)}
            className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
          >
            <ArrowLeft size={15} />
          </button>
        ) : (
          <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent">
            <Repeat size={15} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">{editing ? (loop ? `Edit ${loop.name}` : 'New loop') : 'Loops'}</h2>
          <p className="mt-0.5 truncate text-fg-muted">
            {editing ? 'Re-send a prompt until the work is done.' : `${active} active · ${Object.keys(loops).length} total`}
          </p>
        </div>
        {!editing && Object.keys(loops).length > 0 && (
          <button
            type="button"
            data-testid="loop-new"
            onClick={() => setEditing({ id: 'new' })}
            className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold"
          >
            <Plus size={14} />
            New loop
          </button>
        )}
      </div>
      {editing ? <LoopEditor key={editing.id} loop={loop} preset={editing} /> : <LoopList />}
    </Modal>
  );
}

// Mounted once in the board shell: the Loops modal and the Composer open from several places
export function LoopsHost() {
  const loopsOpen = useLoops((s) => s.loopsOpen);
  const composerOpen = useLoops((s) => s.composerOpen);
  return (
    <>
      {loopsOpen && <LoopsDialog />}
      {composerOpen && <ComposerDialog />}
    </>
  );
}
