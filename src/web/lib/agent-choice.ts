import { isAgentKind, type AgentKind } from '../../shared/agents';
import type { ComposerRow, LaunchTemplateRequest, Template } from '../../shared/protocol';

// "Run this team on: Claude Code · Codex · … · Mixed" for templates (and "All rows on" in the Composer):
// the choice, how it turns into a launch request, and the per-template memory in localStorage.

export type RunOn = AgentKind | 'mixed';

export interface RunChoice {
  runOn: RunOn;
  teamAgents: AgentKind[]; // Mixed: one per team (same order as Template.teams)
  orchestratorAgent: AgentKind; // Mixed: the orchestrator's CLI
  models: Partial<Record<AgentKind, string>>; // '' / missing = the CLI's own default
  accounts: Partial<Record<AgentKind, string>>; // 'auto' / missing = let the server pick
}

export const DEFAULT_RUN: RunChoice = { runOn: 'claude', teamAgents: [], orchestratorAgent: 'claude', models: {}, accounts: {} };

const teamKind = (value: unknown): AgentKind => (isAgentKind(value) && value !== 'custom' ? value : 'claude');

export function defaultChoice(): RunChoice {
  return { ...DEFAULT_RUN, teamAgents: [], models: {}, accounts: {} };
}

// The CLI each team and the orchestrator ends up on
export function resolveAgents(
  template: Pick<Template, 'orchestrator' | 'teams'>,
  choice: RunChoice,
): { teams: AgentKind[]; orchestrator: AgentKind | null } {
  if (choice.runOn !== 'mixed') {
    const kind = teamKind(choice.runOn);
    return { teams: template.teams.map(() => kind), orchestrator: template.orchestrator ? kind : null };
  }
  return {
    teams: template.teams.map((_, i) => teamKind(choice.teamAgents[i])),
    orchestrator: template.orchestrator ? teamKind(choice.orchestratorAgent) : null,
  };
}

// Providers the launch uses, in first-use order (for model/account pickers and readiness checks)
export function usedAgents(template: Pick<Template, 'orchestrator' | 'teams'>, choice: RunChoice): AgentKind[] {
  const { teams, orchestrator } = resolveAgents(template, choice);
  return [...new Set([...(orchestrator ? [orchestrator] : []), ...teams])];
}

// Agent mix for the gallery card badges: [{ agent, count }] in first-use order
export function agentMix(template: Pick<Template, 'orchestrator' | 'teams'>, choice: RunChoice): { agent: AgentKind; count: number }[] {
  const { teams, orchestrator } = resolveAgents(template, choice);
  const counts = new Map<AgentKind, number>();
  if (orchestrator) counts.set(orchestrator, 1);
  template.teams.forEach((team, i) => counts.set(teams[i], (counts.get(teams[i]) ?? 0) + team.count));
  return [...counts.entries()].map(([agent, count]) => ({ agent, count }));
}

const cleanModel = (m: string | undefined): string => (m ?? '').trim();

// Only fields that differ from the old defaults are sent, so older servers behave as before
export function buildTemplateLaunch(
  template: Pick<Template, 'orchestrator' | 'teams'>,
  choice: RunChoice,
  base: LaunchTemplateRequest,
): LaunchTemplateRequest {
  const { teams, orchestrator } = resolveAgents(template, choice);
  const req: LaunchTemplateRequest = { ...base };
  if (teams.some((a) => a !== 'claude')) req.teamAgents = teams;
  if (orchestrator && orchestrator !== 'claude') req.orchestratorAgent = orchestrator;
  const teamModels = teams.map((a) => cleanModel(choice.models[a]));
  if (teamModels.some(Boolean)) req.teamModels = teamModels;
  const orchestratorModel = orchestrator ? cleanModel(choice.models[orchestrator]) : '';
  if (orchestratorModel) req.orchestratorModel = orchestratorModel;
  const used = new Set<AgentKind>([...teams, ...(orchestrator ? [orchestrator] : [])]);
  const accounts: Partial<Record<AgentKind, string>> = {};
  for (const kind of used) {
    const id = choice.accounts[kind];
    if (id && id !== 'auto') accounts[kind] = id;
  }
  if (Object.keys(accounts).length) req.agentAccounts = accounts;
  return req;
}

// Composer: "All rows on: X" sets every row's agent; per-row edits keep working afterwards
export function applyAllRows<T extends ComposerRow>(rows: T[], agent: AgentKind, model?: string): T[] {
  const kind = teamKind(agent);
  return rows.map((r) => ({ ...r, agent: kind, ...(model !== undefined ? { model } : {}) }));
}

// The common agent of all rows, or 'mixed'
export function rowsRunOn(rows: Pick<ComposerRow, 'agent'>[]): RunOn {
  const kinds = new Set(rows.map((r) => teamKind(r.agent)));
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

export function cleanComposerRow(row: ComposerRow): ComposerRow {
  const kind = teamKind(row.agent);
  const model = cleanModel(row.model);
  const { agent: _agent, model: _model, ...rest } = row;
  return { ...rest, ...(kind !== 'claude' ? { agent: kind } : {}), ...(model ? { model } : {}) };
}

// ---------- Remembered choice per template (localStorage, per browser) ----------

export const CHOICE_KEY_PREFIX = 'agentarmy.templateRun.';

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function cleanMap(raw: unknown): Partial<Record<AgentKind, string>> {
  const out: Partial<Record<AgentKind, string>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAgentKind(k) && k !== 'custom' && typeof v === 'string' && v.length <= 200) out[k] = v;
  }
  return out;
}

export function parseChoice(raw: unknown): RunChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const runOn = c.runOn === 'mixed' ? 'mixed' : isAgentKind(c.runOn) && c.runOn !== 'custom' ? c.runOn : null;
  if (!runOn) return null;
  return {
    runOn,
    teamAgents: Array.isArray(c.teamAgents) ? c.teamAgents.map(teamKind) : [],
    orchestratorAgent: teamKind(c.orchestratorAgent),
    models: cleanMap(c.models),
    accounts: cleanMap(c.accounts),
  };
}

export function loadChoice(templateId: string, storage: KV | null = defaultStorage()): RunChoice | null {
  try {
    const text = storage?.getItem(CHOICE_KEY_PREFIX + templateId);
    return text ? parseChoice(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function saveChoice(templateId: string, choice: RunChoice, storage: KV | null = defaultStorage()): void {
  try {
    storage?.setItem(CHOICE_KEY_PREFIX + templateId, JSON.stringify(choice));
  } catch {
    // convenience only
  }
}

// Mixed with every team on the same CLI reads as that CLI (keeps the card label short)
export function runOnLabelKind(template: Pick<Template, 'orchestrator' | 'teams'>, choice: RunChoice): RunOn {
  const used = usedAgents(template, choice);
  return used.length === 1 ? used[0] : 'mixed';
}
