import { describe, expect, it } from 'vitest';
import type { ConsoleInfo, CreateConsoleRequest, Project } from '../shared/protocol.js';
import { TemplateService, type FirstPromptQueue } from './templates.js';
import type { ConsoleManager } from './consoles.js';
import type { ProjectService } from './projects.js';

// "Run this team on": the launch request carries the orchestrator's CLI, per-team models and
// per-provider accounts down to each console create call.

function harness() {
  const created: CreateConsoleRequest[] = [];
  const consoles = new Map<string, ConsoleInfo>();
  const manager = {
    create(req: CreateConsoleRequest): ConsoleInfo {
      created.push(req);
      const info = {
        id: `c${created.length}`,
        name: `Agent${created.length}`,
        cwd: req.cwd,
        sessionId: 's',
        status: 'starting',
        statusChangedAt: 0,
        layout: { x: 0, y: 0, width: 1, height: 1 },
        createdAt: 0,
        ...(req.agent ? { agent: req.agent } : {}),
      } as ConsoleInfo;
      consoles.set(info.id, info);
      return info;
    },
    get: (id: string) => consoles.get(id),
    touch: () => undefined,
    list: () => [...consoles.values()],
  } as unknown as ConsoleManager;
  const projects = {
    create: (req: { name: string; consoleIds?: string[] }) => ({ id: req.name, name: req.name, open: true, consoleIds: req.consoleIds }) as unknown as Project,
  } as unknown as ProjectService;
  const prompts = { add: () => undefined } as unknown as FirstPromptQueue;
  return { created, service: new TemplateService(manager, projects, prompts) };
}

describe('TemplateService.launch agent options', () => {
  it('runs every team and the orchestrator on the chosen CLI with its model', () => {
    const { created, service } = harness();
    service.launch('bug-squad', {
      cwd: '.',
      teamAgents: ['codex'],
      teamModels: ['gpt-5-codex'],
      orchestratorAgent: 'codex',
      orchestratorModel: 'gpt-5',
    });
    expect(created).toHaveLength(4);
    expect(created.every((r) => r.agent === 'codex')).toBe(true);
    expect(created[0].model).toBe('gpt-5');
    expect(created.slice(1).map((r) => r.model)).toEqual(['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex']);
  });

  it('keeps the old behaviour without the new fields (all Claude, no model)', () => {
    const { created, service } = harness();
    service.launch('bug-squad', { cwd: '.', accountId: 'work' });
    expect(created.every((r) => r.agent === undefined && r.model === undefined && r.accountId === 'work')).toBe(true);
  });

  it('picks the account per provider and ignores custom as a team CLI', () => {
    const { created, service } = harness();
    service.launch('full-stack-trio', {
      cwd: '.',
      accountId: 'claude-2',
      teamAgents: ['claude', 'gemini', 'custom'],
      agentAccounts: { gemini: 'gemini-work', claude: 'auto' },
    });
    expect(created.map((r) => r.agent)).toEqual([undefined, 'gemini', undefined]);
    expect(created.map((r) => r.accountId)).toEqual(['claude-2', 'gemini-work', 'claude-2']);
  });
});
