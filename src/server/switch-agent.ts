import type { FastifyInstance } from 'fastify';
import type { AppSettings, ConsoleInfo, SwitchAgentRequest, SwitchAgentResponse } from '../shared/protocol.js';
import { AGENT_META, installCommandOf, isAgentKind, type AgentKind } from '../shared/agents.js';
import { LAUNCH_MODEL_RE, NotFoundError, type ConsoleManager } from './consoles.js';
import { detectAgents } from './agents/index.js';
import type { HandoffService } from './handoffs.js';
import { stripAnsi } from './prompt-detector.js';

// Switch a running agent to another CLI ("continue this on Codex"): a handoff brief from the console,
// a new console with the target CLI in the same folder, project, workspace and spot, with the same
// name and role, the brief typed in once it is idle (a handoff Job line old -> new), then the old
// console is removed (closeOld, the default). The old one is suspended right away so two agents never
// edit the same folder at once; if the new one never gets ready, the old one stays (suspended,
// restartable) and the job is marked failed. Used by POST /api/consoles/:id/switch-agent and by the
// cross-provider limit fallback (provider-fallback.ts).

const MAX_BRIEF = 60_000;
const TAIL_CHARS = 8000;
const TAIL_LINES = 30;
const REMOVE_DELAY_MS = 1500; // let the typed brief land before the old console goes
const ASIDE_GAP = 40;
const MAX_TITLE = 60;

export class SwitchAgentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface SwitchAgentOptions {
  manager: ConsoleManager;
  handoffs: HandoffService;
  settings: () => AppSettings;
  // Tests replace CLI detection; default: detectAgents (30 s cache)
  installed?: (agent: AgentKind) => Promise<{ installed: boolean; error?: string }>;
  removeDelayMs?: number;
}

// What the limit fallback adds on top of the public request
export interface SwitchAgentInternal extends SwitchAgentRequest {
  continuePrompt?: string; // appended to the brief, e.g. "Continue the task."
  fallbackFrom?: ConsoleInfo['fallbackFrom'];
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function switchJobTitle(name: string, from: AgentKind, to: AgentKind): string {
  return clip(`Switch: ${name} ${AGENT_META[from].short} → ${AGENT_META[to].short}`, MAX_TITLE);
}

// Last lines of a TUI's screen, for CLIs whose transcript we cannot read
export function screenTail(raw: string, maxLines = TAIL_LINES): string {
  const lines = stripAnsi(raw)
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  // TUIs redraw the same line many times (spinners, timers); keep one copy of repeats in a row
  const out: string[] = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out.slice(-maxLines).join('\n').slice(-3000);
}

export function notInstalledError(agent: AgentKind, platform: string = process.platform): SwitchAgentError {
  const meta = AGENT_META[agent];
  const command = installCommandOf(agent, platform);
  return new SwitchAgentError(
    `${meta.label} is not installed.${command ? ` Install it with: ${command}` : ''} (or set its path in Settings › Agents)`,
    400,
    { code: 'not_installed', agent, ...(command ? { installCommand: command } : {}), ...(meta.installUrl ? { installUrl: meta.installUrl } : {}) },
  );
}

export class SwitchAgentService {
  private tails = new Map<string, string>();
  private switching = new Set<string>();

  constructor(private readonly options: SwitchAgentOptions) {
    const { manager } = options;
    manager.on('output', (id, data) => {
      const info = manager.get(id);
      if (!info || (info.agent ?? 'claude') === 'claude') return; // Claude Code: the transcript has it all
      this.tails.set(id, ((this.tails.get(id) ?? '') + data).slice(-TAIL_CHARS));
    });
    manager.on('removed', (id) => {
      this.tails.delete(id);
      this.switching.delete(id);
    });
  }

  isSwitching(id: string): boolean {
    return this.switching.has(id);
  }

  private async installed(agent: AgentKind): Promise<boolean> {
    if (this.options.installed) return (await this.options.installed(agent)).installed;
    const found = (await detectAgents(this.options.settings(), { fresh: true })).agents.find((a) => a.id === agent);
    return !!found?.installed;
  }

