import type { ConsoleInfo, ConsoleStatus, Project } from '../../shared/protocol';

// URL views for pop-out windows (multi-screen):
//   /                          the full board
//   /?view=console&id=<id>     one console, full window
//   /?view=project&id=<id>     a board with only that project's consoles
//   /?view=focus               the "needs-you wall": consoles that need input or are working

export type AppView =
  | { kind: 'board' }
  | { kind: 'console'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'focus' };

export type PopoutView = Exclude<AppView, { kind: 'board' }>;

export function parseView(search: string): AppView {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const id = params.get('id')?.trim() ?? '';
  if ((view === 'console' || view === 'project') && id) return { kind: view, id };
  if (view === 'focus') return { kind: 'focus' };
  return { kind: 'board' };
}

export function viewUrl(view: AppView): string {
  if (view.kind === 'board') return '/';
  if (view.kind === 'focus') return '/?view=focus';
  return `/?view=${view.kind}&id=${encodeURIComponent(view.id)}`;
}

// Stable window.open name: opening the same item twice focuses the window it is already in
export function popoutKey(view: PopoutView): string {
  return view.kind === 'focus' ? 'agentarmy-focus' : `agentarmy-${view.kind}-${view.id}`;
}

const SIZES: Record<PopoutView['kind'], { width: number; height: number }> = {
  console: { width: 960, height: 640 },
  project: { width: 1280, height: 820 },
  focus: { width: 1400, height: 880 },
};

// window.open features; 'popup' asks for a minimal window the user can drag to another screen
export function popoutFeatures(view: PopoutView, screen?: { availWidth: number; availHeight: number }): string {
  const size = SIZES[view.kind];
  const width = screen ? Math.min(size.width, screen.availWidth) : size.width;
  const height = screen ? Math.min(size.height, screen.availHeight) : size.height;
  return `popup,width=${Math.round(width)},height=${Math.round(height)}`;
}

// "(2) Ada · AgentArmy"
export function windowTitle(name: string, needsYou: number): string {
  const base = name ? `${name} · AgentArmy` : 'AgentArmy';
  return needsYou > 0 ? `(${needsYou}) ${base}` : base;
}

const WALL_RANK: Partial<Record<ConsoleStatus, number>> = { needs_you: 0, error: 1, working: 2 };

// Consoles on the needs-you wall: waiting on you first (longest waiting first), then working
export function focusWallConsoles(consoles: Record<string, ConsoleInfo>, projects: Record<string, Project>): ConsoleInfo[] {
  return Object.values(consoles)
    .filter((c) => c.status === 'needs_you' || c.status === 'working')
    .filter((c) => !c.projectId || projects[c.projectId]?.open !== false)
    .sort((a, b) => (WALL_RANK[a.status] ?? 9) - (WALL_RANK[b.status] ?? 9) || a.statusChangedAt - b.statusChangedAt);
}

// Columns x rows for n tiles in a w x h area, keeping tiles close to the board's 760x460 shape
export function wallGrid(n: number, width: number, height: number, aspect = 760 / 460): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  let best = { cols: 1, rows: n, score: -Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = width / cols;
    const tileH = height / rows;
    // Largest tile of the right shape that fits each cell
    const fitW = Math.min(tileW, tileH * aspect);
    const score = fitW * (fitW / aspect);
    if (score > best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

// Consoles in a project-scoped board
export function projectMembers(project: Project | undefined, consoles: Record<string, ConsoleInfo>): ConsoleInfo[] {
  if (!project) return [];
  return project.consoleIds.map((id) => consoles[id]).filter((c): c is ConsoleInfo => !!c);
}

// What a board shows: everything, or (pop-out project board) one project's consoles and frame
export function scopeToProject<C extends ConsoleInfo, B, P extends Project>(
  projectId: string | undefined,
  consoles: Record<string, C>,
  browsers: Record<string, B>,
  projects: Record<string, P>,
): { consoles: Record<string, C>; browsers: Record<string, B>; projects: Record<string, P> } {
  if (!projectId) return { consoles, browsers, projects };
  const project = projects[projectId];
  const scoped: Record<string, C> = {};
  for (const id of project?.consoleIds ?? []) if (consoles[id]) scoped[id] = consoles[id];
  return { consoles: scoped, browsers: {}, projects: project ? { [projectId]: project } : {} };
}
