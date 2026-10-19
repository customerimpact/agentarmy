import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAgentKind } from '../shared/agents.js';
import type {
  CreateProjectRequest,
  LaunchTemplateRequest,
  LaunchTemplateResponse,
  Template,
  UpdateProjectRequest,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { cloneRepo } from './git-clone.js';
import { ProjectService } from './projects.js';
import { FirstPromptQueue, TemplateService } from './templates.js';
import type { WorktreeService } from './git-review-routes.js';

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Projects, templates, git clone and POST /api/consoles/:id/send.
export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: {
    manager: ConsoleManager;
    worktrees?: WorktreeService;
    // Composer's saved templates (composer.ts): listed after the built-ins; launch returns null for others
    custom?: { list(): Template[]; launch(id: string, req: LaunchTemplateRequest): Promise<LaunchTemplateResponse> | null };
  },
): Promise<{ projects: ProjectService; templates: TemplateService }> {
  const { manager, worktrees } = options;
  const projects = new ProjectService(manager);
  const templates = new TemplateService(manager, projects, new FirstPromptQueue(manager));

  app.post('/api/consoles/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const text = (request.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || !text) return reply.code(400).send({ error: 'text is required' });
    if (!manager.get(id)) return reply.code(404).send({ error: `Unknown console ${id}` });
    if (!manager.sendText(id, text)) {
      return reply.code(409).send({ error: 'Console is not running' });
    }
    return { ok: true };
  });

  app.post('/api/projects', async (request, reply) => {
    try {
      return projects.create((request.body ?? {}) as CreateProjectRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return projects.update(id, (request.body ?? {}) as UpdateProjectRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      projects.remove(id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/projects/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return projects.close(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/projects/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return projects.open(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/templates', async () => [...templates.templates, ...(options.custom?.list() ?? [])]);

  app.post('/api/templates/:id/launch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as LaunchTemplateRequest;
    if (typeof body.cwd !== 'string' || !body.cwd.trim()) {
      return reply.code(400).send({ error: 'cwd is required' });
    }
    if (body.projectName !== undefined && typeof body.projectName !== 'string') {
      return reply.code(400).send({ error: 'projectName must be a string' });
    }
    const origin = body.origin;
    if (origin !== undefined && !(isFiniteNumber(origin?.x) && isFiniteNumber(origin?.y))) {
      return reply.code(400).send({ error: 'origin must be { x, y } numbers' });
    }
    try {
      const req = {
        cwd: body.cwd,
        projectName: body.projectName,
        origin: origin ? { x: origin.x, y: origin.y } : undefined,
        accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
        teamAgents: Array.isArray(body.teamAgents) ? body.teamAgents.map((a) => (isAgentKind(a) ? a : 'claude')) : undefined,
      };
      const custom = options.custom?.launch(id, { ...req, worktrees: body.worktrees === true });
      if (custom) return await custom;
      const template = templates.templates.find((t) => t.id === id);
      if (body.worktrees === true && worktrees && template) {
        // Each agent gets its own branch; worktrees are made before any console starts
        const plan = await worktrees.prepareTemplate(template, body.cwd);
        try {
          return templates.launch(id, req, plan);
        } finally {
          await plan.cleanup();
        }
      }
      return templates.launch(id, req);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/git/clone', async (request, reply) => {
    const body = (request.body ?? {}) as { url?: unknown; parent?: unknown };
    try {
      return await cloneRepo(body.url, body.parent);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return { projects, templates };
}