  async switchAgent(id: string, req: SwitchAgentInternal): Promise<SwitchAgentResponse> {
    const { manager, handoffs } = this.options;
    const from = manager.get(id);
    if (!from) throw new NotFoundError(`Unknown console ${id}`);
    if (from.role === 'Login') throw new SwitchAgentError('A login console cannot be switched');
    const agent = req.agent;
    if (!isAgentKind(agent) || agent === 'custom') throw new SwitchAgentError('agent must be claude, codex, gemini, opencode or grok');
    const fromAgent: AgentKind = from.agent ?? 'claude';
    if (fromAgent === 'custom') throw new SwitchAgentError('A custom command console has no conversation to hand over');
    const accountId = typeof req.accountId === 'string' && req.accountId.trim() ? req.accountId.trim() : undefined;
    if (agent === fromAgent && (agent !== 'claude' || !accountId || accountId === from.accountId)) {
      throw new SwitchAgentError(`${from.name} already runs ${AGENT_META[agent].label}`);
    }
    const model = typeof req.model === 'string' ? req.model.trim() : '';
    if (model && !LAUNCH_MODEL_RE.test(model)) throw new SwitchAgentError(`Not a model name: ${model}`);
    if (req.briefMode !== undefined && req.briefMode !== 'quick' && req.briefMode !== 'smart') {
      throw new SwitchAgentError('briefMode must be "quick" or "smart"');
    }
    if (this.switching.has(id)) throw new SwitchAgentError(`${from.name} is already being switched`, 409);
    this.switching.add(id);
    try {
      if (!(await this.installed(agent))) throw notInstalledError(agent);

      const note = typeof req.note === 'string' && req.note.trim() ? req.note.trim().slice(0, 4000) : undefined;
      const preview = await handoffs.preview({ fromId: id, mode: req.briefMode, note });
      let brief = preview.brief;
      const tail = fromAgent !== 'claude' ? screenTail(this.tails.get(id) ?? '') : '';
      if (tail) brief += `\n\n## Last lines on ${from.name}'s screen (${AGENT_META[fromAgent].label})\n${tail}`;
      brief += `\n\nYou are ${from.name}, continuing this work in ${AGENT_META[agent].label} (switched from ${AGENT_META[fromAgent].label}).`;
      if (req.continuePrompt) brief += `\n\n${req.continuePrompt}`;
      if (brief.length > MAX_BRIEF) brief = `${brief.slice(0, MAX_BRIEF - 1)}…`;

      const live = manager.get(id);
      if (!live) throw new NotFoundError(`${from.name} was closed`);
      const closeOld = req.closeOld !== false;
      const spot = { ...live.layout };
      // The new console takes the exact spot; the old one moves aside until it goes
      manager.update(id, { layout: { x: spot.x + spot.width + ASIDE_GAP } });
      let target: ConsoleInfo;
      try {
        target = manager.create({
          cwd: live.cwd,
          name: live.name,
          layout: spot,
          ...(live.workspaceId ? { workspaceId: live.workspaceId } : {}),
          ...(agent !== 'claude' ? { agent } : {}),
          ...(accountId ? { accountId } : agent === 'claude' ? { accountId: 'auto' } : {}),
          ...(model ? { model } : {}),
        });
      } catch (err) {
        manager.update(id, { layout: { x: spot.x } });
        throw new SwitchAgentError(err instanceof Error ? err.message : String(err));
      }
      this.carryOver(live, target, closeOld, req.fallbackFrom);
      // Stop the old agent now: two agents must not keep editing the same folder
      if (closeOld && live.status !== 'exited' && live.status !== 'suspended') {
        try {
          manager.suspend(id);
        } catch {
          // already gone
        }
      }

      const job = handoffs.deliverWhenReady(live, target, brief, (sent) => {
        this.switching.delete(id);
        if (!sent || !closeOld) return;
        const timer = setTimeout(() => {
          if (manager.get(id)) manager.remove(id);
        }, this.options.removeDelayMs ?? REMOVE_DELAY_MS);
        timer.unref?.();
      });
      job.title = switchJobTitle(live.name, fromAgent, agent);
      manager.emit('job', job);
      manager.persist();
      if (!closeOld) this.switching.delete(id);
      return {
        console: target,
        job,
        brief,
        briefMode: preview.mode,
        ...(preview.warning ? { warning: preview.warning } : {}),
      };
    } catch (err) {
      this.switching.delete(id);
      throw err;
    }
  }

  // Role, project, worktree and the fallback marker move to the new console
  private carryOver(from: ConsoleInfo, target: ConsoleInfo, closeOld: boolean, fallbackFrom: ConsoleInfo['fallbackFrom']): void {
    const { manager } = this.options;
    if (from.role) target.role = from.role;
    // Sharing a worktree between two live consoles would let "Discard branch" on one pull it from the other
    if (closeOld && from.git) {
      target.git = { ...from.git };
      if (from.gitStats) target.gitStats = { ...from.gitStats };
    }
    if (fallbackFrom) target.fallbackFrom = fallbackFrom;
    if (from.projectId) {
      const project = manager.projects.find((p) => p.id === from.projectId);
      if (project) {
        const at = project.consoleIds.indexOf(from.id);
        project.consoleIds.splice(at >= 0 ? at + 1 : project.consoleIds.length, 0, target.id);
        target.projectId = project.id;
        manager.emit('project', project);
      }
    }
    manager.touch(target.id);
  }
}

export function registerSwitchAgentRoutes(app: FastifyInstance, options: SwitchAgentOptions): SwitchAgentService {
  const service = new SwitchAgentService(options);
  app.post('/api/consoles/:id/switch-agent', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<SwitchAgentRequest>;
    try {
      return await service.switchAgent(id, {
        agent: body.agent as AgentKind,
        ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.closeOld === 'boolean' ? { closeOld: body.closeOld } : {}),
        ...(body.briefMode !== undefined ? { briefMode: body.briefMode } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SwitchAgentError) return reply.code(err.statusCode).send({ error: message, ...err.extra });
      return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
    }
  });
  return service;
}
