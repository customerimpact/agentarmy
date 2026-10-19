import crypto from 'node:crypto';
import { isAgentKind } from '../shared/agents.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  MAX_COMPOSER_ROWS,
  type ComposeRequest,
  type ComposerRow,
  type ConsoleInfo,
  type ConsoleLayout,
  type LaunchTemplateRequest,
  type LaunchTemplateResponse,
  type SaveTemplateRequest,
  type Template,
  type TemplateTeam,
} from '../shared/protocol.js';
import { fillPrompt, FRAME_PADDING, FRAME_TITLE_HEIGHT, TEMPLATE_GAP } from '../shared/templates.js';
import { composerColumns, composerFrameSize } from '../shared/composer.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { DEFAULT_SIZE } from './placement.js';
import { BadRequestError, type ProjectService } from './projects.js';
import { FirstPromptQueue } from './templates.js';
import type { WorktreeService } from './git-review-routes.js';

// Composer: launch up to 12 consoles in one step, each with its own name, role, first prompt,
// account and optional isolated branch, grouped in one project frame. Rows can be saved as a
// custom template (<AGENTARMY_HOME>/templates.json) that shows up next to the built-in ones.

const MAX_NAME = 40;
const MAX_ROLE = 40;
const MAX_PROMPT = 8000;

export { composerColumns };

// Same frame rules as template teams (src/shared/templates.ts): title bar + padding around a grid
export function layoutComposer(
  count: number,
  origin = { x: 0, y: 0 },
  size: { width: number; height: number } = DEFAULT_SIZE,
): { frame: ConsoleLayout; consoles: ConsoleLayout[] } {
  const { cols, width, height } = composerFrameSize(count, size);
  const consoles: ConsoleLayout[] = [];
  for (let k = 0; k < count; k++) {
    const col = k % cols;
    const row = Math.floor(k / cols);
    consoles.push({
      x: origin.x + FRAME_PADDING + col * (size.width + TEMPLATE_GAP),
      y: origin.y + FRAME_TITLE_HEIGHT + FRAME_PADDING + row * (size.height + TEMPLATE_GAP),
      ...size,
    });
  }
  return {
    frame: { ...origin, width, height },
    consoles,
  };
}

function cleanText(value: unknown, max: number, what: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestError(`${what} must be a string`);
  const text = value.trim();
  if (text.length > max) throw new BadRequestError(`${what} is too long (${max} characters max)`);
  return text;
}

export function parseRows(raw: unknown): ComposerRow[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestError('Add at least one agent');
  if (raw.length > MAX_COMPOSER_ROWS) throw new BadRequestError(`At most ${MAX_COMPOSER_ROWS} agents per launch`);
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') throw new BadRequestError(`Row ${i + 1} must be an object`);
    const row = r as Record<string, unknown>;
    const name = cleanText(row.name, MAX_NAME, 'name');
    const role = cleanText(row.role, MAX_ROLE, 'role');
    const prompt = cleanText(row.prompt, MAX_PROMPT, 'prompt');
    const accountId = typeof row.accountId === 'string' && row.accountId && row.accountId !== 'auto' ? row.accountId : undefined;
    return {
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
      ...(prompt ? { prompt } : {}),
      ...(accountId ? { accountId } : {}),
      ...(row.worktree === true ? { worktree: true } : {}),
      ...(isAgentKind(row.agent) && row.agent !== 'claude' && row.agent !== 'custom' ? { agent: row.agent } : {}),
    };
  });
}

// Custom templates list one team per role, so the gallery card and schematic work unchanged
export function teamsFromRows(rows: ComposerRow[]): TemplateTeam[] {
  const teams = new Map<string, TemplateTeam>();
  for (const row of rows) {
    const role = row.role || 'General';
    const team = teams.get(role);
    if (team) team.count++;
    else teams.set(role, { name: role, role, count: 1, ...(row.prompt ? { prompt: row.prompt } : {}) });
  }
  return [...teams.values()];
}

export class ComposerService {
  private readonly prompts: FirstPromptQueue;

  constructor(
    private readonly manager: ConsoleManager,
    private readonly projects: ProjectService,
    private readonly worktrees?: WorktreeService,
    prompts?: FirstPromptQueue,
  ) {
    this.prompts = prompts ?? new FirstPromptQueue(manager);
  }

