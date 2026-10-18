import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  BridgeAgent,
  BridgeReport,
  BridgeRequestAction,
  BridgeSendJob,
  ConsoleInfo,
  Job,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { ActionInbox } from './actions.js';
import { ActivityTracker } from './activity.js';
import { getBridgeTool, listBridgeTools, registerBridgeTool, textResult } from './bridge-tools.js';
import { BridgeError, JobService, shortJobId } from './jobs.js';

export interface OrchestrationOptions {
  manager: ConsoleManager;
  port: number;
  token: string;
}

type Obj = Record<string, unknown>;

function center(c: ConsoleInfo): { x: number; y: number } {
  return { x: c.layout.x + c.layout.width / 2, y: c.layout.y + c.layout.height / 2 };
}

export function boardDistance(a: ConsoleInfo, b: ConsoleInfo): number {
  const p = center(a);
  const q = center(b);
  return Math.round(Math.hypot(p.x - q.x, p.y - q.y));
}

export type AgentEntry = BridgeAgent & { role?: string; model?: string; projectId?: string | null };

// Every other console, nearest first
export function listAgents(manager: ConsoleManager, callerId: string): AgentEntry[] {
  const caller = manager.get(callerId);
  if (!caller) throw new BridgeError(`Unknown console ${callerId}`, 404);
  return manager
    .list()
    .filter((c) => c.id !== callerId)
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      cwd: c.cwd,
      distance: boardDistance(caller, c),
      ...(c.role ? { role: c.role } : {}),
      ...(c.model ? { model: c.model } : {}),
      ...(c.projectId !== undefined ? { projectId: c.projectId } : {}),
    }))
    .sort((a, b) => a.distance - b.distance);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function describeJob(job: Job, manager: ConsoleManager, callerId: string): string {
  const name = (id: string | null): string => (id ? (manager.get(id)?.name ?? 'a closed agent') : 'the user');
  const direction =
    job.fromId === callerId ? `sent to ${name(job.toId)}` : `received from ${name(job.fromId)}`;
  const result = job.result ? ` - result: ${job.result.slice(0, 500)}` : '';
  return `- job_id "${job.id}" (${shortJobId(job.id)}) "${job.title}" ${direction}: ${job.status}${result}`;
}

function registerTools(manager: ConsoleManager, jobs: JobService, inbox: ActionInbox): void {
  registerBridgeTool({
    name: 'list_agents',
    description:
      'List the other Claude Code agents on the AgentArmy board, nearest to you first. ' +
      'Each entry has the name to use with send_job, its status (idle/resting = free, working = busy, ' +
      'needs_you = waiting on the user, starting/suspended/exited = cannot take jobs), role, project folder, model, ' +
      'and the distance in board pixels. When the user says "the agents closest to you", use this order.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (consoleId) => {
      const me = manager.get(consoleId);
      if (!me) return textResult(`Unknown console ${consoleId}`, true);
      const agents = listAgents(manager, consoleId);
      const lines = agents.map((a) => {
        const extra = [a.role && `role ${a.role}`, a.model && `model ${a.model}`].filter(Boolean).join(', ');
        return `- ${a.name} [${a.status}] ${a.distance}px away, folder ${a.cwd}${extra ? `, ${extra}` : ''} (id ${a.id})`;
      });
      const intro = `You are ${me.name}${me.role ? ` (${me.role})` : ''}, folder ${me.cwd}.`;
      return textResult(
        agents.length
          ? `${intro}\nOther agents, nearest first:\n${lines.join('\n')}`
          : `${intro}\nThere are no other agents on the board yet. Ask the user to add some.`,
      );
    },
  });

  registerBridgeTool({
    name: 'send_job',
    description:
      'Hand a task to another agent on the board. The message is typed into that agent\'s terminal as a prompt, ' +
      'and the board draws a line from you to it. Write the message so it stands alone: the other agent does not ' +
      'see your conversation. It will call report_job when done and the result is typed back to you, so after ' +
      'sending you can end your turn and wait. Use list_agents first to pick the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent name (case-insensitive) or id, from list_agents' },
        title: { type: 'string', description: 'Short label for the job, at most 6 words' },
        message: { type: 'string', description: 'The full instructions for the other agent' },
      },
      required: ['to', 'title', 'message'],
      additionalProperties: false,
    },
    handler: async (consoleId, input) => {
      const { job, targetWasWorking } = jobs.send(consoleId, {
        to: str(input.to),
        title: str(input.title),
        message: str(input.message),
      });
      const target = manager.get(job.toId)?.name ?? job.toId;
      const busy = targetWasWorking
        ? ` ${target} is busy right now, so it will pick the job up when its current turn ends.`
        : '';
      return textResult(
        `Sent job "${job.title}" to ${target} (job_id "${job.id}").${busy} Its report will be typed into your terminal when it finishes; you can end your turn now.`,
      );
    },
  });

  registerBridgeTool({
    name: 'report_job',
    description:
      'Report the result of a job another agent sent you (a prompt that started with "[AgentArmy job ...]"). ' +
      'Call it once when you are finished, with the job_id from that prompt and a short summary of what you did ' +
      'or found. The result is typed back to the agent that sent the job.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id from the job prompt' },
        result: { type: 'string', description: 'Short summary of the outcome' },
        status: { type: 'string', enum: ['done', 'failed'], description: 'Default done' },
      },
      required: ['job_id', 'result'],
      additionalProperties: false,
    },
    handler: async (consoleId, input) => {
      const job = jobs.report(consoleId, str(input.job_id), {
        result: str(input.result),
        status: input.status === 'failed' ? 'failed' : 'done',
      });
      const sender = job.fromId ? (manager.get(job.fromId)?.name ?? 'the sender') : 'the user';
      return textResult(`Reported job "${job.title}" as ${job.status}; ${sender} has been told.`);
    },
  });

  registerBridgeTool({
    name: 'list_jobs',
    description: 'List the jobs you sent to other agents or received from them, with their status and results.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (consoleId) => {
      const mine = jobs.listFor(consoleId);
      if (!mine.length) return textResult('You have not sent or received any jobs.');
      return textResult(mine.map((j) => describeJob(j, manager, consoleId)).join('\n'));
    },
  });

  registerBridgeTool({
    name: 'request_user_action',
    description:
      'Put an item in the user\'s AgentArmy action inbox when you need a human: an approval, a credential or ' +
      'secret, a decision between options, or something only they can do (log in, pay, review). ' +
      'Say exactly what you need in the title. Do not use it for routine progress updates.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What you need from the user, one line' },
        detail: { type: 'string', description: 'Optional context, options or steps' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (consoleId, input) => {
      const item = inbox.request(consoleId, str(input.title), str(input.detail) || undefined);
      return textResult(`Added to the user's action inbox: "${item.title}".`);
    },
  });
}

