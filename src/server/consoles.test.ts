import { describe, expect, it } from 'vitest';
import { STATE_VERSION, type ConsoleInfo } from '../shared/protocol.js';
import { ConsoleManager } from './consoles.js';

function info(id: string, status: ConsoleInfo['status']): ConsoleInfo {
  return {
    id,
    name: id,
    cwd: process.cwd(),
    sessionId: `${id}-session`,
    status,
    statusDetail: 'old detail',
    statusChangedAt: 1,
    layout: { x: 0, y: 0, width: 700, height: 500 },
    createdAt: 1,
  };
}

describe('ConsoleManager.restore', () => {
  it('suspends live consoles instead of relaunching them, and keeps exited ones exited', () => {
    let changes = 0;
    const manager = new ConsoleManager({ port: 1, token: 't', onChange: () => changes++ });
    manager.restore(
      {
        version: STATE_VERSION,
        consoles: [info('a', 'resting'), info('b', 'exited'), info('c', 'suspended')],
        jobs: [],
        actions: [],
        projects: [],
        browsers: [],
        items: [],
        workspaces: [],
      },
      { resumeAll: false },
    );
    const byId = Object.fromEntries(manager.getState().consoles.map((c) => [c.id, c]));
    expect(byId.a.status).toBe('suspended');
    expect(byId.a.statusDetail).toBeUndefined();
    expect(byId.a.sessionId).toBe('a-session');
    expect(byId.b.status).toBe('exited');
    expect(byId.c.status).toBe('suspended');
    expect(changes).toBeGreaterThan(0);
  });

  it('lets suspended consoles be attached (empty replay) and ignores input and hooks', () => {
    const manager = new ConsoleManager({ port: 1, token: 't', onChange: () => {} });
    manager.restore(
      {
        version: STATE_VERSION,
        consoles: [info('a', 'idle')],
        jobs: [],
        actions: [],
        projects: [],
        browsers: [],
        items: [],
        workspaces: [],
      },
      { resumeAll: false },
    );
    expect(manager.attach('a', () => {})).toBe('');
    expect(() => manager.input('a', 'hello\r')).not.toThrow();
    manager.handleHook('a', { hook_event_name: 'UserPromptSubmit' });
    expect(manager.get('a')?.status).toBe('suspended');
  });
});
