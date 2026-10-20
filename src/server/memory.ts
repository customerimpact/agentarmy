import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ConsoleInfo,
  ConsoleStatus,
  MemoryDoc,
  MemoryPushRequest,
  MemoryPushResponse,
  MemoryScope,
} from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import { registerBridgeTool, textResult } from './bridge-tools.js';

// Project memory: markdown notes the user (or an agent, via append_memory) keeps per folder and
// globally, typed into agents on demand or automatically into new agents.
// <dir>/global.md, <dir>/<folderKey>.md (first line: a header with the folder path),
// <dir>/memory.json { autoPush: { global?: true, <folderKey>?: true } }.

export const PUSH_PREFIX = 'Project memory (from GridHive):';
const MAX_CONTENT = 200_000;
const MAX_APPEND = 4000;
const AUTO_PUSH_DELAY_MS = 1500; // after a template's first prompt (sent 800 ms after the first idle)
const AUTO_PUSH_TIMEOUT_MS = 3 * 60_000;
const TYPEABLE = new Set<ConsoleStatus>(['idle', 'resting', 'working', 'error']);
// agentarmy: files written before the rename to GridHive
const HEADER_RE = /^<!-- (?:gridhive|agentarmy) memory for folder: (.*) -->\r?\n/;

export class MemoryError extends Error {}

// Same folder, same key: resolved, no trailing separator, case-insensitive on Windows
export function normalizeFolder(folder: string, platform: NodeJS.Platform = process.platform): string {
  let p = path.resolve(folder);
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:\\$/.test(p)) p = p.slice(0, -1);
  return platform === 'win32' ? p.toLowerCase() : p;
}

export function folderKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  return crypto.createHash('sha1').update(normalizeFolder(folder, platform)).digest('hex').slice(0, 16);
}

// The folder a console's memory belongs to: the repo for worktree agents, else its cwd
export function consoleFolder(info: Pick<ConsoleInfo, 'cwd' | 'git'>): string {
  return info.git?.repoRoot ?? info.cwd;
}

export function pushMessage(content: string): string {
  return `${PUSH_PREFIX}\n${content.trim()}`;
}

