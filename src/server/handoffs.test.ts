import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from './settings.js';
import { HandoffService } from './handoffs.js';
import { JobService } from './jobs.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-handoff-'));
const transcript = path.join(dir, 'ada.jsonl');
fs.writeFileSync(
  transcript,
  [
    { type: 'user', message: { content: 'Fix the login bug' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(process.cwd(), 'src', 'login.ts') } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Found it in the token check.' }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n'),
);

function setup(smart?: () => Promise<string>) {
  const { manager, typed, setStatus } = fakeManager([fakeConsole('ada'), fakeConsole('bex'), fakeConsole('cy', 'needs_you')]);
  const jobs = new JobService(manager);
  const service = new HandoffService(manager, {
    settings: () => ({ ...DEFAULT_SETTINGS }),
    ...(smart ? { smart: vi.fn(smart) } : {}),
  });
  manager.handleHook('ada', { hook_event_name: 'SessionStart', transcript_path: transcript, source: 'startup' });
  setStatus('ada', 'resting');
  return { manager, typed, service, jobs };
}

describe('HandoffService', () => {
  it('builds a quick brief from the hook-reported transcript', async () => {
    const { service } = setup();
    const { brief, mode } = await service.preview({ fromId: 'ada', toId: 'bex', mode: 'quick', note: 'Ship today' });
    expect(mode).toBe('quick');
    expect(brief).toContain('[AgentArmy handoff from Ada]');
    expect(brief).toContain('Ship today');
    expect(brief).toContain('- Fix the login bug');
    expect(brief).toContain('Found it in the token check.');
    expect(brief).toContain('- src/login.ts');
  });

  it('uses claude -p for smart mode and falls back to quick when it fails', async () => {
    const ok = setup(async () => 'Goal: fix login');
    const smart = await ok.service.preview({ fromId: 'ada', toId: 'bex', mode: 'smart' });
    expect(smart.mode).toBe('smart');
    expect(smart.brief).toMatch(/^\[AgentArmy handoff from Ada\]\n/);
    expect(smart.brief).toContain('Goal: fix login');

    const bad = setup(async () => {
      throw new Error('Not logged in');
    });
    const fallback = await bad.service.preview({ fromId: 'ada', toId: 'bex', mode: 'smart' });
    expect(fallback.mode).toBe('quick');
    expect(fallback.warning).toContain('Not logged in');
    expect(fallback.brief).toContain('- Fix the login bug');
  });

  it('types the brief into the target and records a handoff job that never pings the source', () => {
    const { service, typed, manager } = setup();
    const { job, console: target } = service.send({ fromId: 'ada', toId: 'Bex', brief: 'BRIEF' });
    expect(target.id).toBe('bex');
    expect(job).toMatchObject({ fromId: 'ada', toId: 'bex', kind: 'handoff', status: 'sent', title: 'Handoff: Ada → Bex' });
    expect(manager.jobs).toContain(job);
    expect(typed).toEqual([{ id: 'bex', text: 'BRIEF' }]);

    manager.handleHook('bex', { hook_event_name: 'UserPromptSubmit', prompt: 'BRIEF' });
    expect(job.status).toBe('working');
    manager.handleHook('bex', { hook_event_name: 'Stop', last_assistant_message: 'carried on' });
    expect(job.status).toBe('done');
    expect(typed.filter((t) => t.id === 'ada')).toEqual([]);
  });

  it('refuses targets that cannot take typing', () => {
    const { service } = setup();
    expect(() => service.send({ fromId: 'ada', toId: 'cy', brief: 'B' })).toThrow('waiting on you');
    expect(() => service.send({ fromId: 'ada', toId: 'ada', brief: 'B' })).toThrow('itself');
    expect(() => service.send({ fromId: 'ada', toId: 'nobody', brief: 'B' })).toThrow('No agent');
    expect(() => service.send({ fromId: 'ada', toId: 'bex', brief: '  ' })).toThrow('brief is required');
  });
});
