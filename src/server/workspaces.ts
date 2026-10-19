import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MoveToWorkspaceRequest, Workspace, WorkspacesState } from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { BadRequestError, isProjectColor, type ProjectService } from './projects.js';

// Workspaces are board tabs. Everything on the board carries a workspaceId; the UI shows one
// workspace at a time and consoles keep running on the others.

export class ConflictError extends Error {
  constructor(
    message: string,
    readonly count: number,
  ) {
    super(message);
  }
}

function cleanName(raw: unknown, fallback?: string): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestError('name cannot be empty');
  return raw.trim().slice(0, 60);
}

function stringIds(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    throw new BadRequestError(`${field} must be an array of ids`);
  }
  return [...new Set(raw as string[])];
}

export class WorkspaceService {
  constructor(
    private readonly manager: ConsoleManager,
    private readonly projects?: ProjectService,
  ) {}

  state(): WorkspacesState {
    return { workspaces: this.sorted(), activeWorkspaceId: this.manager.activeWorkspaceId };
  }

  get(id: string): Workspace {
    const ws = this.manager.workspaces.find((w) => w.id === id);
    if (!ws) throw new NotFoundError(`Unknown workspace ${id}`);
    return ws;
  }

  create(req: { name?: unknown; color?: unknown } = {}): Workspace {
    if (req.color !== undefined && !isProjectColor(req.color)) throw new BadRequestError('invalid color');
    const list = this.manager.workspaces;
    const ws: Workspace = {
      id: `w-${crypto.randomUUID().slice(0, 8)}`,
      name: cleanName(req.name, this.nextName()),
      ...(req.color ? { color: req.color } : {}),
      createdAt: Date.now(),
      order: list.reduce((max, w) => Math.max(max, w.order), -1) + 1,
    };
    list.push(ws);
    this.manager.activeWorkspaceId = ws.id;
    this.changed();
    return ws;
  }