function stamp(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Stored {
  content: string;
  folder?: string;
  updatedAt: number | null;
}

export class MemoryStore {
  private mem = new Map<string, Stored>(); // dir null: in memory only (tests)
  private autoPush: Record<string, boolean> = {};

  constructor(
    readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {
    if (dir) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')) as { autoPush?: unknown };
        if (raw.autoPush && typeof raw.autoPush === 'object') {
          for (const [k, v] of Object.entries(raw.autoPush)) if (v === true) this.autoPush[k] = true;
        }
      } catch {
        // no settings yet
      }
    }
  }

  key(scope: MemoryScope, folder?: string): string {
    if (scope === 'global') return 'global';
    if (!folder?.trim()) throw new MemoryError('path is required for folder memory');
    return folderKey(folder);
  }

  filePath(scope: MemoryScope, folder?: string): string | null {
    return this.dir ? path.join(this.dir, `${this.key(scope, folder)}.md`) : null;
  }

  private load(key: string): Stored {
    if (!this.dir) return this.mem.get(key) ?? { content: '', updatedAt: null };
    const file = path.join(this.dir, `${key}.md`);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const header = HEADER_RE.exec(raw);
      return {
        content: header ? raw.slice(header[0].length) : raw,
        ...(header ? { folder: header[1] } : {}),
        updatedAt: fs.statSync(file).mtimeMs,
      };
    } catch {
      return { content: '', updatedAt: null };
    }
  }

  private save(key: string, content: string, folder?: string): void {
    if (!this.dir) {
      this.mem.set(key, { content, ...(folder ? { folder } : {}), updatedAt: this.now() });
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const header = folder ? `<!-- gridhive memory for folder: ${folder.replace(/-->/g, '')} -->\n` : '';
    const file = path.join(this.dir, `${key}.md`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, header + content);
    fs.renameSync(tmp, file);
  }

  private saveSettings(): void {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'memory.json'), JSON.stringify({ autoPush: this.autoPush }, null, 2));
  }

  read(scope: MemoryScope, folder?: string): MemoryDoc {
    const key = this.key(scope, folder);
    const stored = this.load(key);
    return {
      scope,
      ...(scope === 'folder' ? { path: stored.folder ?? path.resolve(folder!) } : {}),
      content: stored.content,
      autoPush: this.autoPush[key] === true,
      updatedAt: stored.updatedAt,
    };
  }

  write(scope: MemoryScope, folder: string | undefined, patch: { content?: string; autoPush?: boolean }): MemoryDoc {
    const key = this.key(scope, folder);
    if (patch.content !== undefined) {
      if (typeof patch.content !== 'string') throw new MemoryError('content must be a string');
      if (patch.content.length > MAX_CONTENT) throw new MemoryError('Memory is too long');
      this.save(key, patch.content, scope === 'folder' ? path.resolve(folder!) : undefined);
    }
    if (patch.autoPush !== undefined) {
      if (typeof patch.autoPush !== 'boolean') throw new MemoryError('autoPush must be true or false');
      if (patch.autoPush) this.autoPush[key] = true;
      else delete this.autoPush[key];
      this.saveSettings();
    }
    return this.read(scope, folder);
  }

  // Adds a timestamped entry at the end
  append(scope: MemoryScope, folder: string | undefined, text: string, author?: string): MemoryDoc {
    const entry = text.trim();
    if (!entry) throw new MemoryError('text is required');
    if (entry.length > MAX_APPEND) throw new MemoryError(`text is too long (max ${MAX_APPEND} characters)`);
    const current = this.read(scope, folder).content.replace(/\s+$/, '');
    const line = `### ${stamp(this.now())}${author ? ` (${author})` : ''}`;
    return this.write(scope, folder, { content: `${current ? `${current}\n\n` : ''}${line}\n${entry}\n` });
  }

  // Every folder memory on disk (or in memory)
  folders(): MemoryDoc[] {
    const keys = this.dir
      ? (() => {
          try {
            return fs.readdirSync(this.dir).filter((f) => /^[0-9a-f]{16}\.md$/.test(f)).map((f) => f.slice(0, 16));
          } catch {
            return [];
          }
        })()
      : [...this.mem.keys()].filter((k) => k !== 'global');
    return keys.flatMap((key) => {
      const stored = this.load(key);
      if (!stored.folder) return [];
      return [{ scope: 'folder' as const, path: stored.folder, content: stored.content, autoPush: this.autoPush[key] === true, updatedAt: stored.updatedAt }];
    });
  }
}

export class MemoryService {
  private pendingAuto = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly manager: ConsoleManager,
    readonly store: MemoryStore,
    private readonly autoDelayMs = AUTO_PUSH_DELAY_MS,
  ) {
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('console', (info) => this.onConsole(info));
    manager.on('removed', (id) => this.cancel(id));
  }

  push(req: MemoryPushRequest): MemoryPushResponse {
    const scope = req.scope === 'global' ? 'global' : req.scope === 'folder' ? 'folder' : null;
    if (!scope) throw new MemoryError('scope must be "global" or "folder"');
    if (!Array.isArray(req.consoleIds) || !req.consoleIds.length) throw new MemoryError('consoleIds is required');
    const doc = this.store.read(scope, req.path);
    if (!doc.content.trim()) throw new MemoryError('This memory is empty');
    const text = pushMessage(doc.content);
    const result: MemoryPushResponse = { sent: [], skipped: [] };
    for (const id of new Set(req.consoleIds.filter((x) => typeof x === 'string'))) {
      const c = this.manager.get(id);
      if (!c) result.skipped.push({ id, reason: 'not on the board' });
      else if (!TYPEABLE.has(c.status)) result.skipped.push({ id, reason: c.status === 'needs_you' ? 'waiting on you' : c.status });
      else if (!this.manager.sendText(id, text)) result.skipped.push({ id, reason: 'no running terminal' });
      else result.sent.push(id);
    }
    return result;
  }

  // The memory a new agent in this folder gets automatically ('' = nothing to push)
  autoPushText(info: ConsoleInfo): string {
    const parts: string[] = [];
    const global = this.store.read('global');
    const folder = this.store.read('folder', consoleFolder(info));
    if (global.autoPush && global.content.trim()) parts.push(global.content.trim());
    if (folder.autoPush && folder.content.trim()) parts.push(folder.content.trim());
    return parts.length ? pushMessage(parts.join('\n\n')) : '';
  }

  private onHook(id: string, payload: HookPayload): void {
    // A brand-new conversation (not a resume or /clear): push once it is idle
    if (payload.hook_event_name !== 'SessionStart' || payload.source !== 'startup') return;
    if (this.pendingAuto.has(id)) return;
    const timer = setTimeout(() => this.pendingAuto.delete(id), AUTO_PUSH_TIMEOUT_MS);
    timer.unref?.();
    this.pendingAuto.set(id, timer);
    const info = this.manager.get(id);
    if (info) this.onConsole(info);
  }

  private onConsole(info: ConsoleInfo): void {
    if (info.status !== 'idle' || !this.pendingAuto.has(info.id)) return;
    this.cancel(info.id);
    setTimeout(() => {
      const current = this.manager.get(info.id);
      if (!current) return;
      const text = this.autoPushText(current);
      if (text) this.manager.sendText(info.id, text);
    }, this.autoDelayMs).unref?.();
  }

  private cancel(id: string): void {
    const timer = this.pendingAuto.get(id);
    if (timer) clearTimeout(timer);
    this.pendingAuto.delete(id);
  }
}

