// Pure helpers for the sidebar tabs and the Mission Map. No store/DOM imports so they stay testable.
import type {
  ActionItem,
  ConsoleInfo,
  ConsoleStatus,
  Job,
  Project,
  ProjectColor,
  TodoItem,
} from '../../shared/protocol';

// Lower sorts first (mirrors STATUS_META.rank, kept here so this module has no UI imports)
export const STATUS_RANK: Record<ConsoleStatus, number> = {
  needs_you: 0,
  working: 1,
  error: 2,
  resting: 3,
  idle: 4,
  starting: 5,
  suspended: 6,
  exited: 7,
};

export const PROJECT_HEX: Record<ProjectColor, string> = {
  orange: '#f97316',
  amber: '#f59e0b',
  rose: '#f43f5e',
  violet: '#8b5cf6',
  blue: '#3b82f6',
  teal: '#14b8a6',
  green: '#22c55e',
};

export function projectHex(color: string | undefined): string {
  return PROJECT_HEX[color as ProjectColor] ?? PROJECT_HEX.orange;
}

// 'claude-opus-5-5' -> 'Opus 5.5', 'claude-sonnet-4-5-20250929' -> 'Sonnet 4.5',
// 'claude-3-5-haiku-20241022' -> 'Haiku 3.5', 'claude-opus-5-5[1m]' -> 'Opus 5.5 1M'
export function shortModel(model: string | undefined | null): string {
  if (!model) return '';
  const raw = model.trim();
  const lower = raw.toLowerCase();
  const context = /\[(\d+)m\]/.exec(lower);
  const base = lower.replace(/\[.*?\]/g, '');
  const family = /(opus|sonnet|haiku|fable)/.exec(base)?.[1];
  if (!family) return raw;
  const numbers = base.split(/[^a-z0-9]+/).filter((part) => /^\d{1,2}$/.test(part)); // drops 8-digit date stamps
  const name = family[0].toUpperCase() + family.slice(1);
  const version = numbers.join('.');
  return [name, version, context ? `${context[1]}M` : ''].filter(Boolean).join(' ');
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const byStatus = (a: ConsoleInfo, b: ConsoleInfo) =>
  STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.createdAt - b.createdAt;

export function projectOf(c: ConsoleInfo, projects: Record<string, Project>): Project | undefined {
  if (c.projectId && projects[c.projectId]) return projects[c.projectId];
  return Object.values(projects).find((p) => p.consoleIds.includes(c.id));
}

export interface ProjectGroup {
  project: Project;
  consoles: ConsoleInfo[];
}

// Consoles grouped under their project (projects in creation order), the rest as ungrouped
export function groupByProject(
  consoles: ConsoleInfo[],
  projects: Record<string, Project>,
): { groups: ProjectGroup[]; ungrouped: ConsoleInfo[] } {
  const groups = new Map<string, ProjectGroup>();
  const sorted = Object.values(projects).sort((a, b) => a.createdAt - b.createdAt);
  for (const project of sorted) groups.set(project.id, { project, consoles: [] });
  const ungrouped: ConsoleInfo[] = [];
  for (const c of consoles) {
    const project = projectOf(c, projects);
    if (project) groups.get(project.id)!.consoles.push(c);
    else ungrouped.push(c);
  }
  for (const g of groups.values()) g.consoles.sort(byStatus);
  ungrouped.sort(byStatus);
  return { groups: [...groups.values()], ungrouped };
}

export interface Progress {
  done: number;
  total: number;
  ratio: number; // 0..1, 0 when total is 0
}

export function todoProgress(todos: TodoItem[] | undefined): Progress {
  const list = todos ?? [];
  const done = list.filter((t) => t.status === 'completed').length;
  return { done, total: list.length, ratio: list.length ? done / list.length : 0 };
}

// Completed todos plus finished jobs, over all todos plus all jobs, for a set of consoles
export function combinedProgress(consoles: ConsoleInfo[], jobs: Job[]): Progress {
  const ids = new Set(consoles.map((c) => c.id));
  let done = 0;
  let total = 0;
  for (const c of consoles) {
    const p = todoProgress(c.todos);
    done += p.done;
    total += p.total;
  }
  for (const j of jobs) {
    if (!ids.has(j.toId)) continue;
    total += 1;
    if (j.status === 'done') done += 1;
  }
  return { done, total, ratio: total ? done / total : 0 };
}

export interface ProgressBucket {
  key: string;
  label: string;
  color: string | null; // hex for projects
  project?: Project;
  consoles: ConsoleInfo[];
}

// Progress tab: by project, then everything else bucketed by folder name
export function progressBuckets(
  consoles: ConsoleInfo[],
  projects: Record<string, Project>,
): ProgressBucket[] {
  const { groups, ungrouped } = groupByProject(consoles, projects);
  const out: ProgressBucket[] = groups
    .filter((g) => g.consoles.length > 0)
    .map((g) => ({
      key: `p:${g.project.id}`,
      label: g.project.name,
      color: projectHex(g.project.color),
      project: g.project,
      consoles: g.consoles,
    }));
  const byFolder = new Map<string, ConsoleInfo[]>();
  for (const c of ungrouped) {
    const name = folderName(c.cwd);
    byFolder.set(name, [...(byFolder.get(name) ?? []), c]);
  }
  for (const [name, list] of [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ key: `f:${name}`, label: name, color: null, consoles: list });
  }
  return out;
}

