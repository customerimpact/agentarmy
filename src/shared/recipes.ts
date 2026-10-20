import { isAgentKind, type AgentKind } from './agents.js';
import { MAX_COMPOSER_ROWS, type ComposerRow, type Template } from './protocol.js';

// Recipes: a team (roles, prompts, agents, models) packed into a link so people can share it.
// The code sits after "#" in https://gridhive.dev/r#<code>, so it never reaches a server.
// Accounts are personal and never go into a recipe. Importing only saves a custom template;
// nothing launches until the user presses Launch.

export const SITE_URL = 'https://gridhive.dev';
export const RECIPE_SCHEME = 'gridhive';
const VERSION = 1;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_ROW_NAME = 40;
const MAX_ROLE = 40;
const MAX_PROMPT = 8000;
const MAX_MODEL = 200;

export interface RecipeRow {
  name?: string;
  role?: string;
  prompt?: string;
  agent?: Exclude<AgentKind, 'claude' | 'custom'>; // missing = Claude Code
  model?: string;
  worktree?: boolean;
}

export interface Recipe {
  name: string;
  description?: string;
  rows: RecipeRow[];
}

// Short keys keep links small: n name, d description, r rows; ro role, p prompt, a agent, m model, w worktree
interface Packed {
  v: number;
  n: string;
  d?: string;
  r: { n?: string; ro?: string; p?: string; a?: string; m?: string; w?: 1 }[];
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const binary = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeRecipe(recipe: Recipe): string {
  const packed: Packed = {
    v: VERSION,
    n: recipe.name,
    ...(recipe.description ? { d: recipe.description } : {}),
    r: recipe.rows.map((row) => ({
      ...(row.name ? { n: row.name } : {}),
      ...(row.role ? { ro: row.role } : {}),
      ...(row.prompt ? { p: row.prompt } : {}),
      ...(row.agent ? { a: row.agent } : {}),
      ...(row.model ? { m: row.model } : {}),
      ...(row.worktree ? { w: 1 as const } : {}),
    })),
  };
  return toBase64Url(JSON.stringify(packed));
}

export function recipeLink(recipe: Recipe): string {
  return `${SITE_URL}/r#${encodeRecipe(recipe)}`;
}

export function appRecipeLink(code: string): string {
  return `${RECIPE_SCHEME}://recipe?d=${code}`;
}

// Opens the recipe in a running `npx gridhive` (the board's own cookie carries the token)
export function localRecipeLink(code: string, port: number): string {
  return `http://127.0.0.1:${port}/#recipe=${code}`;
}

export function badgeMarkdown(recipe: Recipe): string {
  return `[![Run in GridHive](${SITE_URL}/assets/run-in-gridhive.svg)](${recipeLink(recipe)})`;
}

function text(value: unknown, max: number, what: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`The recipe's ${what} must be text`);
  return value.trim().slice(0, max);
}

// The code from any of our link shapes, or the text itself
function extractCode(input: string): string {
  const match = /(?:#recipe=|[?&]d=|\/r#|^#)([A-Za-z0-9_-]+)/.exec(input);
  return match ? match[1] : input;
}

export function decodeRecipe(input: string): Recipe {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Paste a recipe link or code');
  let packed: Partial<Packed>;
  try {
    const json = trimmed.startsWith('{') ? trimmed : fromBase64Url(extractCode(trimmed));
    packed = JSON.parse(json) as Partial<Packed>;
  } catch {
    throw new Error('This is not a GridHive recipe link');
  }
  if (!packed || typeof packed !== 'object') throw new Error('This is not a GridHive recipe link');
  if (typeof packed.v === 'number' && packed.v > VERSION) {
    throw new Error('This recipe was made by a newer GridHive. Update the app to open it.');
  }
  const name = text(packed.n, MAX_NAME, 'name');
  if (!name) throw new Error('The recipe has no name');
  if (!Array.isArray(packed.r) || packed.r.length === 0) throw new Error('The recipe needs at least one agent');
  if (packed.r.length > MAX_COMPOSER_ROWS) throw new Error(`At most ${MAX_COMPOSER_ROWS} agents per recipe`);
  const rows = packed.r.map((raw): RecipeRow => {
    if (!raw || typeof raw !== 'object') throw new Error('The recipe has a broken agent');
    const rowName = text(raw.n, MAX_ROW_NAME, 'agent name');
    const role = text(raw.ro, MAX_ROLE, 'role');
    const prompt = text(raw.p, MAX_PROMPT, 'prompt');
    const model = text(raw.m, MAX_MODEL, 'model');
    const agent = isAgentKind(raw.a) && raw.a !== 'claude' && raw.a !== 'custom' ? raw.a : undefined;
    return {
      ...(rowName ? { name: rowName } : {}),
      ...(role ? { role } : {}),
      ...(prompt ? { prompt } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(raw.w ? { worktree: true } : {}),
    };
  });
  const description = text(packed.d, MAX_DESCRIPTION, 'description');
  return { name, ...(description ? { description } : {}), rows };
}

// Custom templates keep one row per console; built-in ones are expanded from their teams
export function recipeFromTemplate(template: Template): Recipe {
  const source: ComposerRow[] =
    template.rows ??
    template.teams.flatMap((team) =>
      Array.from({ length: team.count }, () => ({ role: team.role, ...(team.prompt ? { prompt: team.prompt } : {}) })),
    );
  const rows = source.map(({ accountId: _account, agent, ...rest }): RecipeRow => ({
    ...rest,
    ...(agent && agent !== 'claude' && agent !== 'custom' ? { agent } : {}),
  }));
  return { name: template.name, ...(template.description ? { description: template.description } : {}), rows };
}
