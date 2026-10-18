import crypto from 'node:crypto';
import type { BridgeReport, BridgeSendJob, ConsoleInfo, ConsoleStatus, Job } from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';

// Agent-to-agent jobs: one console types a task into another and gets the result typed back.
// sent -> working (target's next UserPromptSubmit) -> done | failed (report_job, or the turn ended)

export const MAX_JOBS = 300;
const MAX_TITLE = 60;
const MAX_NOTE_RESULT = 1500;
const MAX_STORED_RESULT = 8000;
// Typing into a console in these states is safe: Claude Code queues input typed while it works
const TYPEABLE = new Set<ConsoleStatus>(['idle', 'resting', 'working', 'error']);

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export function shortJobId(id: string): string {
  return id.slice(0, 8);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function jobPrompt(job: Job, senderName: string): string {
  return [
    `[AgentArmy job ${shortJobId(job.id)} from ${senderName}] ${job.title}`,
    job.message,
    '',
    `When finished, call the agentarmy report_job tool with job_id "${job.id}" and a short result.`,
  ].join('\n');
}

function isFinished(job: Job): boolean {
  return job.status === 'done' || job.status === 'failed';
}

export class JobService {
  // Notes for consoles that cannot be typed into right now (e.g. a permission prompt is open)
  private pendingNotes = new Map<string, string[]>();

  constructor(private readonly manager: ConsoleManager) {
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('removed', (id) => this.onRemoved(id));
    manager.on('console', (info) => this.flushNotes(info));
  }

  get jobs(): Job[] {
    return this.manager.jobs;
  }

  list(): Job[] {
    return this.jobs;
  }

  listFor(consoleId: string): Job[] {
    return this.jobs.filter((j) => j.fromId === consoleId || j.toId === consoleId);
  }

  // Accepts a full id or a unique prefix (agents often quote the short id from the header)
  find(idOrPrefix: string): Job | undefined {
    const key = idOrPrefix.trim();
    if (!key) return undefined;
    const exact = this.jobs.find((j) => j.id === key);
    if (exact) return exact;
    if (key.length < 4) return undefined;
    const matches = this.jobs.filter((j) => j.id.startsWith(key));
    return matches.length === 1 ? matches[0] : undefined;
  }

  resolveConsole(to: string): ConsoleInfo {
    const key = to.trim();
    const all = this.manager.list();
    const byId = all.find((c) => c.id === key);
    if (byId) return byId;
    const byName = all.filter((c) => c.name.toLowerCase() === key.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new BridgeError(
        `More than one agent is called "${key}". Use its id instead: ${byName.map((c) => c.id).join(', ')}`,
      );
    }
    throw new BridgeError(
      `No agent called "${key}". Call list_agents to see the agents on the board.`,
      404,
    );
  }

  send(fromId: string | null, req: BridgeSendJob): { job: Job; targetWasWorking: boolean } {
    const sender = fromId ? this.manager.get(fromId) : undefined;
    if (fromId && !sender) throw new BridgeError(`Unknown console ${fromId}`, 404);
    const message = typeof req.message === 'string' ? req.message.trim() : '';
    if (!message) throw new BridgeError('message is required');
    if (typeof req.to !== 'string' || !req.to.trim()) throw new BridgeError('to is required');
    const target = this.resolveConsole(req.to);
    if (target.id === fromId) throw new BridgeError('You cannot send a job to yourself.');
    switch (target.status) {
      case 'exited':
      case 'suspended':
        throw new BridgeError(
          `${target.name} is not running (${target.status}). Pick another agent, or ask the user to restart it.`,
        );
      case 'starting':
        throw new BridgeError(`${target.name} is still starting. Try again in a few seconds.`);
      case 'needs_you':
        // Typed text would land in its permission dialog
        throw new BridgeError(
          `${target.name} is waiting on the user${target.statusDetail ? ` (${target.statusDetail})` : ''}. Try again later or pick another agent.`,
        );
    }
    const rawTitle = typeof req.title === 'string' && req.title.trim() ? req.title : message;
    const now = Date.now();
    const job: Job = {
      id: crypto.randomUUID(),
      fromId,
      toId: target.id,
      title: clip(oneLine(rawTitle), MAX_TITLE),
      message,
      status: 'sent',
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.push(job);
    this.cap();
    const typed = this.manager.sendText(target.id, jobPrompt(job, sender?.name ?? 'the user'));
    if (!typed) {
      this.update(job, { status: 'failed', result: `${target.name} has no running terminal` });
      throw new BridgeError(`Could not type into ${target.name}: it has no running terminal.`);
    }
    this.changed(job);
    return { job, targetWasWorking: target.status === 'working' };
  }

  report(callerId: string, jobId: string, req: BridgeReport): Job {
    const job = this.find(jobId);
    if (!job) throw new BridgeError(`No job with id "${jobId}". Call list_jobs to see your jobs.`, 404);
    if (job.toId !== callerId) {
      throw new BridgeError('Only the agent the job was sent to can report it.', 403);
    }
    const status = req.status === 'failed' ? 'failed' : 'done';
    const result = typeof req.result === 'string' ? req.result.trim() : '';
    this.update(job, { status, result: clip(result, MAX_STORED_RESULT) });
    const worker = this.manager.get(job.toId)?.name ?? 'An agent';
    const verb = status === 'done' ? 'finished' : 'could not finish';
    this.notifySender(
      job,
      `[AgentArmy] ${worker} ${verb} "${job.title}" (job ${shortJobId(job.id)}): ${clip(oneLine(result) || '(no result given)', MAX_NOTE_RESULT)}`,
    );
    return job;
  }

  remove(id: string): boolean {
    const index = this.jobs.findIndex((j) => j.id === id);
    if (index < 0) return false;
    this.jobs.splice(index, 1);
    this.manager.emit('job-removed', id);
    this.manager.persist();
    return true;
  }

  onHook(consoleId: string, payload: HookPayload): void {
    switch (payload.hook_event_name) {
      case 'UserPromptSubmit': {
        const waiting = this.jobs.filter((j) => j.toId === consoleId && j.status === 'sent');
        if (!waiting.length) return;
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        // Prefer the job whose header is in the prompt; fall back to the oldest one sent
        const job =
          waiting.find((j) => prompt.includes(`[AgentArmy job ${shortJobId(j.id)}`)) ?? waiting[0];
        this.update(job, { status: 'working' });
        return;
      }
      case 'Stop': {
        // The turn ended without report_job: count it as done, and still tell the sender
        const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
        for (const job of this.jobs.filter((j) => j.toId === consoleId && j.status === 'working')) {
          this.update(job, { status: 'done' });
          const worker = this.manager.get(consoleId)?.name ?? 'An agent';
          this.notifySender(
            job,
            `[AgentArmy] ${worker} ended its turn on "${job.title}" (job ${shortJobId(job.id)}) without calling report_job.${last ? ` Its last message: ${clip(oneLine(last), MAX_NOTE_RESULT)}` : ''}`,
          );
        }
        return;
      }
      case 'StopFailure': {
        const reason =
          typeof payload.last_assistant_message === 'string'
            ? payload.last_assistant_message
            : typeof payload.error === 'string'
              ? payload.error
              : 'The turn failed';
        for (const job of this.jobs.filter((j) => j.toId === consoleId && j.status === 'working')) {
          this.update(job, { status: 'failed', result: clip(reason, MAX_STORED_RESULT) });
        }
        return;
      }
    }
  }

  private onRemoved(consoleId: string): void {
    this.pendingNotes.delete(consoleId);
    for (const job of this.jobs.filter((j) => j.toId === consoleId && !isFinished(j))) {
      this.update(job, { status: 'failed', result: 'The agent was closed before it finished' });
    }
  }

  private notifySender(job: Job, note: string): void {
    if (!job.fromId || !this.manager.get(job.fromId)) return;
    const queue = this.pendingNotes.get(job.fromId) ?? [];
    queue.push(note);
    this.pendingNotes.set(job.fromId, queue);
    const sender = this.manager.get(job.fromId);
    if (sender) this.flushNotes(sender);
  }

  private flushNotes(info: ConsoleInfo): void {
    const queue = this.pendingNotes.get(info.id);
    if (!queue?.length || !TYPEABLE.has(info.status)) return;
    this.pendingNotes.delete(info.id);
    this.manager.sendText(info.id, queue.join('\n'));
  }

  private update(job: Job, fields: Partial<Pick<Job, 'status' | 'result'>>): void {
    if (fields.status) job.status = fields.status;
    if (fields.result !== undefined) job.result = fields.result;
    job.updatedAt = Date.now();
    this.changed(job);
  }

  private changed(job: Job): void {
    if (!this.jobs.includes(job)) return;
    this.manager.emit('job', job);
    this.manager.persist();
  }

  // Drops the oldest finished jobs once there are too many
  private cap(): void {
    let excess = this.jobs.length - MAX_JOBS;
    for (let i = 0; i < this.jobs.length && excess > 0; ) {
      const job = this.jobs[i];
      if (isFinished(job)) {
        this.jobs.splice(i, 1);
        this.manager.emit('job-removed', job.id);
        excess--;
      } else {
        i++;
      }
    }
  }
}
