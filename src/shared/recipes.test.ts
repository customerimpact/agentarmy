import { describe, expect, it } from 'vitest';
import {
  appRecipeLink,
  badgeMarkdown,
  decodeRecipe,
  encodeRecipe,
  localRecipeLink,
  recipeFromTemplate,
  recipeLink,
  type Recipe,
} from './recipes';
import type { Template } from './protocol';

const recipe: Recipe = {
  name: 'Ship it — v2 🚀',
  description: 'Builder + reviewer',
  rows: [
    { role: 'Builder', prompt: 'You are {name}. Build the feature.', agent: 'codex', model: 'gpt-5' },
    { name: 'Rex', role: 'Reviewer', prompt: 'Review "git diff".', worktree: true },
  ],
};

describe('recipe codes', () => {
  it('round-trips through a URL-safe code, including non-ASCII text', () => {
    const code = encodeRecipe(recipe);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRecipe(code)).toEqual(recipe);
  });

  it('reads a share link, an app link, a local link or plain JSON', () => {
    const code = encodeRecipe(recipe);
    expect(decodeRecipe(recipeLink(recipe))).toEqual(recipe);
    expect(decodeRecipe(appRecipeLink(code))).toEqual(recipe);
    expect(decodeRecipe(localRecipeLink(code, 4317))).toEqual(recipe);
    expect(decodeRecipe(`  ${JSON.stringify({ v: 1, n: 'Solo', r: [{ ro: 'General' }] })}\n`)).toEqual({
      name: 'Solo',
      rows: [{ role: 'General' }],
    });
  });

  it('makes the expected links', () => {
    const code = encodeRecipe(recipe);
    expect(recipeLink(recipe)).toBe(`https://gridhive.dev/r#${code}`);
    expect(appRecipeLink(code)).toBe(`gridhive://recipe?d=${code}`);
    expect(localRecipeLink(code, 4317)).toBe(`http://127.0.0.1:4317/#recipe=${code}`);
    expect(badgeMarkdown(recipe)).toBe(
      `[![Run in GridHive](https://gridhive.dev/assets/run-in-gridhive.svg)](https://gridhive.dev/r#${code})`,
    );
  });

  it('rejects broken or hostile input with a readable error', () => {
    expect(() => decodeRecipe('')).toThrow(/Paste a recipe link/);
    expect(() => decodeRecipe('not a recipe!!')).toThrow(/not a GridHive recipe/);
    expect(() => decodeRecipe(JSON.stringify({ v: 2, n: 'x', r: [{}] }))).toThrow(/newer GridHive/);
    expect(() => decodeRecipe(JSON.stringify({ v: 1, n: 'x', r: [] }))).toThrow(/at least one agent/);
    const many = Array.from({ length: 13 }, () => ({ ro: 'General' }));
    expect(() => decodeRecipe(JSON.stringify({ v: 1, n: 'x', r: many }))).toThrow(/At most 12/);
    expect(() => decodeRecipe(JSON.stringify({ v: 1, n: 'x', r: [{ p: 7 }] }))).toThrow(/prompt/);
  });

  it('drops unknown agents and fields, and trims long text', () => {
    const raw = { v: 1, n: ' Big ', r: [{ a: 'evil', ro: 'R'.repeat(99), x: 1, accountId: 'acc-1' }] };
    expect(decodeRecipe(JSON.stringify(raw))).toEqual({ name: 'Big', rows: [{ role: 'R'.repeat(40) }] });
  });
});

describe('recipeFromTemplate', () => {
  it('keeps the team but not personal accounts', () => {
    const template: Template = {
      id: 'custom-1',
      name: 'Duo',
      description: '2 agents',
      orchestrator: false,
      teams: [],
      custom: true,
      rows: [{ role: 'Builder', accountId: 'work', agent: 'gemini' }, { role: 'Reviewer' }],
    };
    expect(recipeFromTemplate(template)).toEqual({
      name: 'Duo',
      description: '2 agents',
      rows: [{ role: 'Builder', agent: 'gemini' }, { role: 'Reviewer' }],
    });
  });

  it('turns a built-in template into one row per console', () => {
    const template: Template = {
      id: 'solo',
      name: 'Solo',
      description: 'one',
      orchestrator: false,
      teams: [{ name: 'Builder', role: 'Builder', count: 2, prompt: 'Go' }],
    };
    expect(recipeFromTemplate(template).rows).toEqual([
      { role: 'Builder', prompt: 'Go' },
      { role: 'Builder', prompt: 'Go' },
    ]);
  });
});
