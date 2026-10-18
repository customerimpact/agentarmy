import { describe, expect, it } from 'vitest';
import type { ActionItem, ConsoleInfo, Job, Project } from '../../shared/protocol';
import {
  attentionCount,
  combinedProgress,
  fleetCounts,
  groupByProject,
  isOrchestrator,
  progressBuckets,
  rangeBetween,
  relativeTime,
  shortModel,
} from './fleet';

function con(id: string, extra: Partial<ConsoleInfo> = {}): ConsoleInfo {
  return {
    id,
    name: id,
    cwd: 'C:\\dev\\app',
    sessionId: 's',
    status: 'idle',
    statusChangedAt: 0,
    layout: { x: 0, y: 0, width: 1, height: 1 },
    createdAt: 0,
    ...extra,
  };
}

function project(id: string, consoleIds: string[], extra: Partial<Project> = {}): Project {
  return { id, name: id, color: 'orange', consoleIds, open: true, createdAt: 0, ...extra };
}

describe('shortModel', () => {
  it('shortens Claude model ids', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(shortModel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(shortModel('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(shortModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M');
    expect(shortModel('opus')).toBe('Opus');
  });
  it('keeps unknown names and handles empty', () => {
    expect(shortModel('gpt-5')).toBe('gpt-5');
    expect(shortModel(undefined)).toBe('');
  });
});

describe('relativeTime', () => {
  it('formats ages', () => {
    expect(relativeTime(0, 10_000)).toBe('just now');
    expect(relativeTime(0, 5 * 60_000)).toBe('5m ago');
    expect(relativeTime(0, 3 * 3600_000)).toBe('3h ago');
    expect(relativeTime(0, 50 * 3600_000)).toBe('2d ago');
  });
});

describe('groupByProject', () => {
  it('groups by projectId or membership and sorts needs-you first', () => {
    const consoles = [
      con('a', { projectId: 'p1' }),
      con('b', { status: 'needs_you' }),
      con('c'),
      con('d', { status: 'needs_you' }),
    ];
    const { groups, ungrouped } = groupByProject(consoles, {
      p1: project('p1', []),
      p2: project('p2', ['d'], { createdAt: 1 }),
    });
    expect(groups.map((g) => g.consoles.map((c) => c.id))).toEqual([['a'], ['d']]);
    expect(ungrouped.map((c) => c.id)).toEqual(['b', 'c']);
  });
});

describe('progress', () => {
  it('combines todos and jobs', () => {
    const consoles = [
      con('a', {
        todos: [
          { content: 'x', status: 'completed' },
          { content: 'y', status: 'pending' },
        ],
      }),
    ];
    const jobs = [
      { id: 'j', fromId: null, toId: 'a', status: 'done' } as Job,
      { id: 'k', fromId: null, toId: 'zz', status: 'done' } as Job,
    ];
    expect(combinedProgress(consoles, jobs)).toEqual({ done: 2, total: 3, ratio: 2 / 3 });
    expect(combinedProgress([], []).ratio).toBe(0);
  });

  it('buckets ungrouped consoles by folder', () => {
    const buckets = progressBuckets(
      [con('a', { projectId: 'p' }), con('b', { cwd: '/x/web' }), con('c', { cwd: '/y/web/' })],
      { p: project('p', ['a']), empty: project('empty', []) },
    );
    expect(buckets.map((b) => [b.label, b.consoles.length])).toEqual([
      ['p', 1],
      ['web', 2],
    ]);
  });
});

describe('fleet', () => {
  it('counts buckets', () => {
    expect(
      fleetCounts([
        con('a', { status: 'working' }),
        con('b', { status: 'needs_you' }),
        con('c', { status: 'error' }),
        con('d', { status: 'resting' }),
        con('e'),
      ]),
    ).toEqual({ working: 1, needs: 2, idle: 1, done: 1 });
  });

  it('detects orchestrators by role or sent jobs', () => {
    expect(isOrchestrator(con('a', { role: 'Orchestrator' }), [])).toBe(true);
    expect(isOrchestrator(con('b'), [{ fromId: 'b' } as Job])).toBe(true);
    expect(isOrchestrator(con('c'), [])).toBe(false);
  });
});

describe('attentionCount', () => {
  it('counts open actions plus uncovered needs-you consoles', () => {
    const actions: Record<string, ActionItem> = {
      x: { id: 'x', consoleId: 'a', kind: 'needs_you', title: '', createdAt: 0 },
      y: { id: 'y', consoleId: null, kind: 'request', title: '', createdAt: 0 },
      z: { id: 'z', consoleId: 'c', kind: 'error', title: '', createdAt: 0, resolvedAt: 1 },
    };
    const consoles = {
      a: con('a', { status: 'needs_you' }),
      b: con('b', { status: 'needs_you' }),
    };
    expect(attentionCount(consoles, actions)).toBe(3);
    expect(attentionCount({}, {})).toBe(0);
  });
});

describe('rangeBetween', () => {
  it('returns the inclusive range in either direction', () => {
    expect(rangeBetween(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
    expect(rangeBetween(['a', 'b'], 'q', 'b')).toEqual(['b']);
  });
});