function toolScope(value: unknown): MemoryScope | 'all' {
  if (value === 'global') return 'global';
  if (value === 'project' || value === 'folder') return 'folder';
  return 'all';
}

function registerMemoryTools(manager: ConsoleManager, store: MemoryStore): void {
  registerBridgeTool({
    name: 'read_memory',
    description:
      "Read the user's GridHive project memory: notes, conventions and learnings kept for this project folder " +
      '(scope "project") and for every project (scope "global"). Read it before starting unfamiliar work.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Default all' } },
      additionalProperties: false,
    },
    handler: async (consoleId, input) => {
      const me = manager.get(consoleId);
      if (!me) return textResult(`Unknown console ${consoleId}`, true);
      const scope = toolScope(input.scope);
      const folder = consoleFolder(me);
      const parts: string[] = [];
      if (scope !== 'folder') parts.push(`# Global memory\n${store.read('global').content.trim() || '(empty)'}`);
      if (scope !== 'global') parts.push(`# Project memory for ${folder}\n${store.read('folder', folder).content.trim() || '(empty)'}`);
      return textResult(parts.join('\n\n'));
    },
  });

  registerBridgeTool({
    name: 'append_memory',
    description:
      "Record a durable learning in the user's GridHive project memory so future agents get it: a convention, " +
      'a command that works, a gotcha, a decision. One or two sentences; not progress updates. Scope "project" ' +
      '(default) is this folder; "global" applies to every project.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The learning, in plain words' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Default project' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (consoleId, input) => {
      const me = manager.get(consoleId);
      if (!me) return textResult(`Unknown console ${consoleId}`, true);
      const scope = input.scope === 'global' ? 'global' : 'folder';
      const folder = consoleFolder(me);
      store.append(scope, scope === 'folder' ? folder : undefined, typeof input.text === 'string' ? input.text : '', me.name);
      return textResult(`Saved to the ${scope === 'global' ? 'global' : `project (${folder})`} memory.`);
    },
  });
}

export function registerMemoryRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager; dir: string | null; autoDelayMs?: number },
): MemoryService {
  const store = new MemoryStore(options.dir);
  const service = new MemoryService(options.manager, store, options.autoDelayMs);
  registerMemoryTools(options.manager, store);

  const parse = (query: unknown): { scope: MemoryScope; folder?: string } => {
    const q = (query ?? {}) as Record<string, unknown>;
    const scope = q.scope === 'folder' ? 'folder' : q.scope === 'global' || q.scope === undefined ? 'global' : null;
    if (!scope) throw new MemoryError('scope must be "global" or "folder"');
    return { scope, ...(typeof q.path === 'string' ? { folder: q.path } : {}) };
  };

  app.get('/api/memory', async (request, reply) => {
    try {
      const { scope, folder } = parse(request.query);
      return store.read(scope, folder);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.put('/api/memory', async (request, reply) => {
    try {
      const { scope, folder } = parse(request.query);
      const body = (request.body ?? {}) as { content?: string; autoPush?: boolean };
      return store.write(scope, folder, { content: body.content, autoPush: body.autoPush });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/memory/folders', async () => store.folders());

  app.post('/api/memory/push', async (request, reply) => {
    try {
      return service.push((request.body ?? {}) as MemoryPushRequest);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  return service;
}
