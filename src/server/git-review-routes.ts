import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ConsoleGit,
  ConsoleInfo,
  CreateConsoleRequest,
  GitStats,
  Template,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { pickConsoleName } from './console-names.js';
import {
  GitConflictError,
  GitError,
  commitAll,
  createWorktree,
  discardWorktree,
  gitDiff,
  gitSummary,
  mergeBranch,
  repoInfo,
  slugify,
  type CreatedWorktree,
} from './worktrees.js';

const STATS_DEBOUNCE_MS = 1500;
const STATS_EVENTS = new Set(['PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']);

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GitConflictError) return reply.code(409).send({ error: message, conflicts: err.conflicts });
  if (err instanceof NotFoundError) return reply.code(404).send({ error: message });
  return reply.code(err instanceof GitError ? 409 : 400).send({ error: message });
}

function sameStats(a: GitStats | undefined, b: GitStats): boolean {
  return (
    !!a &&
    a.added === b.added &&
    a.removed === b.removed &&
    a.files === b.files &&
    a.ahead === b.ahead &&
    a.dirty === b.dirty
  );
}

// Worktree consoles: creation, review routes, and the "+N −M" stats on the console header.
export class WorktreeService {
  private queues = new Map<string, Promise<unknown>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly manager: ConsoleManager) {
    manager.on('hook', (id, payload) => {
      if (STATS_EVENTS.has(String(payload.hook_event_name))) this.scheduleStats(id);
    });
    manager.on('removed', (id) => {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    });
  }

  // One git operation at a time per repository (index.lock, refs)
  private serial<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = repoRoot.toLowerCase();
    const run = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.queues.set(key, run.catch(() => undefined));
    return run;
  }

  requireGit(id: string): { info: ConsoleInfo; git: ConsoleGit } {
    const info = this.manager.get(id);
    if (!info) throw new NotFoundError(`Unknown console ${id}`);
    if (!info.git) throw new GitError(`${info.name} does not work on its own branch`);
    return { info, git: info.git };
  }

  async createConsole(req: CreateConsoleRequest): Promise<ConsoleInfo> {
    const name = req.name?.trim() || pickConsoleName(this.manager.list().map((c) => c.name));
    const made = await createWorktree(req.cwd, name);
    let info: ConsoleInfo;
    try {
      info = this.manager.create({ cwd: made.cwd, name, layout: req.layout, accountId: req.accountId });
    } catch (err) {
      await discardWorktree(made.git).catch(() => undefined);
      throw err;
    }
    this.attach(info.id, made);
    return this.manager.get(info.id) ?? info;
  }

  attach(id: string, made: CreatedWorktree): void {
    const info = this.manager.get(id);
    if (!info) return;
    info.git = made.git;
    info.gitStats = { added: 0, removed: 0, files: 0, ahead: 0, dirty: false, at: Date.now() };
    this.manager.touch(id);
  }

  // Worktrees for a template launch: made up front (git is async, the launch is not)
  async prepareTemplate(template: Template, cwd: string): Promise<TemplateWorktrees> {
    const made: CreatedWorktree[] = [];
    try {
      for (const team of template.teams) {
        for (let i = 0; i < team.count; i++) {
          made.push(await createWorktree(cwd, `${slugify(team.role)}-${i + 1}`));
        }
      }
    } catch (err) {
      for (const m of made) await discardWorktree(m.git).catch(() => undefined);
      throw err;
    }
    const queue = [...made];
    const assigned = new Map<string, CreatedWorktree>();
    return {
      cwdFor: (role, key) => {
        if (role === 'Orchestrator') return cwd;
        const next = queue.shift();
        if (!next) return cwd;
        assigned.set(key, next);
        return next.cwd;
      },
      onSpawn: (info, key) => {
        const m = assigned.get(key);
        if (m) this.attach(info.id, m);
      },
      cleanup: async () => {
        for (const m of queue) await discardWorktree(m.git).catch(() => undefined);
      },
    };
  }

  async summary(id: string) {
    const { git } = this.requireGit(id);
    const summary = await this.serial(git.repoRoot, () => gitSummary(git));
    this.setStats(id, summary.stats);
    return summary;
  }

  async diff(id: string, file: unknown, scope: unknown) {
    const { git } = this.requireGit(id);
    const s = scope === 'committed' ? 'committed' : 'uncommitted';
    return this.serial(git.repoRoot, () => gitDiff(git, file, s));
  }

  async commit(id: string, message: unknown) {
    const { git } = this.requireGit(id);
    if (typeof message !== 'string' || !message.trim()) throw new GitError('A commit message is required');
    await this.serial(git.repoRoot, () => commitAll(git, message.slice(0, 5000)));
    return this.summary(id);
  }

  async merge(id: string) {
    const { info, git } = this.requireGit(id);
    await this.serial(git.repoRoot, () => mergeBranch(git, info.name));
    return this.summary(id);
  }

  async discard(id: string): Promise<void> {
    const { git } = this.requireGit(id);
    this.manager.remove(id); // stop claude first so Windows releases the folder
    await this.serial(git.repoRoot, () => discardWorktree(git));
  }

  private scheduleStats(id: string): void {
    if (!this.manager.get(id)?.git) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.summary(id).catch(() => undefined);
    }, STATS_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private setStats(id: string, stats: GitStats): void {
    const info = this.manager.get(id);
    if (!info || sameStats(info.gitStats, stats)) return;
    info.gitStats = stats;
    this.manager.touch(id);
  }
}

export interface TemplateWorktrees {
  cwdFor: (role: string, key: string) => string;
  onSpawn: (info: ConsoleInfo, key: string) => void;
  cleanup: () => Promise<void>;
}

export async function registerGitReviewRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager },
): Promise<WorktreeService> {
  const service = new WorktreeService(options.manager);

  app.get('/api/git/info', async (request, reply) => {
    const { path: dir } = request.query as { path?: string };
    if (typeof dir !== 'string' || !dir.trim()) return reply.code(400).send({ error: 'path is required' });
    try {
      return await repoInfo(dir);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/consoles/:id/git/summary', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await service.summary(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/consoles/:id/git/diff', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { file, scope } = request.query as { file?: string; scope?: string };
    try {
      return await service.diff(id, file, scope);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/consoles/:id/git/commit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const message = (request.body as { message?: unknown } | undefined)?.message;
    try {
      return await service.commit(id, message);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/consoles/:id/git/merge', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await service.merge(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/consoles/:id/git/discard', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await service.discard(id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return service;
}
