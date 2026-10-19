import { describe, expect, it, vi } from 'vitest';
import { RESUME_PROMPT } from '../shared/protocol.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import { PauseService } from './pause.js';
import { ProjectService } from './projects.js';

function setup() {
  const consoles = [fakeConsole('ada', 'working'), fakeConsole('bex', 'working'), fakeConsole('cy', 'resting'), fakeConsole('dax', 'needs_you')];
  const { manager, typed } = fakeManager(consoles);
  const input = vi.spyOn(manager, 'input').mockImplementation(() => undefined);
  const projects = new ProjectService(manager);
  const pause = new PauseService(manager);
  return { manager, typed, input, projects, pause };
}

describe('PauseService', () => {
  it('pauses only working consoles with Esc, and resumes them with the continue prompt', () => {
    const { manager, typed, input, pause } = setup();
    expect(pause.pause()).toEqual({ count: 2, names: ['Ada', 'Bex'] });
    expect(input.mock.calls).toEqual([
      ['ada', '\x1b'],
      ['bex', '\x1b'],
    ]);
    expect(manager.get('ada')).toMatchObject({ paused: true, status: 'resting', statusDetail: 'Paused' });
    expect(manager.get('cy')!.paused).toBeUndefined();
    expect(pause.pausedCount()).toBe(2);

    expect(pause.resume()).toEqual({ count: 2, names: ['Ada', 'Bex'] });
    expect(typed).toEqual([
      { id: 'ada', text: RESUME_PROMPT },
      { id: 'bex', text: RESUME_PROMPT },
    ]);
    expect(manager.get('ada')!.paused).toBeUndefined();
    expect(pause.pausedCount()).toBe(0);
  });

  it('scopes to one project', () => {
    const { input, projects, pause } = setup();
    const project = projects.create({ name: 'Frontend', consoleIds: ['bex', 'cy'] });
    expect(pause.pause(project.id).names).toEqual(['Bex']);
    expect(input).toHaveBeenCalledTimes(1);
    expect(() => pause.pause('nope')).toThrow(/Unknown project/);
  });

  it('typing a prompt yourself clears the paused mark', () => {
    const { manager, pause } = setup();
    pause.pause();
    manager.handleHook('ada', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' } as never);
    expect(manager.get('ada')!.paused).toBeUndefined();
    expect(manager.get('bex')!.paused).toBe(true);
  });

  it('a paused console that stopped loses the mark without being typed into', () => {
    const { manager, typed, pause } = setup();
    pause.pause();
    manager.get('ada')!.status = 'exited';
    expect(pause.resume().names).toEqual(['Bex']);
    expect(typed.map((t) => t.id)).toEqual(['bex']);
    expect(manager.get('ada')!.paused).toBeUndefined();
  });
});

describe('team messages', () => {
  it('sends to every running console of the project, never into a dialog', () => {
    const { typed, projects, pause } = setup();
    const project = projects.create({ name: 'Team', consoleIds: ['ada', 'cy', 'dax'] });
    expect(pause.sendToProject(project.id, 'Status?')).toEqual({ sent: 2, names: ['Ada', 'Cy'], skipped: ['Dax'] });
    expect(typed).toEqual([
      { id: 'ada', text: 'Status?' },
      { id: 'cy', text: 'Status?' },
    ]);
    expect(() => pause.sendToProject(project.id, ' ')).toThrow(/text is required/);
  });
});
