import { useState } from 'react';
import { ArrowRight, Check, ChevronRight, Circle, LoaderCircle } from 'lucide-react';
import type { ConsoleInfo, Job, JobStatus, TodoItem } from '../../shared/protocol';
import { flyTo } from '../lib/board-actions';
import {
  combinedProgress,
  fleetCounts,
  needsYouLabel,
  progressBuckets,
  relativeTime,
  statusLine,
  todoProgress,
  type ProgressBucket,
} from '../lib/fleet';
import { useBoard, useClock } from '../lib/store';
import { ProgressBar } from './AgentBadges';
import { StatusDot } from './StatusDot';
import { RecapButton } from './RecapModal';
import { UsageSection } from './UsageSection';
import { LoopProgress } from './LoopProgress';

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {todos.map((t, i) => (
        <li key={t.id ?? i} className="flex items-start gap-2 text-[12px] leading-[18px]">
          {t.status === 'completed' ? (
            <span className="mt-[3px] grid size-3 shrink-0 place-items-center rounded-[3px] bg-resting/80 text-black">
              <Check size={9} strokeWidth={3.5} />
            </span>
          ) : t.status === 'in_progress' ? (
            <LoaderCircle size={12} className="mt-[3px] shrink-0 animate-spin text-working" />
          ) : (
            <Circle size={12} className="mt-[3px] shrink-0 text-fg-subtle" />
          )}
          <span
            className={
              t.status === 'completed'
                ? 'text-fg-subtle line-through decoration-fg-subtle/50'
                : t.status === 'in_progress'
                  ? 'font-medium text-working'
                  : 'text-fg-muted'
            }
          >
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConsoleProgress({ console: c }: { console: ConsoleInfo }) {
  const todos = c.todos ?? [];
  const p = todoProgress(todos);
  const [open, setOpen] = useState(todos.some((t) => t.status !== 'completed'));
  return (
    <li className="rounded-lg hover:bg-hover/50">
      <div className="flex items-center gap-2 px-1.5 py-1.5">
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          disabled={!todos.length}
          onClick={() => setOpen(!open)}
          className="grid size-4 shrink-0 place-items-center text-fg-subtle disabled:opacity-0"
        >
          <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        <StatusDot status={c.status} />
        <button
          type="button"
          onClick={() => void flyTo(c.id)}
          className="min-w-0 flex-1 text-left"
          title="Go to console"
        >
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[12.5px] font-medium text-fg hover:underline">
              {c.name}
            </span>
            {p.total > 0 && (
              <span className="ml-auto shrink-0 text-[10.5px] text-fg-subtle tabular-nums">
                {p.done}/{p.total}
              </span>
            )}
          </span>
          <span className="block truncate text-[11.5px] text-fg-subtle">{statusLine(c)}</span>
        </button>
      </div>
      {open && todos.length > 0 && (
        <div className="pr-2 pb-2 pl-[46px]">
          <TodoList todos={todos} />
        </div>
      )}
    </li>
  );
}

function BucketCard({ bucket, jobs }: { bucket: ProgressBucket; jobs: Job[] }) {
  const progress = combinedProgress(bucket.consoles, jobs);
  const counts = fleetCounts(bucket.consoles);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section
      data-testid="progress-bucket"
      className="rounded-xl border border-line bg-surface-2 p-2.5"
    >
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={`size-2 shrink-0 rounded-full ${bucket.color ? '' : 'border border-fg-subtle'}`}
          style={bucket.color ? { background: bucket.color } : undefined}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg">
          {bucket.label}
          {!bucket.project && <span className="ml-1.5 font-normal text-fg-subtle">folder</span>}
        </span>
        <span className="shrink-0 text-[11.5px] font-semibold text-fg tabular-nums">
          {progress.total ? `${Math.round(progress.ratio * 100)}%` : '—'}
        </span>
        <ChevronRight
          size={12}
          className={`shrink-0 text-fg-subtle transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
      </button>
      <ProgressBar ratio={progress.ratio} color={bucket.color} className="mt-2" />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-subtle tabular-nums">
        <span>
          {progress.done}/{progress.total} steps
        </span>
        {counts.working > 0 && <span className="text-working">{counts.working} working</span>}
        {counts.needs > 0 && <span className="text-needs">{needsYouLabel(counts.needs)}</span>}
        {counts.idle > 0 && <span>{counts.idle} idle</span>}
        {counts.done > 0 && <span className="text-resting">{counts.done} done</span>}
      </div>
      {!collapsed && (
        <ul className="mt-2 flex flex-col border-t border-line pt-1.5">
          {bucket.consoles.map((c) => (
            <ConsoleProgress key={c.id} console={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

const JOB_TONE: Record<JobStatus, string> = {
  sent: 'bg-hover text-fg-muted ring-1 ring-line-strong',
  working: 'bg-working/12 text-working ring-1 ring-working/30',
  done: 'bg-resting/12 text-resting ring-1 ring-resting/30',
  failed: 'bg-error/15 text-error ring-1 ring-error/40',
};

export function JobRow({ job, now }: { job: Job; now: number }) {
  const consoles = useBoard((s) => s.consoles);
  const from = job.fromId ? (consoles[job.fromId]?.name ?? 'Closed console') : 'You';
  const to = consoles[job.toId]?.name ?? 'Closed console';
  return (
    <li data-testid="job-row" className="relative pb-3 pl-4">
      <span className="absolute top-[6px] -left-[4.5px] size-2 rounded-full bg-line-strong ring-2 ring-surface" />
      <div className="flex items-center gap-1 text-[11.5px] text-fg-subtle">
        <span className="font-medium text-fg-muted">{from}</span>
        <ArrowRight size={11} />
        <button
          type="button"
          onClick={() => consoles[job.toId] && void flyTo(job.toId)}
          className="font-medium text-fg-muted hover:text-fg hover:underline"
        >
          {to}
        </button>
        <span className="ml-auto tabular-nums">{relativeTime(job.updatedAt, now)}</span>
      </div>
      <div className="mt-0.5 flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-fg">{job.title}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px] font-medium ${JOB_TONE[job.status]}`}
        >
          {job.status}
        </span>
      </div>
      {job.result && (
        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-fg-muted">{job.result}</p>
      )}
    </li>
  );
}

export function ProgressPanel() {
  const consoles = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  const jobsById = useBoard((s) => s.jobs);
  const now = useClock((s) => s.now);
  const jobs = Object.values(jobsById).sort((a, b) => b.createdAt - a.createdAt);
  const list = Object.values(consoles);
  const buckets = progressBuckets(list, projects);
  const overall = combinedProgress(list, jobs);
  const counts = fleetCounts(list);

  return (
    <div data-testid="progress-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-fg">Progress</span>
          <RecapButton />
          <span className="ml-auto text-[11.5px] text-fg-subtle tabular-nums">
            {overall.done}/{overall.total} steps
          </span>
        </div>
        <ProgressBar ratio={overall.ratio} className="mt-1.5" />
        <div className="mt-1.5 flex gap-3 text-[11px] text-fg-subtle tabular-nums">
          <span className={counts.working ? 'text-working' : ''}>{counts.working} working</span>
          <span className={counts.needs ? 'text-needs' : ''}>{needsYouLabel(counts.needs)}</span>
          <span>{counts.idle} idle</span>
          <span className={counts.done ? 'text-resting' : ''}>{counts.done} done</span>
        </div>
      </div>

      <div className="aa-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
        <UsageSection />
        {buckets.length === 0 && (
          <p className="px-3 py-10 text-center text-fg-subtle">
            Progress shows up here once agents start planning their work.
          </p>
        )}
        {buckets.map((b) => (
          <BucketCard key={b.key} bucket={b} jobs={jobs} />
        ))}

        <LoopProgress />
        {jobs.length > 0 && (
          <section className="mt-2 px-1">
            <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
              Jobs
              <span className="font-normal tabular-nums normal-case">{jobs.length}</span>
            </h3>
            <ol className="relative ml-1 border-l border-line pl-0">
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} now={now} />
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}
