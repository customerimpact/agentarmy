import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AppSettings,
  ConsoleInfo,
  ConsoleStatus,
  HandoffMode,
  HandoffNewAgent,
  HandoffPreview,
  HandoffRequest,
  HandoffSendRequest,
  HandoffSendResponse,
  Job,
} from '../shared/protocol.js';
import { NotFoundError, childEnv, type ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';
import { defaultTranscriptPath } from './activity.js';
import { resolveClaudeExecutable } from './claude-path.js';
import { registerBridgeTool, textResult } from './bridge-tools.js';
import {
  buildQuickBrief,
  digestTranscript,
  gitFromStats,
  readGitInfo,
  readTranscriptTail,
  runSmartBrief,
  type BriefJob,
  type SmartBriefOptions,
} from './handoff-brief.js';

// Handoffs: build a brief from one agent's work and type it into another agent (or a new one).
// Recorded as a Job with kind 'handoff', so the board draws the line and the target's turn moves it
// sent -> working -> done like any job (jobs.ts), without typing a note back into the source.

const MAX_TITLE = 60;
const MAX_BRIEF = 60_000;
const NEW_AGENT_TIMEOUT_MS = 3 * 60_000;
const NEW_AGENT_DELAY_MS = 1000; // SessionStart fires slightly before the prompt box takes typing
const MAX_LIVE_FILES = 60;
const TYPEABLE = new Set<ConsoleStatus>(['idle', 'resting', 'working', 'error']);
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export class HandoffError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

interface LiveNotes {
  transcript?: string;
  lastMessage?: string;
  files: string[];
}

export interface HandoffServiceOptions {
  settings: () => AppSettings;
  smart?: (options: SmartBriefOptions) => Promise<string>; // tests stub claude -p
  newAgentDelayMs?: number;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class HandoffService {
  private live = new Map<string, LiveNotes>();
  private waiting = new Map<string, { brief: string; job: Job; timer: NodeJS.Timeout }>();

  constructor(
    private readonly manager: ConsoleManager,
    private readonly options: HandoffServiceOptions,
  ) {
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('console', (info) => this.onConsole(info));
    manager.on('removed', (id) => {
      this.live.delete(id);
      const w = this.waiting.get(id);
      if (w) clearTimeout(w.timer);
      this.waiting.delete(id);
    });
  }

  private notes(id: string): LiveNotes {
    let n = this.live.get(id);
    if (!n) {
      n = { files: [] };
      this.live.set(id, n);
    }
    return n;
  }

  onHook(id: string, payload: HookPayload): void {
    const n = this.notes(id);
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) n.transcript = payload.transcript_path;
    if (payload.hook_event_name === 'Stop' && typeof payload.last_assistant_message === 'string') {
      n.lastMessage = payload.last_assistant_message;
    }
    if (payload.hook_event_name === 'PreToolUse' && FILE_TOOLS.has(str(payload.tool_name))) {
      const input = payload.tool_input as Record<string, unknown> | undefined;
      const file = str(input?.file_path) || str(input?.notebook_path);
      if (file && !n.files.includes(file)) {
        n.files.push(file);
        if (n.files.length > MAX_LIVE_FILES) n.files.shift();
      }
    }
  }

  private source(fromId: string): ConsoleInfo {
    const from = this.manager.get(fromId);
    if (!from) throw new HandoffError(`Unknown console ${fromId}`, 404);
    return from;
  }

  // Env of the source console's account (CLAUDE_CONFIG_DIR), without changing the console
  private accountEnv(info: ConsoleInfo): Record<string, string> {
    try {
      return this.manager.accountEnv?.({ ...info }, 'resume') ?? {};
    } catch {
      return {};
    }
  }

  transcriptPath(info: ConsoleInfo): string {
    const tracked = this.live.get(info.id)?.transcript;
    if (tracked) return tracked;
    const env = { ...process.env, ...this.accountEnv(info) };
    return defaultTranscriptPath(info.cwd, info.sessionId, env);
  }

  async quickBrief(fromId: string, note?: string): Promise<string> {
    const from = this.source(fromId);
    const digest = digestTranscript(await readTranscriptTail(this.transcriptPath(from)));
    const name = (id: string | null): string => (id ? (this.manager.get(id)?.name ?? 'a closed agent') : 'the user');
    const jobs: BriefJob[] = this.manager.jobs
      .filter((j) => j.fromId === from.id || j.toId === from.id)
      .map((job) => ({
        job,
        direction: job.fromId === from.id ? 'sent' : 'received',
        peer: name(job.fromId === from.id ? job.toId : job.fromId),
      }));
    const git = from.gitStats ? gitFromStats(from.git?.branch, from.gitStats) : readGitInfo(from.cwd);
    const notes = this.live.get(from.id);
    return buildQuickBrief({
      fromName: from.name,
      cwd: from.cwd,
      role: from.role,
      note,
      digest,
      liveTodos: from.todos,
      liveFiles: notes?.files,
      lastMessage: notes?.lastMessage,
      jobs,
      git,
    });
  }

  async preview(req: HandoffRequest): Promise<HandoffPreview> {
    const from = this.source(str(req.fromId));
    const note = str(req.note).trim() || undefined;
    const quick = await this.quickBrief(from.id, note);
    const mode: HandoffMode = req.mode === 'smart' || req.mode === 'quick' ? req.mode : this.options.settings().handoffMode ?? 'quick';
    if (mode === 'quick') return { brief: quick, mode };
    try {
      const settings = this.options.settings();
      const override = settings.claudePath;
      const executable = resolveClaudeExecutable({
        env: override ? { ...process.env, AGENTARMY_CLAUDE_PATH: override } : process.env,
      });
      const smart = await (this.options.smart ?? runSmartBrief)({
        executable,
        cwd: from.cwd,
        env: { ...childEnv(process.env, settings), ...this.accountEnv(from) },
        quickBrief: quick,
      });
      const header = quick.split('\n')[0];
      const noteBlock = note ? `\n\n## Note from the user\n${note}` : '';
      return { brief: `${header}\n${from.name} is handing its work in ${from.cwd} over to you.${noteBlock}\n\n${smart.trim()}`, mode: 'smart' };
    } catch (err) {
      return {
        brief: quick,
        mode: 'quick',
        warning: `Smart brief failed (${err instanceof Error ? err.message : String(err)}); showing the quick brief instead.`,
      };
    }
  }

  private resolveTarget(to: string, fromId: string): ConsoleInfo {
    const key = to.trim();
    const all = this.manager.list();
    const byId = all.find((c) => c.id === key);
    const byName = all.filter((c) => c.name.toLowerCase() === key.toLowerCase());
    const target = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!target) {
      if (byName.length > 1) throw new HandoffError(`More than one agent is called "${key}". Use its id.`);
      throw new HandoffError(`No agent called "${key}".`, 404);
    }
    if (target.id === fromId) throw new HandoffError('An agent cannot hand off to itself.');
    return target;
  }

  send(req: HandoffSendRequest): HandoffSendResponse {
    const from = this.source(str(req.fromId));
    const brief = str(req.brief).trim();
    if (!brief) throw new HandoffError('brief is required');
    if (brief.length > MAX_BRIEF) throw new HandoffError('brief is too long');
    if (req.newAgent) return this.sendToNew(from, req.newAgent, brief);
    if (!str(req.toId)) throw new HandoffError('toId or newAgent is required');
    const target = this.resolveTarget(str(req.toId), from.id);
    if (!TYPEABLE.has(target.status)) {
      const why =
        target.status === 'needs_you'
          ? 'is waiting on you (answer its dialog first)'
          : target.status === 'starting'
            ? 'is still starting'
            : `is not running (${target.status})`;
      throw new HandoffError(`${target.name} ${why}.`);
    }
    const job = this.record(from, target, brief);
    if (!this.manager.sendText(target.id, brief)) {
      this.finish(job, 'failed', `${target.name} has no running terminal`);
      throw new HandoffError(`Could not type into ${target.name}: it has no running terminal.`);
    }
    return { job, console: target };
  }

  private sendToNew(from: ConsoleInfo, spec: HandoffNewAgent, brief: string): HandoffSendResponse {
    const cwd = str(spec.cwd).trim() || from.cwd;
    let target: ConsoleInfo;
    try {
      target = this.manager.create({
        cwd,
        ...(str(spec.name).trim() ? { name: str(spec.name).trim() } : {}),
        ...(from.accountId && from.accountId !== 'auto' ? { accountId: from.accountId } : {}),
      });
    } catch (err) {
      throw new HandoffError(err instanceof Error ? err.message : String(err));
    }
    const job = this.record(from, target, brief);
    const timer = setTimeout(() => {
      if (this.waiting.get(target.id)?.job !== job) return;
      this.waiting.delete(target.id);
      this.finish(job, 'failed', `${target.name} did not become ready in time`);
    }, NEW_AGENT_TIMEOUT_MS);
    timer.unref?.();
    this.waiting.set(target.id, { brief, job, timer });
    this.onConsole(target);
    return { job, console: target };
  }

  private onConsole(info: ConsoleInfo): void {
    const w = this.waiting.get(info.id);
    if (!w || info.status !== 'idle') return;
    this.waiting.delete(info.id);
    clearTimeout(w.timer);
    const send = (): void => {
      if (!this.manager.sendText(info.id, w.brief)) this.finish(w.job, 'failed', `${info.name} has no running terminal`);
    };
    const delay = this.options.newAgentDelayMs ?? NEW_AGENT_DELAY_MS;
    if (delay > 0) setTimeout(send, delay).unref?.();
    else send();
  }

  private record(from: ConsoleInfo, target: ConsoleInfo, brief: string): Job {
    const now = Date.now();
    const job: Job = {
      id: crypto.randomUUID(),
      fromId: from.id,
      toId: target.id,
      title: clip(`Handoff: ${from.name} → ${target.name}`, MAX_TITLE),
      message: brief,
      status: 'sent',
      createdAt: now,
      updatedAt: now,
      kind: 'handoff',
    };
    this.manager.jobs.push(job);
    this.manager.emit('job', job);
    this.manager.persist();
    return job;
  }

  private finish(job: Job, status: 'done' | 'failed', result: string): void {
    job.status = status;
    job.result = result;
    job.updatedAt = Date.now();
    if (!this.manager.jobs.includes(job)) return;
    this.manager.emit('job', job);
    this.manager.persist();
  }
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof HandoffError ? err.statusCode : err instanceof NotFoundError ? 404 : 400;
  return reply.code(code).send({ error: message });
}