  async launch(req: ComposeRequest): Promise<LaunchTemplateResponse> {
    if (!req || typeof req.cwd !== 'string' || !req.cwd.trim()) throw new BadRequestError('cwd is required');
    const cwd = path.resolve(req.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new BadRequestError(`Not a directory: ${cwd}`);
    const rows = parseRows(req.rows);
    const projectName = cleanText(req.projectName, 80, 'projectName') || path.basename(cwd) || 'Team';
    const origin =
      req.origin && Number.isFinite(req.origin.x) && Number.isFinite(req.origin.y)
        ? { x: req.origin.x, y: req.origin.y }
        : this.freeOrigin();
    const layout = layoutComposer(rows.length, origin);

    const created: ConsoleInfo[] = [];
    try {
      for (const [i, row] of rows.entries()) {
        const base = { cwd, name: row.name, layout: layout.consoles[i], accountId: row.accountId, agent: row.agent };
        const info =
          row.worktree && this.worktrees
            ? await this.worktrees.createConsole({ ...base, worktree: true })
            : this.manager.create(base);
        if (row.role) {
          info.role = row.role;
          this.manager.touch(info.id);
        }
        created.push(info);
      }
    } catch (err) {
      // All or nothing: a bad account or a failed worktree leaves no half team behind
      for (const c of created) {
        try {
          this.manager.remove(c.id);
        } catch {
          // already gone
        }
      }
      throw err;
    }

    const project = this.projects.create({ name: projectName, consoleIds: created.map((c) => c.id) });
    rows.forEach((row, i) => {
      if (!row.prompt) return;
      const c = created[i];
      this.prompts.add(c.id, fillPrompt(row.prompt, { name: c.name, team: project.name, role: row.role || 'General' }));
    });
    return { projects: [project], consoles: created.map((c) => this.manager.get(c.id) ?? c) };
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

// ---------- Custom templates ----------

interface TemplatesFile {
  version: 1;
  templates: Template[];
}

export class CustomTemplates {
  private templates: Template[] = [];
  composer: ComposerService | null = null; // set once the project service exists

  constructor(readonly filePath: string | null) {
    this.templates = this.load();
  }

  list(): Template[] {
    return this.templates;
  }

  find(id: string): Template | undefined {
    return this.templates.find((t) => t.id === id);
  }

  save(raw: SaveTemplateRequest): Template {
    if (!raw || typeof raw !== 'object') throw new BadRequestError('Expected a JSON object');
    const name = cleanText(raw.name, 60, 'name');
    if (!name) throw new BadRequestError('Name the template');
    const rows = parseRows(raw.rows);
    const description =
      cleanText(raw.description, 200, 'description') ||
      `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}: ${teamsFromRows(rows)
        .map((t) => (t.count > 1 ? `${t.count} ${t.name}` : t.name))
        .join(', ')}`;
    const template: Template = {
      id: `custom-${crypto.randomUUID().slice(0, 8)}`,
      name,
      description,
      orchestrator: false,
      teams: teamsFromRows(rows),
      custom: true,
      rows,
    };
    this.templates.push(template);
    this.write();
    return template;
  }

  remove(id: string): void {
    const index = this.templates.findIndex((t) => t.id === id);
    if (index < 0) throw new NotFoundError(`Unknown custom template ${id}`);
    this.templates.splice(index, 1);
    this.write();
  }

  // null when id is not a custom template (the built-in launcher handles it)
  launch(id: string, req: LaunchTemplateRequest): Promise<LaunchTemplateResponse> | null {
    const template = this.find(id);
    if (!template) return null;
    if (!this.composer) throw new Error('Composer is not ready');
    const rows = (template.rows ?? []).map((row) => ({
      ...row,
      ...(req.worktrees === true ? { worktree: true } : {}),
      ...(req.accountId && req.accountId !== 'auto' ? { accountId: req.accountId } : {}),
    }));
    return this.composer.launch({
      cwd: req.cwd,
      projectName: req.projectName ?? template.name,
      rows,
      origin: req.origin,
    });
  }

  private load(): Template[] {
    if (!this.filePath) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<TemplatesFile>;
      if (!Array.isArray(parsed.templates)) return [];
      return parsed.templates
        .filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.rows))
        .map((t) => {
          const rows = parseRows(t.rows);
          return { ...t, custom: true, orchestrator: false, rows, teams: teamsFromRows(rows) };
        });
    } catch {
      return [];
    }
  }

  private write(): void {
    if (!this.filePath) return;
    const data: TemplatesFile = { version: 1, templates: this.templates };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try {
      fs.renameSync(tmp, this.filePath);
    } catch {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      fs.rmSync(tmp, { force: true });
    }
  }
}

// ---------- Routes ----------

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

export function registerComposerRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager; projects: ProjectService; worktrees?: WorktreeService; custom: CustomTemplates },
): ComposerService {
  const composer = new ComposerService(options.manager, options.projects, options.worktrees);
  options.custom.composer = composer;

  app.post('/api/compose', async (request, reply) => {
    try {
      return await composer.launch((request.body ?? {}) as ComposeRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/templates/custom', async (request, reply) => {
    try {
      return options.custom.save((request.body ?? {}) as SaveTemplateRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/templates/custom/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.custom.remove(id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return composer;
}
