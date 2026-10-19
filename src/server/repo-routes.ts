import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GitRemoteResult } from '../shared/repo.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { CodeError, CodeFiles } from './code-files.js';
import {
  checkoutBranch,
  commitPatch,
  commitStaged,
  createBranch,
  fetchAll,
  fileDiff,
  listBranches,
  pull,
  push,
  recentCommits,
  repoStatus,
  stage,
  unstage,
} from './git-repo.js';
import { GitError, repoInfo } from './worktrees.js';

// Git panel (/api/git/repo/:id/...) and code viewer (/api/code/:id/...) routes. The folder always
// comes from the console itself: its repository for git, its repository (or folder) for files.

const ROOT_TTL_MS = 10_000;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotFoundError) return reply.code(404).send({ error: message });
  if (err instanceof CodeError) return reply.code(err.status).send({ error: message });
  return reply.code(err instanceof GitError ? 409 : 400).send({ error: message });
}

export async function registerRepoRoutes(app: FastifyInstance, options: { manager: ConsoleManager }): Promise<void> {
  const { manager } = options;
  const files = new CodeFiles();
  const roots = new Map<string, { at: number; repoRoot: string | null }>();
  const queues = new Map<string, Promise<unknown>>();

  // One git operation at a time per repository (index.lock, refs)
  const serial = <T>(repoRoot: string, fn: () => Promise<T>): Promise<T> => {
    const key = repoRoot.toLowerCase();
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    queues.set(key, run.catch(() => undefined));
    return run;
  };

  const consoleOf = (id: string) => {
    const info = manager.get(id);
    if (!info) throw new NotFoundError(`Unknown console ${id}`);
    return info;
  };

  const repoOf = async (id: string): Promise<{ cwd: string; repoRoot: string | null; worktree: boolean }> => {
    const info = consoleOf(id);
    const cwd = path.resolve(info.cwd);
    if (!fs.existsSync(cwd)) throw new CodeError(`The console's folder no longer exists: ${cwd}`, 404);
    const key = `${id}\0${cwd}`;
    const hit = roots.get(key);
    if (hit && Date.now() - hit.at < ROOT_TTL_MS) return { cwd, repoRoot: hit.repoRoot, worktree: !!info.git };
    const { repoRoot } = await repoInfo(cwd);
    roots.set(key, { at: Date.now(), repoRoot });
    return { cwd, repoRoot, worktree: !!info.git };
  };

  const requireRepo = async (id: string) => {
    const r = await repoOf(id);
    if (!r.repoRoot) throw new GitError(`${consoleOf(id).name}'s folder is not inside a git repository`);
    return { root: r.repoRoot, worktree: r.worktree };
  };

  manager.on('removed', (id) => {
    for (const key of roots.keys()) if (key.startsWith(`${id}\0`)) roots.delete(key);
  });

  const status = (root: string, worktree: boolean) => repoStatus(root, worktree);

  type Handler = (root: string, worktree: boolean, body: Record<string, unknown>, query: Record<string, unknown>) => Promise<unknown>;
  const gitRoute = (method: 'get' | 'post', name: string, handler: Handler) => {
    app[method](`/api/git/repo/:id/${name}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const { root, worktree } = await requireRepo(id);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const query = (request.query ?? {}) as Record<string, unknown>;
        return await serial(root, () => handler(root, worktree, body, query));
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };

  gitRoute('get', 'status', (root, wt) => status(root, wt));
  gitRoute('get', 'branches', (root) => listBranches(root));
  gitRoute('post', 'checkout', async (root, wt, body) => {
    await checkoutBranch(root, body.branch);
    return status(root, wt);
  });
  gitRoute('post', 'branch', async (root, wt, body) => {
    await createBranch(root, body.name, body.checkout !== false);
    return status(root, wt);
  });
  gitRoute('get', 'diff', (root, _wt, _b, q) => fileDiff(root, q.file, q.scope === 'staged' ? 'staged' : 'unstaged'));
  gitRoute('post', 'stage', async (root, wt, body) => {
    await stage(root, body.files);
    return status(root, wt);
  });
  gitRoute('post', 'unstage', async (root, wt, body) => {
    await unstage(root, body.files);
    return status(root, wt);
  });
  gitRoute('post', 'commit', async (root, wt, body) => {
    await commitStaged(root, body.message);
    return status(root, wt);
  });
  const withStatus = async (root: string, wt: boolean, r: GitRemoteResult): Promise<GitRemoteResult> => ({
    ...r,
    status: await status(root, wt),
  });
  gitRoute('post', 'push', async (root, wt) => withStatus(root, wt, await push(root)));
  gitRoute('post', 'pull', async (root, wt, body) => withStatus(root, wt, await pull(root, body.mode)));
  gitRoute('post', 'fetch', async (root, wt) => withStatus(root, wt, await fetchAll(root)));
  gitRoute('get', 'log', (root) => recentCommits(root));
  gitRoute('get', 'show', (root, _wt, _b, q) => commitPatch(root, q.hash));

  // ---------- code viewer ----------

  const codeRoute = (name: string, handler: (root: string, inRepo: boolean, query: Record<string, unknown>) => unknown) => {
    app.get(`/api/code/:id/${name}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const r = await repoOf(id);
        return await handler(r.repoRoot ?? r.cwd, !!r.repoRoot, (request.query ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendError(reply, err);
      }
    });
  };

  codeRoute('tree', (root, inRepo, q) => files.tree(root, inRepo, q.dir));
  codeRoute('search', (root, inRepo, q) => files.search(root, inRepo, q.q));
  codeRoute('file', (root, _inRepo, q) => files.read(root, q.path));
  codeRoute('stat', (root, _inRepo, q) => files.stat(root, q.path));
}
