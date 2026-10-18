import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Hand,
  LoaderCircle,
  Send,
  X,
} from 'lucide-react';
import type { RecapAgent, RecapResponse, WebhookKind } from '../../shared/protocol';
import { api } from '../lib/api';
import { useBoard } from '../lib/store';
import { Modal } from './Modal';

// End-of-day summary per project, built on the server from the day's event log (no tokens spent)

export function localDay(t = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDay(d.getTime());
}

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

function dayLabel(date: string): string {
  const today = localDay();
  if (date === today) return 'Today';
  if (date === shiftDay(today, -1)) return 'Yesterday';
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

const toast = (m: string) => useBoard.getState().toast(m);

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2">
      <div className="text-[10.5px] font-semibold tracking-wider text-fg-subtle uppercase">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function AgentCard({ agent: a }: { agent: RecapAgent }) {
  const stats = [
    a.prompts ? `${a.prompts} ${a.prompts === 1 ? 'prompt' : 'prompts'}` : null,
    a.jobsReceived.length ? `${a.jobsReceived.length} ${a.jobsReceived.length === 1 ? 'job' : 'jobs'}` : null,
    a.todosCompleted.length ? `${a.todosCompleted.length} done` : null,
    a.files.length ? `${a.files.length} ${a.files.length === 1 ? 'file' : 'files'}` : null,
  ].filter(Boolean);
  return (
    <li data-testid="recap-agent" className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-fg">{a.name}</span>
        {a.role && <span className="text-[11px] text-fg-subtle">{a.role}</span>}
        <span className="ml-auto text-[11px] text-fg-subtle tabular-nums">{stats.join(' · ')}</span>
      </div>
      {a.needsYou.count > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-needs">
          <Hand size={11} />
          Needed you {a.needsYou.count}×
          {a.needsYou.waitedMs > 0 && ` · waited ${duration(a.needsYou.waitedMs)}, longest ${duration(a.needsYou.longestMs)}`}
          {a.needsYou.open > 0 && ` · ${a.needsYou.open} still open`}
        </p>
      )}
      {(a.jobsReceived.length > 0 || a.jobsSent.length > 0) && (
        <Section label="Jobs">
          <ul className="flex flex-col gap-1">
            {a.jobsReceived.map((j, i) => (
              <li key={`in${i}`} className="text-[12px] leading-[17px] text-fg-muted">
                <span className="text-fg-subtle">from {j.peer}:</span> <span className="font-medium text-fg">{j.title}</span>{' '}
                <span className={j.status === 'failed' ? 'text-error' : j.status === 'done' ? 'text-resting' : 'text-working'}>
                  {j.status}
                </span>
                {j.result && <span className="block line-clamp-2 text-[11.5px] text-fg-subtle">{j.result}</span>}
              </li>
            ))}
            {a.jobsSent.map((j, i) => (
              <li key={`out${i}`} className="flex items-center gap-1 text-[12px] text-fg-muted">
                <span className="font-medium text-fg">{j.title}</span>
                <ArrowRight size={11} className="text-fg-subtle" />
                {j.peer} <span className="text-fg-subtle">({j.status})</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.todosCompleted.length > 0 && (
        <Section label="Completed">
          <ul className="flex flex-col gap-0.5">
            {a.todosCompleted.map((t) => (
              <li key={t} className="flex items-start gap-1.5 text-[12px] text-fg-muted">
                <Check size={12} className="mt-[3px] shrink-0 text-resting" />
                {t}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.highlights.length > 0 && (
        <Section label="Highlights">
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] leading-[17px] text-fg-muted">
            {a.highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </Section>
      )}
      {a.files.length > 0 && (
        <Section label="Files touched">
          <div className="flex flex-wrap gap-1">
            {a.files.slice(0, 16).map((f) => (
              <code key={f} className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                {f}
              </code>
            ))}
            {a.files.length > 16 && <span className="text-[11px] text-fg-subtle">+{a.files.length - 16} more</span>}
          </div>
        </Section>
      )}
      {a.errors.length > 0 && (
        <Section label="Errors">
          {a.errors.map((e, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[12px] text-error">
              <AlertTriangle size={12} className="mt-[3px] shrink-0" />
              {e}
            </p>
          ))}
        </Section>
      )}
      {a.next.length > 0 && (
        <Section label="Next">
          <ul className="flex flex-col gap-0.5">
            {a.next.map((t, i) => (
              <li key={t.id ?? i} className="text-[12px] text-fg-muted">
                <span className={t.status === 'in_progress' ? 'font-medium text-working' : ''}>
                  {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </li>
  );
}

export function RecapModal({ onClose }: { onClose: () => void }) {
  const [date, setDate] = useState(localDay);
  const [data, setData] = useState<RecapResponse | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState<WebhookKind | null>(null);
  const today = localDay();

  const load = useCallback(async (day: string) => {
    setError('');
    try {
      setData(await api.getRecap(day));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void load(date);
  }, [date, load]);

  const copy = () => {
    if (!data) return;
    void navigator.clipboard?.writeText(data.markdown).then(
      () => toast('Recap copied as Markdown'),
      () => toast('Could not copy'),
    );
  };

  const send = async (kind: WebhookKind) => {
    setSending(kind);
    try {
      await api.sendRecap(date, kind);
      toast(`Recap sent to ${kind === 'slack' ? 'Slack' : 'Discord'}`);
    } catch (e) {
      toast(`Could not send: ${(e as Error).message}`);
    } finally {
      setSending(null);
    }
  };

  const recap = data?.recap;
  const t = recap?.totals;
  return (
    <Modal title="Daily recap" onClose={onClose} width="max-w-3xl" testId="recap-modal">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <FileText size={15} className="text-accent" />
        <h2 className="text-[14px] font-semibold text-fg">Daily recap</h2>
        <div className="ml-3 flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous day"
            data-testid="recap-prev"
            onClick={() => setDate(shiftDay(date, -1))}
            className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
          >
            <ChevronLeft size={14} />
          </button>
          <label className="relative flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] text-fg">
            <CalendarDays size={12} className="text-fg-subtle" />
            <span data-testid="recap-day">{dayLabel(date)}</span>
            <input
              type="date"
              aria-label="Recap date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          <button
            type="button"
            aria-label="Next day"
            data-testid="recap-next"
            disabled={date >= today}
            onClick={() => setDate(shiftDay(date, 1))}
            className="grid size-7 place-items-center rounded-md text-fg-muted disabled:opacity-30
                       hover:bg-hover hover:text-fg"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto grid size-7 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <div className="aa-scroll max-h-[64vh] overflow-y-auto px-4 py-3">
        {error && <p className="py-8 text-center text-error">{error}</p>}
        {!error && !recap && (
          <p className="flex items-center justify-center gap-2 py-10 text-fg-subtle">
            <LoaderCircle size={14} className="animate-spin" /> Loading…
          </p>
        )}
        {recap && t && (
          <>
            <div data-testid="recap-totals" className="flex flex-wrap gap-1.5 text-[11.5px] tabular-nums">
              {[
                `${t.agents} ${t.agents === 1 ? 'agent' : 'agents'}`,
                `${t.prompts} ${t.prompts === 1 ? 'prompt' : 'prompts'}`,
                `${t.jobsDone} ${t.jobsDone === 1 ? 'job' : 'jobs'} done`,
                `${t.todosCompleted} ${t.todosCompleted === 1 ? 'todo' : 'todos'} completed`,
                `${t.files} ${t.files === 1 ? 'file' : 'files'} touched`,
                `${t.needsYou} needs-you`,
              ].map((label) => (
                <span key={label} className="rounded-full bg-hover px-2 py-0.5 text-fg-muted">
                  {label}
                </span>
              ))}
            </div>
            {recap.projects.length === 0 && recap.openActions.length === 0 && (
              <p className="py-10 text-center text-fg-subtle">No agent activity was recorded on this day.</p>
            )}
            {recap.projects.map((p) => (
              <section key={p.key} data-testid="recap-project" className="mt-4">
                <h3 className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-fg">{p.name}</span>
                  {p.folder && <span className="truncate font-mono text-[11px] text-fg-subtle">{p.folder}</span>}
                </h3>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {p.agents.map((a) => (
                    <AgentCard key={a.consoleId} agent={a} />
                  ))}
                </ul>
              </section>
            ))}
            {recap.openActions.length > 0 && (
              <section className="mt-4">
                <h3 className="text-[13px] font-semibold text-fg">Open action items</h3>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {recap.openActions.map((item, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[12px] text-fg-muted">
                      <Hand size={12} className="mt-[3px] shrink-0 text-needs" />
                      <span>
                        {item.agent && <span className="font-medium text-fg">{item.agent}: </span>}
                        {item.title}
                        {item.detail && <span className="text-fg-subtle"> — {item.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <span className="mr-auto text-[11px] text-fg-subtle">Built from the day’s board events. No tokens used.</span>
        {data?.canSend.map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={`recap-send-${kind}`}
            disabled={sending !== null}
            onClick={() => void send(kind)}
            className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-[12px] font-medium text-fg-muted disabled:opacity-50
                       hover:bg-hover hover:text-fg"
          >
            {sending === kind ? <LoaderCircle size={12} className="animate-spin" /> : <Send size={12} />}
            Send to {kind === 'slack' ? 'Slack' : 'Discord'}
          </button>
        ))}
        <button
          type="button"
          data-testid="recap-copy"
          disabled={!data}
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-accent-fg disabled:opacity-50
                     hover:brightness-110"
        >
          <Copy size={12} />
          Copy as Markdown
        </button>
      </div>
    </Modal>
  );
}

// Progress tab header button
export function RecapButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="recap-open"
        title="What every agent did today"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] font-medium text-fg-muted
                   hover:border-line-strong hover:text-fg"
      >
        <FileText size={11} />
        Recap
      </button>
      {open && <RecapModal onClose={() => setOpen(false)} />}
    </>
  );
}
