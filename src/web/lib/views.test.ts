import { describe, expect, it } from 'vitest';
import type { ConsoleInfo, Project } from '../../shared/protocol';
import {
  focusWallConsoles,
  parseView,
  popoutFeatures,
  popoutKey,
  scopeToProject,
  viewUrl,
  wallGrid,
  windowTitle,
} from './views';

function c(id: string, over: Partial<ConsoleInfo> = {}): ConsoleInfo {
  return {
    id,
    name: id,
    cwd: '/x',
    sessionId: 's',
    status: 'idle',
    statusChangedAt: 0,
    layout: { x: 0, y: 0, width: 760, height: 460 },
    createdAt: 0,
    ...over,
  };
}

function p(id: string, consoleIds: string[], open = true): Project {
  return { id, name: id, color: 'blue', consoleIds, open, createdAt: 0 };
}

describe('parseView / viewUrl', () => {
  it('round-trips every view', () => {
    for (const view of [
      { kind: 'board' },
      { kind: 'console', id: 'abc-1' },
      { kind: 'project', id: 'p 1/x' },
      { kind: 'focus' },
    ] as const) {
      const url = new URL(viewUrl(view), 'http://127.0.0.1:4317');
      expect(parseView(url.search)).toEqual(view);
    }
  });

  it('falls back to the board for unknown or incomplete views', () => {
    expect(parseView('')).toEqual({ kind: 'board' });
    expect(parseView('?view=console')).toEqual({ kind: 'board' });
    expect(parseView('?view=console&id=%20')).toEqual({ kind: 'board' });
    expect(parseView('?view=nope&id=1')).toEqual({ kind: 'board' });
    expect(parseView('?token=abc&view=focus')).toEqual({ kind: 'focus' });
  });

  it('builds the URLs the server and ntfy links use', () => {
    expect(viewUrl({ kind: 'console', id: 'c1' })).toBe('/?view=console&id=c1');
    expect(viewUrl({ kind: 'focus' })).toBe('/?view=focus');
    expect(viewUrl({ kind: 'board' })).toBe('/');
  });
});

describe('window helpers', () => {
  it('uses one stable window name per item', () => {
    expect(popoutKey({ kind: 'console', id: 'c1' })).toBe('agentarmy-console-c1');
    expect(popoutKey({ kind: 'project', id: 'p1' })).toBe('agentarmy-project-p1');
    expect(popoutKey({ kind: 'focus' })).toBe('agentarmy-focus');
  });

  it('asks for a popup that fits the screen', () => {
    expect(popoutFeatures({ kind: 'console', id: 'c' })).toBe('popup,width=960,height=640');
    expect(popoutFeatures({ kind: 'focus' }, { availWidth: 1000, availHeight: 700 })).toBe('popup,width=1000,height=700');
  });

  it('prefixes the title with the needs-you count', () => {
    expect(windowTitle('Ada', 0)).toBe('Ada · GridHive');
    expect(windowTitle('Shop', 2)).toBe('(2) Shop · GridHive');
    expect(windowTitle('', 0)).toBe('GridHive');
  });
});

describe('focus wall', () => {
  it('keeps needing-you (longest waiting first) then working consoles of open projects', () => {
    const consoles = {
      a: c('a', { status: 'working', statusChangedAt: 1 }),
      b: c('b', { status: 'needs_you', statusChangedAt: 5 }),
      d: c('d', { status: 'needs_you', statusChangedAt: 2 }),
      e: c('e', { status: 'resting' }),
      f: c('f', { status: 'working', projectId: 'closed' }),
      g: c('g', { status: 'working', projectId: 'open' }),
    };
    const projects = { closed: p('closed', ['f'], false), open: p('open', ['g']) };
    expect(focusWallConsoles(consoles, projects).map((x) => x.id)).toEqual(['d', 'b', 'g', 'a']);
  });

  it('picks a grid that keeps tiles large', () => {
    expect(wallGrid(0, 1000, 800)).toEqual({ cols: 1, rows: 1 });
    expect(wallGrid(1, 1400, 800)).toEqual({ cols: 1, rows: 1 });
    expect(wallGrid(2, 1400, 800)).toEqual({ cols: 2, rows: 1 });
    expect(wallGrid(4, 1400, 860)).toEqual({ cols: 2, rows: 2 });
    expect(wallGrid(3, 600, 1400)).toEqual({ cols: 1, rows: 3 });
  });
});

describe('scopeToProject', () => {
  it('returns everything without a project, else only its consoles and frame', () => {
    const consoles = { a: c('a', { projectId: 'p' }), b: c('b') };
    const browsers = { t: { id: 't' } };
    const projects = { p: p('p', ['a', 'gone']), q: p('q', ['b']) };
    expect(scopeToProject(undefined, consoles, browsers, projects).consoles).toBe(consoles);
    const scoped = scopeToProject('p', consoles, browsers, projects);
    expect(Object.keys(scoped.consoles)).toEqual(['a']);
    expect(scoped.browsers).toEqual({});
    expect(Object.keys(scoped.projects)).toEqual(['p']);
    expect(scopeToProject('missing', consoles, browsers, projects).consoles).toEqual({});
  });
});