function bridgeFail(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof BridgeError ? err.statusCode : err instanceof NotFoundError ? 404 : 400;
  return reply.code(code).send({ error: message });
}

// Jobs, actions, todos/activity/model tracking, and the /bridge routes used by the MCP server.
export async function registerOrchestrationRoutes(
  app: FastifyInstance,
  options: OrchestrationOptions,
): Promise<void> {
  const { manager } = options;
  const jobs = new JobService(manager);
  const inbox = new ActionInbox(manager);
  new ActivityTracker(manager);
  registerTools(manager, jobs, inbox);

  // ---------- MCP bridge ----------
  app.get('/bridge/:consoleId/tools', async (request, reply) => {
    const { consoleId } = request.params as { consoleId: string };
    if (!manager.get(consoleId)) return reply.code(404).send({ error: `Unknown console ${consoleId}` });
    return {
      tools: listBridgeTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  app.post('/bridge/:consoleId/tools/:name', async (request, reply) => {
    const { consoleId, name } = request.params as { consoleId: string; name: string };
    if (!manager.get(consoleId)) return reply.code(404).send({ error: `Unknown console ${consoleId}` });
    const tool = getBridgeTool(name);
    if (!tool) return reply.code(404).send({ error: `Unknown tool ${name}` });
    const body = request.body;
    const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Obj) : {};
    try {
      return await tool.handler(consoleId, input);
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  });

  // ---------- Plain REST bridge (same logic, JSON in and out) ----------
  app.get('/bridge/:consoleId/agents', async (request, reply) => {
    const { consoleId } = request.params as { consoleId: string };
    try {
      return listAgents(manager, consoleId);
    } catch (err) {
      return bridgeFail(reply, err);
    }
  });

  app.get('/bridge/:consoleId/jobs', async (request, reply) => {
    const { consoleId } = request.params as { consoleId: string };
    if (!manager.get(consoleId)) return reply.code(404).send({ error: `Unknown console ${consoleId}` });
    return jobs.listFor(consoleId);
  });

  app.post('/bridge/:consoleId/jobs', async (request, reply) => {
    const { consoleId } = request.params as { consoleId: string };
    const body = (request.body ?? {}) as Partial<BridgeSendJob>;
    try {
      return jobs.send(consoleId, { to: str(body.to), title: str(body.title), message: str(body.message) }).job;
    } catch (err) {
      return bridgeFail(reply, err);
    }
  });

  app.post('/bridge/:consoleId/jobs/:jobId/report', async (request, reply) => {
    const { consoleId, jobId } = request.params as { consoleId: string; jobId: string };
    const body = (request.body ?? {}) as Partial<BridgeReport>;
    try {
      return jobs.report(consoleId, jobId, { result: str(body.result), status: body.status });
    } catch (err) {
      return bridgeFail(reply, err);
    }
  });

  app.post('/bridge/:consoleId/actions', async (request, reply) => {
    const { consoleId } = request.params as { consoleId: string };
    if (!manager.get(consoleId)) return reply.code(404).send({ error: `Unknown console ${consoleId}` });
    const body = (request.body ?? {}) as Partial<BridgeRequestAction>;
    try {
      return inbox.request(consoleId, str(body.title), str(body.detail) || undefined);
    } catch (err) {
      return bridgeFail(reply, err);
    }
  });

  // ---------- UI routes ----------
  app.patch('/api/actions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Obj | undefined;
    if (!body || typeof body.resolved !== 'boolean') {
      return reply.code(400).send({ error: 'resolved must be a boolean' });
    }
    try {
      return inbox.setResolved(id, body.resolved);
    } catch (err) {
      return bridgeFail(reply, err);
    }
  });

  app.post('/api/actions/clear-resolved', async () => ({ removed: inbox.clearResolved() }));

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!jobs.remove(id)) return reply.code(404).send({ error: `Unknown job ${id}` });
    return { ok: true };
  });
}
