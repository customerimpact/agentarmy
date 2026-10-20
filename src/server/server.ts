import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type {
  CreateConsoleRequest,
  ServerMessage,
  UpdateConsoleRequest,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { listDirectory } from './fs-list.js';
import { registerBrowserRoutes } from './browsers/routes.js';
import { registerOrchestrationRoutes } from './orchestration-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerDrawingRoutes } from './drawings.js';
import { registerItemRoutes } from './board-items.js';
import { registerWorkspaceTabRoutes } from './workspaces.js';
import { registerGitReviewRoutes } from './git-review-routes.js';
import { registerRepoRoutes } from './repo-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerAgentRoutes } from './agents/index.js';
import { registerUsageRoutes } from './usage-routes.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerProviderRoutes } from './provider-routes.js';
import { SettingsStore } from './settings.js';
import { WebhookNotifier } from './webhooks.js';
import { NtfyNotifier, registerNtfyRoutes } from './ntfy.js';
import { registerPreviewRoutes } from './previews/preview-service.js';
import { registerRecapRoutes } from './recap.js';
import { registerHandoffRoutes } from './handoffs.js';
import { registerSwitchAgentRoutes } from './switch-agent.js';
import { ProviderFallback, agentReadiness } from './provider-fallback.js';
import { registerMemoryRoutes } from './memory.js';
import { registerPauseRoutes } from './pause.js';
import { CustomTemplates, registerComposerRoutes } from './composer.js';
import { registerLoopRoutes } from './loops.js';
import { registerPhoneRoutes } from './phone/phone-routes.js';
import { registerCloudRoutes } from './cloud.js';
import type { HookPayload } from './hook-status.js';
import { parseClientMessage } from './client-message.js';
import {
  isAllowedHost,
  isAllowedOrigin,
  isValidToken,
  readCookie,
  TOKEN_COOKIE,
  tokenCookie,
  type SecurityConfig,
} from './security.js';

export interface ServerOptions extends SecurityConfig {
  manager: ConsoleManager;
  settings?: SettingsStore; // defaults to an in-memory store (tests)
  phonePort?: number; // phone access listener; tests pass 0 (any free port)
  phoneHost?: string; // tests pass 127.0.0.1
}

const PROTECTED_PREFIXES = ['/api/', '/ws', '/hook/', '/bridge/'];

// Built: dist/cli.js next to dist/web. From source (tsx): src/server -> ../../dist/web.
function findWebRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'web'), path.resolve(here, '../../dist/web')];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

function queryToken(request: FastifyRequest): unknown {
  return (request.query as Record<string, unknown> | undefined)?.token;
}