  update(id: string, req: { name?: unknown; color?: unknown; viewport?: unknown }): Workspace {
    const ws = this.get(id);
    if (req.name !== undefined) ws.name = cleanName(req.name);
    if (req.color !== undefined) {
      if (req.color !== null && !isProjectColor(req.color)) throw new BadRequestError('invalid color');
      if (req.color === null) delete ws.color;
      else ws.color = req.color;
    }
    if (req.viewport !== undefined) {
      const v = req.viewport as Record<string, unknown> | null;
      const ok = v && [v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n));
      if (!ok) throw new BadRequestError('viewport must be { x, y, zoom } numbers');
      ws.viewport = { x: v.x as number, y: v.y as number, zoom: v.zoom as number };
      // Viewport moves are frequent: persist without a broadcast to every tab
      this.manager.persist();
      if (req.name === undefined && req.color === undefined) return ws;
    }
    this.changed();
    return ws;
  }

  // Number of consoles, projects, browser tiles and items on the workspace
  contents(id: string): number {
    const m = this.manager;
    return (
      m.list().filter((c) => c.workspaceId === id).length +
      m.projects.filter((p) => p.workspaceId === id).length +
      m.browsers.filter((b) => b.workspaceId === id).length +
      m.items.filter((i) => i.workspaceId === id).length
    );
  }

  remove(id: string, moveTo?: unknown): void {
    this.get(id);
    if (this.manager.workspaces.length === 1) throw new BadRequestError('cannot delete the last workspace');
    const count = this.contents(id);
    if (count > 0) {
      if (moveTo === undefined) throw new ConflictError(`Workspace has ${count} things on it; pass moveTo`, count);
      if (typeof moveTo !== 'string' || moveTo === id) throw new BadRequestError('moveTo must be another workspace');
      this.get(moveTo);
      this.moveAll(id, moveTo);
    }
    const list = this.manager.workspaces;
    list.splice(list.findIndex((w) => w.id === id), 1);
    if (this.manager.activeWorkspaceId === id) {
      this.manager.activeWorkspaceId = typeof moveTo === 'string' ? moveTo : this.sorted()[0].id;
    }
    this.changed();
  }

  reorder(raw: unknown): void {
    const ids = stringIds(raw, 'ids');
    const known = this.manager.workspaces;
    if (ids.length !== known.length || !known.every((w) => ids.includes(w.id))) {
      throw new BadRequestError('ids must list every workspace once');
    }
    for (const ws of known) ws.order = ids.indexOf(ws.id);
    this.changed();
  }

  setActive(id: unknown): void {
    if (typeof id !== 'string') throw new BadRequestError('id is required');
    this.get(id);
    if (this.manager.activeWorkspaceId === id) return;
    this.manager.activeWorkspaceId = id;
    this.changed();
  }

  move(target: string, req: MoveToWorkspaceRequest): void {
    this.get(target);
    const m = this.manager;
    const consoleIds = new Set(stringIds(req.consoleIds, 'consoleIds'));
    const projectIds = stringIds(req.projectIds, 'projectIds');
    for (const pid of projectIds) {
      const project = m.projects.find((p) => p.id === pid);
      if (!project) throw new NotFoundError(`Unknown project ${pid}`);
      project.workspaceId = target;
      m.emit('project', project);
      for (const cid of project.consoleIds) consoleIds.add(cid);
    }
    for (const cid of consoleIds) {
      const info = m.get(cid);
      if (!info) throw new NotFoundError(`Unknown console ${cid}`);
      if (info.workspaceId === target) continue;
      info.workspaceId = target;
      m.touch(cid);
      this.leaveProjectIfElsewhere(cid, target);
    }
    for (const bid of stringIds(req.browserIds, 'browserIds')) {
      const tile = m.browsers.find((b) => b.id === bid);
      if (!tile) throw new NotFoundError(`Unknown browser tile ${bid}`);
      tile.workspaceId = target;
      m.emit('browser', tile);
    }
    for (const iid of stringIds(req.itemIds, 'itemIds')) {
      const item = m.items.find((i) => i.id === iid);
      if (!item) throw new NotFoundError(`Unknown item ${iid}`);
      item.workspaceId = target;
      item.updatedAt = Date.now();
      m.emit('item', item);
    }
    m.persist();
  }

  private moveAll(from: string, to: string): void {
    const m = this.manager;
    this.move(to, {
      consoleIds: m.list().filter((c) => c.workspaceId === from).map((c) => c.id),
      projectIds: m.projects.filter((p) => p.workspaceId === from).map((p) => p.id),
      browserIds: m.browsers.filter((b) => b.workspaceId === from).map((b) => b.id),
      itemIds: m.items.filter((i) => i.workspaceId === from).map((i) => i.id),
    });
  }

  // A console moved on its own leaves a project that stays on another workspace
  private leaveProjectIfElsewhere(consoleId: string, target: string): void {
    const project = this.manager.projects.find((p) => p.consoleIds.includes(consoleId));
    if (!project || project.workspaceId === target || !this.projects) return;
    const rest = project.consoleIds.filter((c) => c !== consoleId);
    if (rest.length === 0) this.projects.remove(project.id);
    else this.projects.update(project.id, { consoleIds: rest });
  }

  private nextName(): string {
    const names = new Set(this.manager.workspaces.map((w) => w.name.toLowerCase()));
    for (let i = this.manager.workspaces.length + 1; ; i++) {
      if (!names.has(`workspace ${i}`)) return `Workspace ${i}`;
    }
  }

  private sorted(): Workspace[] {
    return [...this.manager.workspaces].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  private changed(): void {
    this.manager.emit('workspaces');
    this.manager.persist();
  }
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ConflictError) return reply.code(409).send({ error: message, count: err.count });
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

export function registerWorkspaceTabRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager; projects?: ProjectService },
): WorkspaceService {
  const service = new WorkspaceService(options.manager, options.projects);
  const run = async <T>(reply: FastifyReply, fn: () => T): Promise<T | FastifyReply> => {
    try {
      return fn();
    } catch (err) {
      return sendError(reply, err);
    }
  };
  type Body = Record<string, unknown>;
  const body = (raw: unknown): Body => (raw && typeof raw === 'object' ? (raw as Body) : {});

  app.get('/api/workspaces', async () => service.state());
  app.post('/api/workspaces', (request, reply) => run(reply, () => service.create(body(request.body))));
  // Static paths before /:id
  app.put('/api/workspaces/order', (request, reply) =>
    run(reply, () => (service.reorder(body(request.body).ids), { ok: true })),
  );
  app.put('/api/workspaces/active', (request, reply) =>
    run(reply, () => (service.setActive(body(request.body).id), { ok: true })),
  );
  app.patch('/api/workspaces/:id', (request, reply) =>
    run(reply, () => service.update((request.params as { id: string }).id, body(request.body))),
  );
  app.delete('/api/workspaces/:id', (request, reply) => {
    const moveTo = body(request.body).moveTo ?? (request.query as { moveTo?: string }).moveTo;
    return run(reply, () => (service.remove((request.params as { id: string }).id, moveTo), { ok: true }));
  });
  app.post('/api/workspaces/:id/move', (request, reply) =>
    run(reply, () => (service.move((request.params as { id: string }).id, body(request.body)), { ok: true })),
  );
  return service;
}
