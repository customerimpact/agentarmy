import { useEffect, useState } from 'react';
import { ChevronRight, Gauge, PauseCircle } from 'lucide-react';
import {
  formatTokens,
  formatUsd,
  type BudgetStatus,
  type UsageDay,
  type UsageRange,
  type UsageReport,
  type UsageRow,
} from '../../shared/usage';
import { flyTo } from '../lib/board-actions';
import { projectHex } from '../lib/fleet';
import { useBoard } from '../lib/store';
import { fetchUsageReport, useUsage } from '../lib/usage';

// Usage section at the top of the Progress tab: tokens read from Claude Code's local transcripts,
// an API-equivalent cost estimate, budget meters, and per-project / per-agent / per-model splits.

const RANGES: { value: UsageRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '5h', label: '5 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];

// Fixed categorical order for the model split (never cycled: a 5th+ model folds into "Other")
const MODEL_COLORS = ['var(--aa-project-blue)', 'var(--aa-project-violet)', 'var(--aa-project-teal)', 'var(--aa-project-amber)'];

const WEIGHT_NOTE = 'Weighted tokens: input + output + cache writes + a tenth of cache reads (cache reads are cheap).';

function readOpen(): boolean {
  try {
    return localStorage.getItem('aa-usage-open') !== '0';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem('aa-usage-open', open ? '1' : '0');
  } catch {
    // private mode
  }
}

function shortModelName(model: string): string {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d+(?:-\d{1,2})?)/i.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace('-', '.')}`;
}

function DayBars({ days, machine }: { days: UsageDay[]; machine: UsageDay[] }) {
  const width = 280;
  const height = 44;
  const gap = 2;
  const max = Math.max(1, ...machine.map((d) => d.weighted), ...days.map((d) => d.weighted));
  const bar = (width - gap * (days.length - 1)) / days.length;
  return (
    <svg
      data-testid="usage-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      className="mt-2 block h-11 w-full"
      role="img"
      aria-label="Weighted tokens per day"
    >
      {days.map((d, i) => {
        const all = machine[i]?.weighted ?? d.weighted;
        const x = i * (bar + gap);
        const hAll = all > 0 ? Math.max(2, (all / max) * height) : 0;
        const hOurs = d.weighted > 0 ? Math.max(2, (d.weighted / max) * height) : 0;
        return (
          <g key={d.day}>
            <title>{`${d.day}: ${formatTokens(d.weighted)} on this board, ${formatTokens(all)} on this machine`}</title>
            <rect x={x} y={0} width={bar} height={height} fill="transparent" />
            {hAll > 0 && <rect x={x} y={height - hAll} width={bar} height={hAll} rx={Math.min(3, bar / 2)} fill="var(--aa-line-strong)" />}
            {hOurs > 0 && <rect x={x} y={height - hOurs} width={bar} height={hOurs} rx={Math.min(3, bar / 2)} fill="var(--aa-accent)" />}
          </g>
        );
      })}
    </svg>
  );
}

function Meter({ budget }: { budget: BudgetStatus }) {
  const pct = Math.round(budget.ratio * 100);
  const tone = budget.ratio >= 1 ? 'var(--aa-error)' : budget.ratio >= 0.8 ? 'var(--aa-needs)' : 'var(--aa-accent)';
  return (
    <li data-testid="usage-budget" data-budget={budget.key} className="text-[11.5px]">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          {budget.scope === 'project' ? `${budget.label} today` : budget.label}
        </span>
        <span className="shrink-0 text-fg-subtle tabular-nums">
          {formatTokens(budget.used)} / {formatTokens(budget.limit)}
        </span>
        <span
          className={`w-9 shrink-0 text-right font-semibold tabular-nums ${budget.ratio >= 1 ? 'text-error' : budget.ratio >= 0.8 ? 'text-needs' : 'text-fg'}`}
        >
          {pct}%
        </span>
      </div>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-hover">
        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: tone }} />
      </span>
    </li>
  );
}

function BarList({
  title,
  rows,
  colorOf,
  onPick,
  testId,
}: {
  title: string;
  rows: UsageRow[];
  colorOf?: (row: UsageRow) => string;
  onPick?: (row: UsageRow) => void;
  testId: string;
}) {
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.weighted));
  const shown = rows.slice(0, 6);
  return (
    <div data-testid={testId} className="mt-3">
      <h4 className="mb-1 text-[10.5px] font-semibold tracking-wider text-fg-subtle uppercase">{title}</h4>
      <ul className="flex flex-col gap-1">
        {shown.map((r) => (
          <li key={r.key} title={`${formatTokens(r.weighted)} weighted · ${formatTokens(r.total)} total · ≈${formatUsd(r.costUsd)}`}>
            <button
              type="button"
              disabled={!onPick}
              onClick={() => onPick?.(r)}
              className="flex w-full items-center gap-2 text-left text-[11.5px] disabled:cursor-default"
            >
              <span className={`w-20 shrink-0 truncate text-fg-muted ${onPick ? 'hover:text-fg hover:underline' : ''}`}>
                {r.label}
              </span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(2, (r.weighted / max) * 100)}%`, background: colorOf?.(r) ?? 'var(--aa-accent)' }}
                />
              </span>
              <span className="w-11 shrink-0 text-right text-fg-subtle tabular-nums">{formatTokens(r.weighted)}</span>
            </button>
          </li>
        ))}
        {rows.length > shown.length && (
          <li className="text-[11px] text-fg-subtle">+{rows.length - shown.length} more</li>
        )}
      </ul>
    </div>
  );
}