export type FleetBucket = 'working' | 'needs' | 'idle' | 'done';

export function fleetBucket(status: ConsoleStatus): FleetBucket {
  switch (status) {
    case 'working':
      return 'working';
    case 'needs_you':
    case 'error':
      return 'needs';
    case 'resting':
    case 'exited':
      return 'done';
    default:
      return 'idle';
  }
}

export function fleetCounts(consoles: ConsoleInfo[]): Record<FleetBucket, number> {
  const counts: Record<FleetBucket, number> = { working: 0, needs: 0, idle: 0, done: 0 };
  for (const c of consoles) counts[fleetBucket(c.status)] += 1;
  return counts;
}

export function isOrchestrator(c: ConsoleInfo, jobs: Job[]): boolean {
  if (c.role && c.role.toLowerCase() === 'orchestrator') return true;
  return jobs.some((j) => j.fromId === c.id);
}

export function openActions(actions: Record<string, ActionItem>): ActionItem[] {
  return Object.values(actions)
    .filter((a) => !a.resolvedAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function resolvedActions(actions: Record<string, ActionItem>): ActionItem[] {
  return Object.values(actions)
    .filter((a) => a.resolvedAt)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
}

// Things waiting on the user: open action items, plus needs_you consoles the server has not
// filed an item for (older servers, or the brief moment before the action arrives)
export function uncoveredNeedsYou(
  consoles: Record<string, ConsoleInfo>,
  actions: Record<string, ActionItem>,
): ConsoleInfo[] {
  const covered = new Set(
    openActions(actions)
      .filter((a) => a.kind === 'needs_you')
      .map((a) => a.consoleId),
  );
  return Object.values(consoles).filter((c) => c.status === 'needs_you' && !covered.has(c.id));
}

export function attentionCount(
  consoles: Record<string, ConsoleInfo>,
  actions: Record<string, ActionItem>,
): number {
  return openActions(actions).length + uncoveredNeedsYou(consoles, actions).length;
}

export const needsYouLabel = (n: number) => `${n} ${n === 1 ? 'needs' : 'need'} you`;

// Shift+click range in the visible list order
export function rangeBetween(order: string[], anchor: string, target: string): string[] {
  const a = order.indexOf(anchor);
  const b = order.indexOf(target);
  if (a === -1 || b === -1) return [target];
  const [from, to] = a < b ? [a, b] : [b, a];
  return order.slice(from, to + 1);
}

// Human status line for cards: "At the prompt", "Edit src/app.ts", the permission question...
export function statusLine(c: ConsoleInfo): string {
  switch (c.status) {
    case 'working':
      return c.activity || 'Working';
    case 'needs_you':
      return c.statusDetail || 'Waiting for you';
    case 'error':
      return c.statusDetail || 'Stopped with an error';
    case 'resting':
      return 'Done · at the prompt';
    case 'idle':
      return 'At the prompt';
    case 'starting':
      return 'Starting…';
    case 'suspended':
      return 'Suspended · resume to continue';
    case 'exited':
      return c.exitCode !== undefined ? `Exited (${c.exitCode})` : 'Exited';
  }
}
