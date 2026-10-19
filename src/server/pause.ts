import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  RESUME_PROMPT,
  type ConsoleInfo,
  type ConsoleStatus,
  type PauseResponse,
  type TeamSendResponse,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { BadRequestError } from './projects.js';

// Pause all: Esc interrupts every working agent (optionally one project's) and marks it paused.
// Resume all: types RESUME_PROMPT into the paused ones. Typing into a paused console yourself
// (any UserPromptSubmit) also clears the mark.

// Claude Code queues text typed while it works; a dialog (needs_you) would swallow it instead
const TEAM_TYPEABLE = new Set<ConsoleStatus>(['idle', 'resting', 'working', 'error']);
const MAX_TEAM_TEXT = 20_000;

export class PauseService {
  constructor(private readonly manager: ConsoleManager) {
    manager.on('hook', (id, payload) => {
      if (payload.hook_event_name === 'UserPromptSubmit' || payload.hook_event_name === 'SessionEnd') this.clear(id);
    });
  }

  scope(projectId?: string | null): ConsoleInfo[] {
    if (!projectId) return this.manager.list();
    const project = this.manager.projects.find((p) => p.id === projectId);
    if (!project) throw new NotFoundError(`Unknown project ${projectId}`);
    return project.consoleIds.map((id) => this.manager.get(id)).filter((c): c is ConsoleInfo => !!c);
  }

  pausedCount(projectId?: string | null): number {
    return this.scope(projectId).filter((c) => c.paused).length;
  }

  pause(projectId?: string | null): PauseResponse {
    const names: string[] = [];
    for (const c of this.scope(projectId)) {
      if (c.status !== 'working') continue;
      this.manager.input(c.id, '\x1b');
      // An interrupted turn fires no Stop hook, so mark it resting here; the next hook takes over
      c.paused = true;
      c.status = 'resting';
      c.statusDetail = 'Paused';
      c.statusChangedAt = Date.now();
      this.manager.touch(c.id);
      names.push(c.name);
    }
    return { count: names.length, names };
  }

  resume(projectId?: string | null): PauseResponse {
    const names: string[] = [];
    for (const c of this.scope(projectId)) {
      if (!c.paused) continue;
      delete c.paused;
      if (c.statusDetail === 'Paused') c.statusDetail = undefined;
      // Consoles that stopped meanwhile lose the mark too; there is nothing to type into
      if (this.manager.sendText(c.id, RESUME_PROMPT)) names.push(c.name);
      this.manager.touch(c.id);
    }
    return { count: names.length, names };
  }

  // One message to every running console of a project (team)
  sendToProject(projectId: string, text: string): TeamSendResponse {
    if (typeof text !== 'string' || !text.trim()) throw new BadRequestError('text is required');
    if (text.length > MAX_TEAM_TEXT) throw new BadRequestError('The message is too long');
    const names: string[] = [];
    const skipped: string[] = [];
    for (const c of this.scope(projectId)) {
      if (TEAM_TYPEABLE.has(c.status) && this.manager.sendText(c.id, text)) names.push(c.name);
      else skipped.push(c.name);
    }
    return { sent: names.length, names, skipped };
  }

  private clear(id: string): void {
    const c = this.manager.get(id);
    if (!c?.paused) return;
    delete c.paused;
    if (c.statusDetail === 'Paused') c.statusDetail = undefined;
    this.manager.touch(id);
  }
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

function projectIdOf(body: unknown): string | undefined {
  const value = (body as { projectId?: unknown } | undefined)?.projectId;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestError('projectId must be a string');
  return value;
}

export function registerPauseRoutes(app: FastifyInstance, options: { manager: ConsoleManager }): PauseService {
  const pause = new PauseService(options.manager);

  app.post('/api/pause', async (request, reply) => {
    try {
      return pause.pause(projectIdOf(request.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/resume-paused', async (request, reply) => {
    try {
      return pause.resume(projectIdOf(request.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/projects/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const text = (request.body as { text?: unknown } | undefined)?.text;
    try {
      return pause.sendToProject(id, text as string);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return pause;
}