// /hook and /bridge only take the query token: Claude Code and our MCP bridge never send the cookie
function isAuthorized(request: FastifyRequest, url: string, token: string): boolean {
  if (url.startsWith('/hook/') || url.startsWith('/bridge/'))
    return isValidToken(queryToken(request), token);
  return (
    isValidToken(request.headers['x-agentarmy-token'], token) ||
    isValidToken(queryToken(request), token) ||
    isValidToken(readCookie(request.headers.cookie, TOKEN_COOKIE), token)
  );
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseJson(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { manager } = options;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host, options)) {
      return reply.code(403).send({ error: 'Forbidden host' });
    }
    if (!isAllowedOrigin(request.headers.origin, options)) {
      return reply.code(403).send({ error: 'Forbidden origin' });
    }
    const url = request.url.split('?')[0];
    const isProtected = PROTECTED_PREFIXES.some((p) => url === p || url.startsWith(p));
    if (isProtected && !isAuthorized(request, url, options.token)) {
      return reply.code(401).send({ error: 'Missing or invalid token' });
    }
    // Lets a PWA window opened at start_url "/" (no ?token) authenticate later
    const hasCookie = readCookie(request.headers.cookie, TOKEN_COOKIE) === options.token;
    if (
      !url.startsWith('/hook/') &&
      !url.startsWith('/bridge/') &&
      !hasCookie &&
      isValidToken(queryToken(request), options.token)
    ) {
      reply.header('set-cookie', tokenCookie(options.token));
    }
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  const browsers = await registerBrowserRoutes(app, { manager });
  app.addHook('onClose', async () => browsers.shutdown());

  const sockets = new Set<WebSocket>();
  const send = (socket: WebSocket, msg: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    for (const socket of sockets) send(socket, msg);
  };
  manager.on('console', (console) => broadcast({ type: 'console', console }));
  manager.on('removed', (id) => broadcast({ type: 'removed', id }));
  manager.on('job', (job) => broadcast({ type: 'job', job }));
  manager.on('job-removed', (id) => broadcast({ type: 'job-removed', id }));
  manager.on('action', (action) => broadcast({ type: 'action', action }));
  manager.on('actions-removed', (ids) => broadcast({ type: 'actions-removed', ids }));
  manager.on('project', (project) => broadcast({ type: 'project', project }));
  manager.on('project-removed', (id) => broadcast({ type: 'project-removed', id }));
  manager.on('browser', (browser) => broadcast({ type: 'browser', browser }));
  manager.on('browser-removed', (id) => broadcast({ type: 'browser-removed', id }));
  manager.on('loop', (loop) => broadcast({ type: 'loop', loop }));
  manager.on('loop-removed', (id) => broadcast({ type: 'loop-removed', id }));
  manager.on('item', (item) => broadcast({ type: 'item', item }));
  manager.on('item-removed', (id) => broadcast({ type: 'item-removed', id }));
  manager.on('workspaces', () =>
    broadcast({ type: 'workspaces', workspaces: manager.workspaces, activeWorkspaceId: manager.activeWorkspaceId }),
  );

  const settings = options.settings ?? new SettingsStore(null);
  const notifier = new WebhookNotifier(manager, settings, options.port);
  const ntfy = new NtfyNotifier(manager, settings, options.port);
  settings.on('change', () =>
    broadcast({ type: 'settings', settings: settings.publicView({ port: options.port }) }),
  );

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    const listeners = new Map<string, (data: string) => void>();
    const browserHandler = browsers.forSocket((msg) => send(socket, msg as ServerMessage));

    socket.on('message', (raw) => {
      if (browserHandler.onMessage(parseJson(raw), (msg) => send(socket, msg as ServerMessage))) return;
      const msg = parseClientMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'attach': {
          if (listeners.has(msg.id) || !manager.get(msg.id)) return;
          const listener = (data: string): void =>
            send(socket, { type: 'output', id: msg.id, data });
          const replay = manager.attach(msg.id, listener);
          listeners.set(msg.id, listener);
          send(socket, { type: 'replay', id: msg.id, data: replay });
          return;
        }
        case 'detach': {
          const listener = listeners.get(msg.id);
          if (listener) manager.detach(msg.id, listener);
          listeners.delete(msg.id);
          return;
        }
        case 'input':
          manager.input(msg.id, msg.data);
          return;
        case 'resize':
          manager.resize(msg.id, msg.cols, msg.rows);
          return;
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      browserHandler.onClose();
      for (const [id, listener] of listeners) manager.detach(id, listener);
      listeners.clear();
    });
  });

  app.get('/api/state', async () => manager.getState());

  // Usage first: its preHandler gates send_job while a budget is used up
  await registerUsageRoutes(app, { manager, settings, broadcast });
  await registerOrchestrationRoutes(app, { manager, port: options.port, token: options.token });
  const worktrees = await registerGitReviewRoutes(app, { manager });
  await registerRepoRoutes(app, { manager }); // Git panel + code viewer
  // Composer's saved templates live next to settings.json; in-memory settings = a throwaway server
  const customTemplates = new CustomTemplates(settings.filePath ? path.join(path.dirname(settings.filePath), 'templates.json') : null);
  const { projects } = await registerWorkspaceRoutes(app, { manager, worktrees, custom: customTemplates });
  registerComposerRoutes(app, { manager, projects, worktrees, custom: customTemplates });
  registerPauseRoutes(app, { manager });
  registerItemRoutes(app, { manager });
  registerWorkspaceTabRoutes(app, { manager, projects });
  await registerSettingsRoutes(app, { settings, notifier, port: options.port });
  registerAgentRoutes(app, { settings: () => settings.get() });
  // Drawings + annotation images (<AGENTARMY_HOME>/images; in memory for a throwaway settings store)
  await registerDrawingRoutes(app, {
    drawings: manager.drawings,
    persist: () => manager.persist(),
    broadcast,
    activeWorkspaceId: () => manager.activeWorkspaceId,
    imagesDir: settings.filePath ? path.join(path.dirname(settings.filePath), 'images') : null,
  });
  // Claude Code accounts live next to settings.json; an in-memory settings store means a throwaway server
  const accountService = await registerAccountRoutes(app, { manager, broadcast, dataDir: settings.filePath ? path.dirname(settings.filePath) : null });
  // Agents & accounts hub: install / login / status per agent CLI (src/shared/providers.ts)
  registerProviderRoutes(app, { manager, broadcast, accounts: accountService, settings: () => settings.get() });
  await registerNtfyRoutes(app, { settings, notifier: ntfy });
  // Daily recap log sits next to settings.json; an in-memory settings store means a throwaway server
  // Handoffs (brief from one agent's transcript into another) and project memory (next to settings.json)
  const handoffs = registerHandoffRoutes(app, { manager, settings: () => settings.get() });
  // Switch a running agent to another CLI, and continue on another CLI when every Claude account is limited
  const switcher = registerSwitchAgentRoutes(app, { manager, handoffs, settings: () => settings.get() });
  const fallback = new ProviderFallback({
    manager,
    store: accountService.store,
    switcher,
    settings: () => settings.get(),
    readiness: (agent) => agentReadiness(agent, settings.get()),
  });
  accountService.switcher.setFallback(fallback);
  app.addHook('onClose', async () => fallback.stop());
  registerMemoryRoutes(app, { manager, dir: settings.filePath ? path.join(path.dirname(settings.filePath), 'memory') : null });
  const recap = registerRecapRoutes(app, {
    manager,
    settings,
    dir: settings.filePath ? path.join(path.dirname(settings.filePath), 'recaps') : null,
  });
  registerPreviewRoutes(app, {
    manager,
    browsers: browsers.impl,
    settings: () => settings.get(),
    broadcast,
    ignorePorts: [options.port],
    onOpened: (consoleId, url) => recap.recordPreview(consoleId, url),
  });
  registerLoopRoutes(app, {
    manager,
    onRun: (loop, consoles) => {
      for (const c of consoles) recap.record('loop', c.id, { id: loop.id, text: loop.name });
    },
  });

  registerCloudRoutes(app, { dataDir: settings.filePath ? path.dirname(settings.filePath) : null, broadcast });

  registerPhoneRoutes(app, {
    manager,
    port: options.port,
    token: options.token,
    broadcast,
    dataDir: settings.filePath ? path.dirname(settings.filePath) : null,
    webRoot: options.dev ? null : findWebRoot(),
    phonePort: options.phonePort ?? (process.env.AGENTARMY_PHONE_PORT ? Number(process.env.AGENTARMY_PHONE_PORT) : undefined),
    phoneHost: options.phoneHost ?? process.env.AGENTARMY_PHONE_HOST,
  });

  app.post('/api/consoles', async (request, reply) => {
    const body = request.body as CreateConsoleRequest | undefined;
    if (!body || typeof body.cwd !== 'string' || !body.cwd.trim()) {
      return reply.code(400).send({ error: 'cwd is required' });
    }
    try {
      // Isolated branch: make a git worktree first, then launch claude inside it
      if (body.worktree === true) return await worktrees.createConsole(body);
      return manager.create(body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/consoles/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return manager.update(id, (request.body ?? {}) as UpdateConsoleRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/consoles/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      manager.remove(id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/consoles/:id/restart', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return manager.restart(id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/resume-all', async () => ({ resumed: manager.resumeAll() }));

  app.put('/api/viewport', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || !isFiniteNumber(body.x) || !isFiniteNumber(body.y) || !isFiniteNumber(body.zoom)) {
      return reply.code(400).send({ error: 'x, y and zoom must be numbers' });
    }
    manager.setViewport({ x: body.x, y: body.y, zoom: body.zoom });
    return { ok: true };
  });

  app.get('/api/fs/list', async (request, reply) => {
    const { path: dir } = request.query as { path?: string };
    try {
      return await listDirectory(dir);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Answer immediately so Claude Code is never slowed down by our bookkeeping
  app.post('/hook/:consoleId', async (request, reply) => {
    const { consoleId } = request.params as { consoleId: string };
    const payload = request.body;
    setImmediate(() => {
      if (payload && typeof payload === 'object') {
        manager.handleHook(consoleId, payload as HookPayload);
      }
    });
    return reply.code(200).send();
  });

  const webRoot = options.dev ? null : findWebRoot();
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split('?')[0];
    const isApi = PROTECTED_PREFIXES.some((p) => url.startsWith(p));
    if (request.method !== 'GET' || isApi) return reply.code(404).send({ error: 'Not found' });
    if (!webRoot) {
      return reply
        .code(404)
        .type('text/plain')
        .send(
          options.dev
            ? 'Dev mode: open the Vite UI at http://localhost:5173'
            : 'UI not built. Run "npm run build" first.',
        );
    }
    return reply.sendFile('index.html');
  });

  return app;
}
