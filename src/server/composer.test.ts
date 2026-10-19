import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleInfo, ConsoleLayout, CreateConsoleRequest } from '../shared/protocol.js';
import { FRAME_PADDING, FRAME_TITLE_HEIGHT } from '../shared/templates.js';
import { ComposerService, composerColumns, CustomTemplates, layoutComposer, parseRows, teamsFromRows } from './composer.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { ProjectService } from './projects.js';
import { FirstPromptQueue } from './templates.js';

const overlaps = (a: ConsoleLayout, b: ConsoleLayout): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('layoutComposer', () => {
  it('picks a compact grid', () => {
    expect([1, 2, 4, 5, 9, 10, 12].map(composerColumns)).toEqual([1, 2, 2, 3, 3, 4, 4]);
  });

  for (const count of [1, 3, 6, 12]) {
    it(`${count} consoles fit inside the frame without overlapping`, () => {
      const { frame, consoles } = layoutComposer(count, { x: 100, y: 40 });
      expect(consoles).toHaveLength(count);
      for (let i = 0; i < consoles.length; i++) {
        const c = consoles[i];
        expect(c.x).toBeGreaterThanOrEqual(frame.x + FRAME_PADDING);
        expect(c.y).toBeGreaterThanOrEqual(frame.y + FRAME_TITLE_HEIGHT + FRAME_PADDING);
        expect(c.x + c.width).toBeLessThanOrEqual(frame.x + frame.width - FRAME_PADDING);
        expect(c.y + c.height).toBeLessThanOrEqual(frame.y + frame.height - FRAME_PADDING);
        for (let j = i + 1; j < consoles.length; j++) expect(overlaps(c, consoles[j])).toBe(false);
      }
    });
  }
});

describe('rows', () => {
  it('validates and cleans rows', () => {
    expect(parseRows([{ name: ' Ada ', role: 'Frontend', prompt: 'hi', accountId: 'auto', worktree: true }, {}])).toEqual([
      { name: 'Ada', role: 'Frontend', prompt: 'hi', worktree: true },
      {},
    ]);
    expect(() => parseRows([])).toThrow(/at least one/);
    expect(() => parseRows(Array.from({ length: 13 }, () => ({})))).toThrow(/At most 12/);
    expect(() => parseRows([{ name: 5 }])).toThrow(/name must be a string/);
  });

  it('derives one team per role', () => {
    expect(teamsFromRows([{ role: 'Frontend' }, { role: 'Frontend' }, {}])).toEqual([
      { name: 'Frontend', role: 'Frontend', count: 2 },
      { name: 'General', role: 'General', count: 1 },
    ]);
  });
});

describe('CustomTemplates', () => {
  it('saves to templates.json, reloads and deletes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-templates-'));
    const file = path.join(dir, 'templates.json');
    const store = new CustomTemplates(file);
    const t = store.save({ name: 'My team', rows: [{ role: 'Frontend' }, { role: 'Tests', prompt: 'Write tests' }] });
    expect(t).toMatchObject({ custom: true, orchestrator: false, description: '2 agents: Frontend, Tests' });
    expect(t.id).toMatch(/^custom-/);
    const again = new CustomTemplates(file);
    expect(again.list().map((x) => x.name)).toEqual(['My team']);
    again.remove(t.id);
    expect(new CustomTemplates(file).list()).toEqual([]);
    expect(() => again.remove('nope')).toThrow(/Unknown/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ComposerService', () => {
  function setup(failAt = -1) {
    const { manager, typed } = fakeManager([]);
    let seq = 0;
    vi.spyOn(manager, 'create').mockImplementation((req: CreateConsoleRequest) => {
      if (seq === failAt) throw new Error('boom');
      const info: ConsoleInfo = { ...fakeConsole(`c${++seq}`), name: req.name || `Auto${seq}`, cwd: req.cwd, layout: req.layout as ConsoleLayout };
      (manager as unknown as { register: (i: ConsoleInfo) => void }).register(info);
      return info;
    });
    const projects = new ProjectService(manager);
    const composer = new ComposerService(manager, projects, undefined, new FirstPromptQueue(manager, 0));
    return { manager, typed, projects, composer };
  }

  it('launches every row into one project with roles and first prompts', async () => {
    const { manager, typed, composer } = setup();
    const result = await composer.launch({
      cwd: process.cwd(),
      projectName: 'Squad',
      origin: { x: 0, y: 0 },
      rows: [
        { name: 'Ada', role: 'Frontend', prompt: 'You are {name} ({role}) in {team}.' },
        { role: 'Tests' },
      ],
    });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({ name: 'Squad', consoleIds: ['c1', 'c2'] });
    expect(manager.get('c1')).toMatchObject({ name: 'Ada', role: 'Frontend', projectId: result.projects[0].id });
    expect(manager.get('c2')!.role).toBe('Tests');
    expect(typed).toEqual([{ id: 'c1', text: 'You are Ada (Frontend) in Squad.' }]);
  });

  it('removes the consoles it made when one row fails', async () => {
    const { manager, composer } = setup(1);
    await expect(composer.launch({ cwd: process.cwd(), rows: [{}, {}, {}] })).rejects.toThrow('boom');
    expect(manager.list()).toEqual([]);
  });

  it('rejects a missing folder', async () => {
    const { composer } = setup();
    await expect(composer.launch({ cwd: path.join(os.tmpdir(), 'does-not-exist-aa'), rows: [{}] })).rejects.toThrow(/Not a directory/);
  });
});
