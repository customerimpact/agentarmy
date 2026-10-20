import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleInfo, CreateConsoleRequest } from '../shared/protocol.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { HandoffService } from './handoffs.js';
import { JobService } from './jobs.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { SwitchAgentError, SwitchAgentService, notInstalledError, screenTail, switchJobTitle } from './switch-agent.js';

function setup(options: { installed?: boolean } = {}) {
  const ada: ConsoleInfo = { ...fakeConsole('ada', 'working', { x: 100, y: 200, width: 600, height: 400 }), role: 'Backend', projectId: 'p1' };
  const { manager, typed, setStatus } = fakeManager([ada, fakeConsole('bex')]);
  manager.projects.push({ id: 'p1', name: 'API', color: 'blue', consoleIds: ['ada', 'bex'], open: true, createdAt: 1 } as never);
  manager.get('ada')!.git = { repoRoot: 'C:/repo', branch: 'gridhive/ada-1', baseRef: 'main', worktree: process.cwd() };
  new JobService(manager);
  const created: CreateConsoleRequest[] = [];
  let n = 0;
  // No PTYs: create registers a 'starting' console like the real one does before its CLI draws
  manager.create = vi.fn((req: CreateConsoleRequest) => {
    created.push(req);
    const info: ConsoleInfo = {
      ...fakeConsole(`new${++n}`, 'starting', { x: 0, y: 0, width: 600, height: 400, ...req.layout }),
      name: req.name ?? 'New',
      cwd: req.cwd,
      ...(req.agent ? { agent: req.agent } : {}),
      ...(req.model ? { launchModel: req.model } : {}),
    };
    (manager as unknown as { register(i: ConsoleInfo): void }).register(info);
    manager.emit('console', info);
    return info;
  });
  const handoffs = new HandoffService(manager, {
    settings: () => ({ ...DEFAULT_SETTINGS, claudePath: process.execPath }),
    newAgentDelayMs: 0,
  });
  const installed = vi.fn(async () => ({ installed: options.installed ?? true }));
  const service = new SwitchAgentService({ manager, handoffs, settings: () => DEFAULT_SETTINGS, installed, removeDelayMs: 50 });
  return { manager, typed, setStatus, service, created, installed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SwitchAgentService', () => {
  it('starts the target CLI in the same spot, types the brief once it is idle, then removes the old console', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager, typed, setStatus, service, created } = setup();
    const res = await service.switchAgent('ada', { agent: 'codex', model: 'gpt-5.5-codex', continuePrompt: 'Continue the task.' });

    expect(created[0]).toMatchObject({ cwd: process.cwd(), name: 'Ada', agent: 'codex', model: 'gpt-5.5-codex', layout: { x: 100, y: 200, width: 600, height: 400 } });
    const target = manager.get(res.console.id)!;
    expect(target).toMatchObject({ name: 'Ada', agent: 'codex', role: 'Backend', projectId: 'p1', launchModel: 'gpt-5.5-codex' });
    expect(target.git?.branch).toBe('gridhive/ada-1'); // worktree carried over (closeOld)
    expect(manager.projects[0].consoleIds).toEqual(['ada', target.id, 'bex']);
    // Old one moved aside and stopped so two agents never edit the same folder
    expect(manager.get('ada')!.layout.x).toBe(100 + 600 + 40);
    expect(manager.get('ada')!.status).toBe('suspended');
    expect(res.job).toMatchObject({ fromId: 'ada', toId: target.id, kind: 'handoff', status: 'sent', title: 'Switch: Ada Claude → Codex' });
    expect(res.brief).toContain('[GridHive handoff from Ada]');
    expect(res.brief).toContain('continuing this work in Codex CLI (switched from Claude Code)');
    expect(res.brief.endsWith('Continue the task.')).toBe(true);
    expect(typed).toEqual([]); // not ready yet

    setStatus(target.id, 'idle');
    expect(typed).toEqual([{ id: target.id, text: res.brief }]);
    expect(manager.get('ada')).toBeDefined();
    await vi.advanceTimersByTimeAsync(60);
    expect(manager.get('ada')).toBeUndefined();
    expect(manager.jobs.find((j) => j.id === res.job.id)?.status).toBe('sent'); // the job stays (line to the new console)
  });

  it('keeps the old console when closeOld is false and does not share its worktree', async () => {
    const { manager, setStatus, service } = setup();
    const res = await service.switchAgent('ada', { agent: 'gemini', closeOld: false });
    expect(manager.get(res.console.id)!.git).toBeUndefined();
    expect(manager.get('ada')!.status).toBe('working');
    setStatus(res.console.id, 'idle');
    await new Promise((r) => setTimeout(r, 80));
    expect(manager.get('ada')).toBeDefined();
  });

  it('refuses a CLI that is not installed, with the install command', async () => {
    const { service, manager } = setup({ installed: false });
    const err = await service.switchAgent('ada', { agent: 'codex' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwitchAgentError);
    expect((err as SwitchAgentError).message).toContain('npm install -g @openai/codex');
    expect((err as SwitchAgentError).extra).toMatchObject({ code: 'not_installed', agent: 'codex', installCommand: 'npm install -g @openai/codex' });
    expect(manager.get('ada')!.layout.x).toBe(100); // nothing moved
    expect(manager.create).not.toHaveBeenCalled();
  });

  it('rejects bad requests', async () => {
    const { service } = setup();
    await expect(service.switchAgent('ada', { agent: 'claude' })).rejects.toThrow('already runs Claude Code');
    await expect(service.switchAgent('ada', { agent: 'custom' })).rejects.toThrow('agent must be');
    await expect(service.switchAgent('ada', { agent: 'codex', model: 'bad model; rm' })).rejects.toThrow('Not a model name');
    await expect(service.switchAgent('nope', { agent: 'codex' })).rejects.toThrow('Unknown console');
  });

  it('adds the last screen lines for CLIs without a readable transcript', async () => {
    const { manager, service } = setup();
    const first = await service.switchAgent('ada', { agent: 'codex', closeOld: false });
    manager.emit('output', first.console.id, '\x1b[1mWorking\x1b[0m\r\nDone: wrote the parser\r\n');
    const back = await service.switchAgent(first.console.id, { agent: 'claude', closeOld: false });
    expect(back.brief).toContain("Last lines on Ada's screen (Codex CLI)");
    expect(back.brief).toContain('Done: wrote the parser');
    expect(back.job.title).toBe('Switch: Ada Codex → Claude');
  });
});

describe('switch-agent helpers', () => {
  it('collapses TUI redraws in the screen tail', () => {
    expect(screenTail('a\r\nspin\rspin\r\nb\n\n')).toBe('a\nspin\nb');
  });
  it('names the switch and the install hint', () => {
    expect(switchJobTitle('Ada', 'claude', 'grok')).toBe('Switch: Ada Claude → Grok');
    expect(notInstalledError('grok', 'win32').extra.installCommand).toBe('irm https://x.ai/cli/install.ps1 | iex');
    expect(notInstalledError('grok', 'linux').extra.installCommand).toBe('curl -fsSL https://x.ai/cli/install.sh | bash');
  });
});
