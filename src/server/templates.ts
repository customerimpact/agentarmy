import type {
  ConsoleInfo,
  ConsoleLayout,
  LaunchTemplateRequest,
  LaunchTemplateResponse,
  Project,
  Template,
} from '../shared/protocol.js';
import {
  BUILTIN_TEMPLATES,
  fillPrompt,
  FRAME_PADDING,
  FRAME_TITLE_HEIGHT,
  ORCHESTRATOR_PROMPT,
  TEAM_COLUMNS,
  TEAMS_PER_ROW,
  TEMPLATE_GAP,
} from '../shared/templates.js';
import type { AgentKind } from '../shared/agents.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { DEFAULT_SIZE } from './placement.js';
import type { ProjectService } from './projects.js';

const FIRST_PROMPT_TIMEOUT_MS = 3 * 60_000;
// SessionStart fires slightly before the prompt box accepts typing
const FIRST_PROMPT_DELAY_MS = 800;

export interface TeamLayout {
  frame: ConsoleLayout; // the frame box the UI draws (title bar included)
  consoles: ConsoleLayout[];
}

export interface TemplateLayout {
  orchestrator: ConsoleLayout | null;
  teams: TeamLayout[];
}

const box = (x: number, y: number): ConsoleLayout => ({ x, y, ...DEFAULT_SIZE });

function teamSize(count: number): { width: number; height: number } {
  const cols = Math.min(TEAM_COLUMNS, Math.max(count, 1));
  const rows = Math.ceil(Math.max(count, 1) / TEAM_COLUMNS);
  return {
    width: cols * DEFAULT_SIZE.width + (cols - 1) * TEMPLATE_GAP + 2 * FRAME_PADDING,
    height:
      FRAME_TITLE_HEIGHT +
      rows * DEFAULT_SIZE.height +
      (rows - 1) * TEMPLATE_GAP +
      2 * FRAME_PADDING,
  };
}

// Orchestrator centered on top; team frames below in rows of TEAMS_PER_ROW;
// consoles inside a frame in a TEAM_COLUMNS grid.
export function layoutTemplate(
  template: Pick<Template, 'orchestrator' | 'teams'>,
  origin = { x: 0, y: 0 },
): TemplateLayout {
  const sizes = template.teams.map((t) => teamSize(t.count));
  const rows: number[][] = [];
  sizes.forEach((_, i) => {
    if (i % TEAMS_PER_ROW === 0) rows.push([]);
    rows[rows.length - 1].push(i);
  });
  const rowWidth = (row: number[]): number =>
    row.reduce((sum, i) => sum + sizes[i].width, 0) + (row.length - 1) * TEMPLATE_GAP;
  const totalWidth = Math.max(DEFAULT_SIZE.width, ...rows.map(rowWidth));

  let y = origin.y;
  let orchestrator: ConsoleLayout | null = null;
  if (template.orchestrator) {
    orchestrator = box(Math.round(origin.x + (totalWidth - DEFAULT_SIZE.width) / 2), y);
    y += DEFAULT_SIZE.height + TEMPLATE_GAP * 2;
  }

  const teams: TeamLayout[] = new Array(template.teams.length);
  for (const row of rows) {
    let x = origin.x + Math.round((totalWidth - rowWidth(row)) / 2);
    for (const i of row) {
      const frame = { x, y, ...sizes[i] };
      const consoles: ConsoleLayout[] = [];
      for (let k = 0; k < template.teams[i].count; k++) {
        const col = k % TEAM_COLUMNS;
        const r = Math.floor(k / TEAM_COLUMNS);
        consoles.push(
          box(
            x + FRAME_PADDING + col * (DEFAULT_SIZE.width + TEMPLATE_GAP),
            y + FRAME_TITLE_HEIGHT + FRAME_PADDING + r * (DEFAULT_SIZE.height + TEMPLATE_GAP),
          ),
        );
      }
      teams[i] = { frame, consoles };
      x += sizes[i].width + TEMPLATE_GAP;
    }
    y += Math.max(...row.map((i) => sizes[i].height)) + TEMPLATE_GAP;
  }
  return { orchestrator, teams };
}

// Types each console's first prompt the first time it reaches 'idle' (gives up after 3 minutes)
export class FirstPromptQueue {
  private pending = new Map<string, { text: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly manager: ConsoleManager,
    private readonly delayMs = FIRST_PROMPT_DELAY_MS,
  ) {
    manager.on('console', (info) => {
      if (info.status === 'idle') this.fire(info.id);
    });
    manager.on('removed', (id) => this.cancel(id));
  }