function registerHandoffTool(manager: ConsoleManager, service: HandoffService): void {
  registerBridgeTool({
    name: 'handoff',
    description:
      'Hand your work over to another agent on the AgentArmy board (or to a new agent in your folder). AgentArmy ' +
      'builds a brief from your conversation (what you were asked, your latest status, your tasks, the files you ' +
      'changed, your jobs, git state) and types it into that agent, which carries on from there. Put anything the ' +
      'brief would miss in note (decisions, gotchas, the exact next step). Use list_agents to pick the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent name or id from list_agents, or "new" for a new agent in your folder' },
        note: { type: 'string', description: 'Extra context for the other agent: next step, decisions, gotchas' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    handler: async (consoleId, input) => {
      const me = manager.get(consoleId);
      if (!me) return textResult(`Unknown console ${consoleId}`, true);
      const to = str(input.to).trim();
      if (!to) return textResult('to is required', true);
      const note = str(input.note).trim() || undefined;
      const { brief } = await service.preview({ fromId: consoleId, note });
      const isNew = to.toLowerCase() === 'new';
      const { job, console: target } = service.send({
        fromId: consoleId,
        brief,
        ...(isNew ? { newAgent: { cwd: me.cwd } } : { toId: to }),
      });
      return textResult(
        `Handed off to ${target.name}${isNew ? ' (a new agent; the brief is typed in once it is ready)' : ''} ` +
          `(job_id "${job.id}"). The brief was ${brief.length} characters. You can stop working on this now.`,
      );
    },
  });
}

export function registerHandoffRoutes(
  app: FastifyInstance,
  options: { manager: ConsoleManager } & HandoffServiceOptions,
): HandoffService {
  const { manager } = options;
  const service = new HandoffService(manager, options);
  registerHandoffTool(manager, service);

  app.post('/api/handoffs', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<HandoffRequest>;
    if (!str(body.fromId)) return reply.code(400).send({ error: 'fromId is required' });
    try {
      if (body.toId && !body.newAgent) {
        const target = manager.get(str(body.toId));
        if (!target) throw new HandoffError(`Unknown console ${body.toId}`, 404);
        if (target.id === body.fromId) throw new HandoffError('An agent cannot hand off to itself.');
      }
      return await service.preview(body as HandoffRequest);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/handoffs/send', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<HandoffSendRequest>;
    try {
      return service.send(body as HandoffSendRequest);
    } catch (err) {
      return fail(reply, err);
    }
  });

  return service;
}
