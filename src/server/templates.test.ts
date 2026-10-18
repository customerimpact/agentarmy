import { describe, expect, it } from 'vitest';
import type { ConsoleLayout } from '../shared/protocol.js';
import { BUILTIN_TEMPLATES, FRAME_PADDING, FRAME_TITLE_HEIGHT, fillPrompt } from '../shared/templates.js';
import { DEFAULT_SIZE } from './placement.js';
import { layoutTemplate } from './templates.js';

const overlaps = (a: ConsoleLayout, b: ConsoleLayout): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inside = (inner: ConsoleLayout, outer: ConsoleLayout): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y + FRAME_TITLE_HEIGHT &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe('built-in templates', () => {
  it('have unique ids and the required presets', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['dev-hq', 'solo-reviewer', 'bug-squad', 'full-stack-trio', 'docs-crew', 'research-build']),
    );
    const hq = BUILTIN_TEMPLATES.find((t) => t.id === 'dev-hq')!;
    expect(hq.orchestrator).toBe(true);
    expect(hq.teams.map((t) => [t.name, t.count])).toEqual([
      ['Frontend', 4],
      ['Backend', 4],
      ['Reviewers', 4],
    ]);
  });

  it('fills prompt placeholders', () => {
    expect(fillPrompt('{name} in {team} {x}', { name: 'Ada', team: 'Frontend' })).toBe(
      'Ada in Frontend {x}',
    );
  });
});

describe('layoutTemplate', () => {
  for (const template of BUILTIN_TEMPLATES) {
    it(`${template.id}: no console or frame overlaps`, () => {
      const layout = layoutTemplate(template, { x: 100, y: 50 });
      const all = [
        ...(layout.orchestrator ? [layout.orchestrator] : []),
        ...layout.teams.flatMap((t) => t.consoles),
      ];
      expect(all.length).toBe(template.teams.reduce((n, t) => n + t.count, 0) + (template.orchestrator ? 1 : 0));
      for (let i = 0; i < all.length; i++) {
        expect(all[i].width).toBe(DEFAULT_SIZE.width);
        for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
      }
      const frames = layout.teams.map((t) => t.frame);
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) expect(overlaps(frames[i], frames[j])).toBe(false);
        if (layout.orchestrator) expect(overlaps(frames[i], layout.orchestrator)).toBe(false);
      }
      for (const team of layout.teams) {
        for (const c of team.consoles) expect(inside(c, team.frame)).toBe(true);
      }
    });
  }

  it('centers the orchestrator above the teams and uses a 2-column grid', () => {
    const hq = BUILTIN_TEMPLATES.find((t) => t.id === 'dev-hq')!;
    const layout = layoutTemplate(hq, { x: 0, y: 0 });
    const o = layout.orchestrator!;
    expect(o.y).toBe(0);
    const left = Math.min(...layout.teams.map((t) => t.frame.x));
    const right = Math.max(...layout.teams.map((t) => t.frame.x + t.frame.width));
    expect(Math.abs(o.x + o.width / 2 - (left + right) / 2)).toBeLessThanOrEqual(1);
    for (const t of layout.teams) expect(t.frame.y).toBeGreaterThan(o.y + o.height);
    const [a, b, c] = layout.teams[0].consoles;
    expect(a.y).toBe(b.y);
    expect(c.x).toBe(a.x);
    expect(a.x).toBe(layout.teams[0].frame.x + FRAME_PADDING);
    expect(a.y).toBe(layout.teams[0].frame.y + FRAME_TITLE_HEIGHT + FRAME_PADDING);
  });
});
