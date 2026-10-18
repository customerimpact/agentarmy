import type { SettingsPatch } from '../../../shared/protocol';
import { formatTokens } from '../../../shared/usage';
import { useServerSettings } from '../../lib/settings';
import { useBoard } from '../../lib/store';
import { Note, TextSave, Toggle } from './fields';

// Settings rows for "Usage & budgets". Budgets are weighted tokens; 0 or empty = no budget.

type BudgetKey = 'budgetDailyTokens' | 'budgetWeeklyTokens' | 'budget5hTokens';

// '1.5M' -> 1500000, '200k' -> 200000, '' -> 0; NaN for anything else
export function parseTokenAmount(text: string): number {
  const t = text.trim().replace(/[\s,_]/g, '').toLowerCase();
  if (!t) return 0;
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(t);
  if (!m) return NaN;
  const scale = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  return Math.round(Number(m[1]) * scale);
}

const shown = (n: number | undefined) => (n ? formatTokens(n) : '');

async function save(patch: SettingsPatch, ok: string): Promise<void> {
  try {
    await useServerSettings.getState().patch(patch);
    useBoard.getState().toast(ok);
  } catch (e) {
    useBoard.getState().toast(`Could not save: ${(e as Error).message}`);
  }
}

function budgetSave(key: BudgetKey, label: string) {
  return async (text: string) => {
    const n = parseTokenAmount(text);
    if (!Number.isFinite(n)) {
      useBoard.getState().toast('Enter a number of tokens, like 2M or 500k (empty = no budget)');
      return;
    }
    await save({ [key]: n } as SettingsPatch, n ? `${label} budget set to ${formatTokens(n)}` : `${label} budget removed`);
  };
}

export function budgetBelow(key: BudgetKey, label: string) {
  return function BudgetBelow() {
    const value = useServerSettings((s) => s.data?.settings[key]);
    if (value === undefined) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
    return (
      <div className="mt-2">
        <TextSave label={`${label} budget`} value={shown(value)} placeholder="No budget (e.g. 5M)" onSave={budgetSave(key, label)} />
      </div>
    );
  };
}

export function ProjectBudgetsBelow() {
  const budgets = useServerSettings((s) => s.data?.settings.projectDailyBudgets);
  const projects = useBoard((s) => s.projects);
  const list = Object.values(projects).sort((a, b) => a.createdAt - b.createdAt);
  if (budgets === undefined) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
  if (!list.length) return <Note>Group consoles into a project to give it its own daily budget.</Note>;
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {list.map((p) => (
        <li key={p.id} data-project-budget={p.id} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-[12px] text-fg-muted" title={p.name}>
            {p.name}
          </span>
          <div className="min-w-0 flex-1">
            <TextSave
              label={`${p.name} daily budget`}
              value={shown(budgets[p.id])}
              placeholder="No budget"
              onSave={async (text) => {
                const n = parseTokenAmount(text);
                if (!Number.isFinite(n)) {
                  useBoard.getState().toast('Enter a number of tokens, like 2M or 500k');
                  return;
                }
                const next = { ...budgets, [p.id]: n };
                if (!n) delete next[p.id];
                await save({ projectDailyBudgets: next }, n ? `${p.name}: ${formatTokens(n)} a day` : `${p.name}: budget removed`);
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PauseJobsControl() {
  const on = useServerSettings((s) => s.data?.settings.pauseJobsAtBudget);
  if (on === undefined) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
  return (
    <Toggle
      label="Pause new jobs at 100%"
      checked={on}
      onChange={(v) => void save({ pauseJobsAtBudget: v }, v ? 'Agent jobs pause when a budget is used up' : 'Agent jobs no longer pause')}
    />
  );
}