  add(consoleId: string, text: string, timeoutMs = FIRST_PROMPT_TIMEOUT_MS): void {
    this.cancel(consoleId);
    const timer = setTimeout(() => this.pending.delete(consoleId), timeoutMs);
    timer.unref?.();
    this.pending.set(consoleId, { text, timer });
    if (this.manager.get(consoleId)?.status === 'idle') this.fire(consoleId);
  }

  has(consoleId: string): boolean {
    return this.pending.has(consoleId);
  }

  private fire(consoleId: string): void {
    const item = this.pending.get(consoleId);
    if (!item) return;
    this.cancel(consoleId);
    const send = (): void => {
      this.manager.sendText(consoleId, item.text);
    };
    if (this.delayMs > 0) setTimeout(send, this.delayMs).unref?.();
    else send();
  }

  private cancel(consoleId: string): void {
    const item = this.pending.get(consoleId);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(consoleId);
  }
}

export interface SpawnHooks {
  cwdFor: (role: string, key: string) => string;
  onSpawn: (info: ConsoleInfo, key: string) => void;
}

export class TemplateService {
  constructor(
    private readonly manager: ConsoleManager,
    private readonly projects: ProjectService,
    private readonly prompts: FirstPromptQueue,
    readonly templates: Template[] = BUILTIN_TEMPLATES,
  ) {}

  // One project per team; the orchestrator gets its own project too, so closing and
  // reopening the whole template is just closing/opening its projects.
  // hooks: per-console cwd override (git worktrees) and a callback once each console exists
  launch(
    templateId: string,
    req: LaunchTemplateRequest,
    hooks?: SpawnHooks,
  ): LaunchTemplateResponse {
    this.hooks = hooks;
    try {
      return this.launchInner(templateId, req);
    } finally {
      this.hooks = undefined;
    }
  }

  private hooks: SpawnHooks | undefined;
  private spawnSeq = 0;

  private launchInner(templateId: string, req: LaunchTemplateRequest): LaunchTemplateResponse {
    const template = this.templates.find((t) => t.id === templateId);
    if (!template) throw new NotFoundError(`Unknown template ${templateId}`);
    const prefix = req.projectName?.trim();
    const projectName = (team: string): string => (prefix ? `${prefix} · ${team}` : team);
    const origin = req.origin ?? this.freeOrigin();
    const layout = layoutTemplate(template, origin);

    const consoles: ConsoleInfo[] = [];
    const projects: Project[] = [];
    const roster: string[] = [];
    let orchestrator: ConsoleInfo | null = null;
    if (layout.orchestrator) {
      // First, so a bad cwd fails before anything else is created
      orchestrator = this.spawn(req.cwd, layout.orchestrator, 'Orchestrator', req.accountId);
      consoles.push(orchestrator);
    }
    template.teams.forEach((team, i) => {
      const name = projectName(team.name);
      const agent = req.teamAgents?.[i];
      const members = layout.teams[i].consoles.map((l) => this.spawn(req.cwd, l, team.role, req.accountId, agent));
      consoles.push(...members);
      projects.push(this.projects.create({ name, consoleIds: members.map((c) => c.id) }));
      roster.push(`${name} (${members.map((c) => c.name).join(', ')})`);
      if (team.prompt) {
        for (const c of members) {
          this.prompts.add(c.id, fillPrompt(team.prompt, { name: c.name, team: name }));
        }
      }
    });
    if (orchestrator) {
      const name = projectName('Orchestrator');
      projects.unshift(this.projects.create({ name, consoleIds: [orchestrator.id] }));
      this.prompts.add(
        orchestrator.id,
        fillPrompt(ORCHESTRATOR_PROMPT, { name: orchestrator.name, roster: roster.join('; ') }),
      );
    }
    return { projects, consoles: consoles.map((c) => this.manager.get(c.id) ?? c) };
  }

  private spawn(cwd: string, layout: ConsoleLayout, role: string, accountId?: string, agent?: AgentKind): ConsoleInfo {
    const key = String(++this.spawnSeq);
    // Custom commands need a command line, which a team has none of, so they fall back to Claude Code
    const cli = agent && agent !== 'custom' && agent !== 'claude' ? { agent } : {};
    const info = this.manager.create({ cwd: this.hooks?.cwdFor(role, key) ?? cwd, layout, accountId, ...cli });
    this.hooks?.onSpawn(info, key);
    info.role = role;
    this.manager.touch(info.id);
    return info;
  }

  // Below everything already on the board, so a launch never covers existing consoles
  private freeOrigin(): { x: number; y: number } {
    const all = this.manager.list();
    if (all.length === 0) return { x: 0, y: 0 };
    const left = Math.min(...all.map((c) => c.layout.x));
    const bottom = Math.max(...all.map((c) => c.layout.y + c.layout.height));
    return { x: left, y: bottom + TEMPLATE_GAP * 3 };
  }
}
