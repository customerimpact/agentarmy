import type { AppSettings, Project } from '../shared/protocol.js';
import type { BudgetStatus, UsageTotals } from '../shared/usage.js';
import { formatTokens } from '../shared/usage.js';

// Budgets: limits on weighted tokens (see weightedTokens in src/shared/usage.ts), checked against
// the usage index. Alerts fire once when a budget crosses 80% and again at 100%; they re-arm when
// usage falls back (a new day, or the rolling 5 h / 7 d window moving on).

export type BudgetSettings = Pick<
  AppSettings,
  'budgetDailyTokens' | 'budgetWeeklyTokens' | 'budget5hTokens' | 'projectDailyBudgets' | 'pauseJobsAtBudget'
>;

const MAX_BUDGET = 1e13;

function budgetNumber(key: string, value: unknown, fail: (m: string) => Error): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_BUDGET) {
    throw fail(`${key} must be a number of tokens (0 = no budget)`);
  }
  return Math.round(value);
}

// Called from validatePatch in settings.ts for the budget keys
export function validateBudgetSetting(
  key: string,
  value: unknown,
  fail: (message: string) => Error,
): Partial<BudgetSettings> {
  switch (key) {
    case 'budgetDailyTokens':
    case 'budgetWeeklyTokens':
    case 'budget5hTokens':
      return { [key]: budgetNumber(key, value, fail) };
    case 'pauseJobsAtBudget':
      if (typeof value !== 'boolean') throw fail('pauseJobsAtBudget must be true or false');
      return { pauseJobsAtBudget: value };
    case 'projectDailyBudgets': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw fail('projectDailyBudgets must be an object of project id -> tokens');
      }
      const out: Record<string, number> = {};
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 500) throw fail('Too many project budgets');
      for (const [id, n] of entries) {
        if (!/^[\w-]{1,100}$/.test(id)) throw fail('projectDailyBudgets has an invalid project id');
        const tokens = budgetNumber(`Budget for ${id}`, n, fail);
        if (tokens > 0) out[id] = tokens; // 0 removes it
      }
      return { projectDailyBudgets: out };
    }
    default:
      throw fail(`Unknown setting: ${key}`);
  }
}

export interface BudgetInputs {
  machine: { today: UsageTotals; last5h: UsageTotals; last7d: UsageTotals };
  projectToday: Map<string, UsageTotals>; // project id -> today's usage of its consoles
  projects: Project[];
}

function status(key: string, scope: BudgetStatus['scope'], label: string, used: number, limit: number): BudgetStatus {
  return { key, scope, label, used, limit, ratio: limit > 0 ? used / limit : 0 };
}

export function budgetStatuses(settings: BudgetSettings, inputs: BudgetInputs): BudgetStatus[] {
  const out: BudgetStatus[] = [];
  if (settings.budgetDailyTokens > 0) {
    out.push(status('daily', 'daily', 'Today', inputs.machine.today.weighted, settings.budgetDailyTokens));
  }
  if (settings.budget5hTokens > 0) {
    out.push(status('5h', '5h', 'Last 5 hours', inputs.machine.last5h.weighted, settings.budget5hTokens));
  }
  if (settings.budgetWeeklyTokens > 0) {
    out.push(status('weekly', 'weekly', 'Last 7 days', inputs.machine.last7d.weighted, settings.budgetWeeklyTokens));
  }
  for (const [projectId, limit] of Object.entries(settings.projectDailyBudgets ?? {})) {
    const project = inputs.projects.find((p) => p.id === projectId);
    if (!project || !(limit > 0)) continue;
    const used = inputs.projectToday.get(projectId)?.weighted ?? 0;
    out.push(status(`project:${projectId}`, 'project', project.name, used, limit));
  }
  return out;
}

// Overall budgets block every sender; a project budget blocks only senders in that project
export function jobsBlockedFor(
  settings: BudgetSettings,
  statuses: BudgetStatus[],
  senderProjectId?: string | null,
): BudgetStatus | null {
  if (!settings.pauseJobsAtBudget) return null;
  return (
    statuses.find(
      (b) => b.ratio >= 1 && (b.scope !== 'project' || (senderProjectId && b.key === `project:${senderProjectId}`)),
    ) ?? null
  );
}

export function overallJobsPaused(settings: BudgetSettings, statuses: BudgetStatus[]): boolean {
  return Boolean(jobsBlockedFor(settings, statuses, null));
}

export type BudgetLevel = 0 | 80 | 100;

export function levelOf(ratio: number): BudgetLevel {
  return ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : 0;
}

export function budgetTitle(b: Pick<BudgetStatus, 'scope' | 'label'>, level: BudgetLevel): string {
  const name = b.scope === 'project' ? `${b.label} daily budget` : `${b.label} budget`;
  return `${name} at ${level}%`;
}

export function budgetDetail(b: BudgetStatus, paused: boolean): string {
  const used = `${formatTokens(b.used)} of ${formatTokens(b.limit)} weighted tokens used`;
  return paused ? `${used}. New agent jobs are paused until usage drops or the budget is raised.` : `${used}.`;
}

export interface BudgetAlert {
  budget: BudgetStatus;
  level: Exclude<BudgetLevel, 0>;
}

// Remembers the last level per budget and reports upward crossings (and which budgets re-armed)
export class BudgetMonitor {
  private levels = new Map<string, BudgetLevel>();

  evaluate(statuses: BudgetStatus[]): { alerts: BudgetAlert[]; cleared: string[] } {
    const alerts: BudgetAlert[] = [];
    const cleared: string[] = [];
    const seen = new Set<string>();
    for (const b of statuses) {
      seen.add(b.key);
      const level = levelOf(b.ratio);
      const prev = this.levels.get(b.key) ?? 0;
      if (level > prev) alerts.push({ budget: b, level: level as 80 | 100 });
      else if (level < prev && level === 0) cleared.push(b.key);
      this.levels.set(b.key, level);
    }
    for (const key of [...this.levels.keys()]) {
      if (!seen.has(key)) {
        this.levels.delete(key);
        cleared.push(key);
      }
    }
    return { alerts, cleared };
  }
}