function ModelSplit({ rows }: { rows: UsageRow[] }) {
  const total = rows.reduce((n, r) => n + r.weighted, 0);
  if (!total) return null;
  const top = rows.slice(0, MODEL_COLORS.length);
  const rest = rows.slice(MODEL_COLORS.length).reduce((n, r) => n + r.weighted, 0);
  const parts = [
    ...top.map((r, i) => ({ key: r.key, label: shortModelName(r.key), value: r.weighted, color: MODEL_COLORS[i] })),
    ...(rest > 0 ? [{ key: 'other', label: 'Other', value: rest, color: 'var(--aa-fg-subtle)' }] : []),
  ];
  return (
    <div data-testid="usage-models" className="mt-3">
      <h4 className="mb-1 text-[10.5px] font-semibold tracking-wider text-fg-subtle uppercase">Models</h4>
      <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full">
        {parts.map((p) => (
          <span key={p.key} title={`${p.label}: ${formatTokens(p.value)}`} style={{ flexGrow: p.value, background: p.color }} />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: p.color }} />
            {p.label}
            <span className="text-fg-subtle tabular-nums">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function JobsPausedNote() {
  const paused = useUsage((s) => s.live?.jobsPaused);
  if (!paused) return null;
  return (
    <div
      role="status"
      data-testid="jobs-paused-banner"
      className="flex items-center gap-2 rounded-lg border border-error/40 bg-error/10 px-2.5 py-1.5 text-[11.5px] text-error"
    >
      <PauseCircle size={13} className="shrink-0" />
      <span>New agent jobs are paused: a usage budget is used up.</span>
    </div>
  );
}

// Board-level banner, shown under the reconnect banner
export function JobsPausedBanner() {
  const paused = useUsage((s) => s.live?.jobsPaused);
  if (!paused) return null;
  return (
    <div className="pointer-events-none absolute top-12 left-1/2 z-20 -translate-x-1/2">
      <button
        type="button"
        data-testid="jobs-paused-board-banner"
        onClick={() => useBoard.getState().setSidebarTab('progress')}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-error/40 bg-elevated px-3.5 py-1.5 text-[12px] font-medium text-error shadow-xl shadow-black/30"
      >
        <PauseCircle size={13} />
        Budget used up · new agent jobs are paused
      </button>
    </div>
  );
}

export function UsageSection() {
  const [open, setOpen] = useState(readOpen);
  const [range, setRange] = useState<UsageRange>('today');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveAt = useUsage((s) => s.live?.at);
  const projects = useBoard((s) => s.projects);
  const consoles = useBoard((s) => s.consoles);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchUsageReport(range)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [open, range, liveAt]);

  const toggle = () => {
    setOpen(!open);
    writeOpen(!open);
  };

  const totals = report?.totals;
  const machine = report?.machineTotals;
  const budgets = report?.budgets ?? [];

  return (
    <section data-testid="usage-section" className="rounded-xl border border-line bg-surface-2 p-2.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Gauge size={13} className="shrink-0 text-accent" />
          <span className="text-[12.5px] font-semibold text-fg">Usage</span>
          {!open && totals && (
            <span className="truncate text-[11.5px] text-fg-subtle tabular-nums">
              {formatTokens(totals.weighted)} · ≈{formatUsd(totals.costUsd)}
            </span>
          )}
          <ChevronRight size={12} className={`ml-auto shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
      </div>

      {open && (
        <>
          <div role="radiogroup" aria-label="Usage range" className="mt-2 flex rounded-md border border-line bg-canvas p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={range === r.value}
                data-testid={`usage-range-${r.value}`}
                onClick={() => setRange(r.value)}
                className={`flex-1 rounded px-2 py-0.5 text-[11.5px] font-medium tabular-nums
                            ${range === r.value ? 'bg-hover text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {error && <p className="mt-2 text-[11.5px] text-error">Could not load usage: {error}</p>}
          {!report && !error && <p className="mt-2 text-[11.5px] text-fg-subtle">Reading transcripts…</p>}

          {report && totals && machine && (
            <>
              <div className="mt-2.5 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5" title={WEIGHT_NOTE}>
                    <span data-testid="usage-total" className="text-[20px] leading-6 font-semibold text-fg tabular-nums">
                      {formatTokens(totals.weighted)}
                    </span>
                    <span className="text-[11.5px] text-fg-subtle">tokens on this board</span>
                  </div>
                  <div className="text-[11px] text-fg-subtle tabular-nums">
                    in {formatTokens(totals.input)} · out {formatTokens(totals.output)} · cache {formatTokens(totals.cacheCreate)} w /{' '}
                    {formatTokens(totals.cacheRead)} r
                  </div>
                </div>
                <div className="shrink-0 text-right" title="What these tokens would cost at API list prices. Estimates; your subscription is billed differently.">
                  <div data-testid="usage-cost" className="text-[13px] font-semibold text-fg tabular-nums">
                    ≈{formatUsd(totals.costUsd)}
                  </div>
                  <div className="text-[10.5px] text-fg-subtle">API-equivalent</div>
                </div>
              </div>

              <DayBars days={report.byDay} machine={report.machineByDay} />
              <div className="mt-1 flex items-center gap-3 text-[10.5px] text-fg-subtle">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-accent" />
                  This board
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-line-strong" />
                  All sessions
                </span>
                <span className="ml-auto">{report.byDay.length} days</span>
              </div>

              <div
                data-testid="usage-machine"
                className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-canvas/60 px-2 py-1.5 text-center"
                title={`Every Claude Code session on this machine, not only this board. ${WEIGHT_NOTE}`}
              >
                {[
                  ['Today', machine.today],
                  ['Last 5 h', machine.last5h],
                  ['Last 7 d', machine.last7d],
                ].map(([label, t]) => (
                  <div key={label as string}>
                    <div className="text-[12px] font-semibold text-fg tabular-nums">
                      {formatTokens((t as typeof machine.today).weighted)}
                    </div>
                    <div className="text-[10px] text-fg-subtle">{label as string}</div>
                  </div>
                ))}
              </div>

              {report.byAccount.length > 1 && (
                <ul data-testid="usage-accounts" className="mt-2 flex flex-col gap-0.5 text-[11px]">
                  {report.byAccount.map((a) => (
                    <li key={a.accountId} className="flex gap-2 text-fg-muted tabular-nums">
                      <span className="min-w-0 flex-1 truncate">{a.accountId === 'default' ? 'Default account' : a.accountId}</span>
                      <span title="Today">{formatTokens(a.today.weighted)}</span>
                      <span className="text-fg-subtle" title="Last 5 hours">{formatTokens(a.last5h.weighted)}</span>
                      <span className="text-fg-subtle" title="Last 7 days">{formatTokens(a.last7d.weighted)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {budgets.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-2">{budgets.map((b) => <Meter key={b.key} budget={b} />)}</ul>
              ) : (
                <button
                  type="button"
                  onClick={() => useBoard.getState().setSidebarTab('settings')}
                  className="mt-2 text-[11.5px] text-accent hover:underline"
                >
                  Set daily, 5 h or weekly budgets…
                </button>
              )}
              {report.jobsPaused && (
                <div className="mt-2">
                  <JobsPausedNote />
                </div>
              )}

              <BarList
                title="Projects"
                testId="usage-projects"
                rows={report.byProject}
                colorOf={(r) => (r.key && projects[r.key] ? projectHex(projects[r.key].color) : 'var(--aa-fg-subtle)')}
              />
              <BarList
                title="Agents"
                testId="usage-agents"
                rows={report.byConsole}
                onPick={(r) => consoles[r.key] && void flyTo(r.key)}
              />
              <ModelSplit rows={report.byModel} />
              {report.scanning && <p className="mt-2 text-[11px] text-fg-subtle">Still reading older transcripts…</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
