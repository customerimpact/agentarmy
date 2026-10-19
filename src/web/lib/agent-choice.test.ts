import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../../shared/templates';
import {
  CHOICE_KEY_PREFIX,
  agentMix,
  applyAllRows,
  buildTemplateLaunch,
  cleanComposerRow,
  defaultChoice,
  loadChoice,
  parseChoice,
  rowsRunOn,
  runOnLabelKind,
  saveChoice,
  type RunChoice,
} from './agent-choice';
import { normalizeProviders, readinessOf } from './provider-readiness';
import { stepAfterResponse } from './switch-agent';

const hq = BUILTIN_TEMPLATES.find((t) => t.id === 'dev-hq')!;
const trio = BUILTIN_TEMPLATES.find((t) => t.id === 'full-stack-trio')!;
const base = { cwd: '/work', projectName: 'P' };

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('buildTemplateLaunch', () => {
  it('default (Claude) sends nothing new, so older servers behave as before', () => {
    expect(buildTemplateLaunch(hq, defaultChoice(), base)).toEqual(base);
  });

  it('"Run on Codex" puts every team and the orchestrator on Codex, with the Codex model', () => {
    const choice: RunChoice = { ...defaultChoice(), runOn: 'codex', models: { codex: ' gpt-5-codex ', claude: 'opus' } };
    const req = buildTemplateLaunch(hq, choice, base);
    expect(req.teamAgents).toEqual(['codex', 'codex', 'codex']);
    expect(req.orchestratorAgent).toBe('codex');
    expect(req.teamModels).toEqual(['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex']);
    expect(req.orchestratorModel).toBe('gpt-5-codex');
    expect(req.agentAccounts).toBeUndefined();
  });

  it('Mixed uses the per-team CLIs and the orchestrator pick; accounts only for used providers', () => {
    const choice: RunChoice = {
      runOn: 'mixed',
      teamAgents: ['claude', 'gemini'], // third team missing -> claude
      orchestratorAgent: 'codex',
      models: { gemini: 'gemini-2.5-pro' },
      accounts: { gemini: 'g2', codex: 'auto', opencode: 'unused' },
    };
    const req = buildTemplateLaunch(hq, choice, base);
    expect(req.teamAgents).toEqual(['claude', 'gemini', 'claude']);
    expect(req.orchestratorAgent).toBe('codex');
    expect(req.teamModels).toEqual(['', 'gemini-2.5-pro', '']);
    expect(req.orchestratorModel).toBeUndefined();
    expect(req.agentAccounts).toEqual({ gemini: 'g2' });
  });

  it('templates without an orchestrator never send one', () => {
    const req = buildTemplateLaunch(trio, { ...defaultChoice(), runOn: 'gemini' }, base);
    expect(req.orchestratorAgent).toBeUndefined();
    expect(req.teamAgents).toEqual(['gemini', 'gemini', 'gemini']);
  });

  it('agent mix and card label', () => {
    expect(agentMix(hq, defaultChoice())).toEqual([{ agent: 'claude', count: 13 }]);
    const mixed: RunChoice = { ...defaultChoice(), runOn: 'mixed', teamAgents: ['codex', 'codex', 'codex'], orchestratorAgent: 'claude' };
    expect(agentMix(hq, mixed)).toEqual([
      { agent: 'claude', count: 1 },
      { agent: 'codex', count: 12 },
    ]);
    expect(runOnLabelKind(hq, mixed)).toBe('mixed');
    expect(runOnLabelKind(hq, { ...mixed, orchestratorAgent: 'codex' })).toBe('codex');
  });
});

describe('remembered choice per template', () => {
  it('round-trips through storage, per template id', () => {
    const storage = memoryStorage();
    const choice: RunChoice = { ...defaultChoice(), runOn: 'codex', models: { codex: 'gpt-5' } };
    saveChoice('dev-hq', choice, storage);
    expect(storage.data.has(`${CHOICE_KEY_PREFIX}dev-hq`)).toBe(true);
    expect(loadChoice('dev-hq', storage)).toEqual(choice);
    expect(loadChoice('bug-squad', storage)).toBeNull();
  });

  it('drops garbage and unknown agents', () => {
    const storage = memoryStorage();
    storage.setItem(`${CHOICE_KEY_PREFIX}x`, '{not json');
    expect(loadChoice('x', storage)).toBeNull();
    expect(parseChoice({ runOn: 'custom' })).toBeNull();
    expect(parseChoice({ runOn: 'mixed', teamAgents: ['codex', 'nope', 'custom'], orchestratorAgent: 'bad', models: { codex: 'm', zzz: 'x' } })).toEqual({
      runOn: 'mixed',
      teamAgents: ['codex', 'claude', 'claude'],
      orchestratorAgent: 'claude',
      models: { codex: 'm' },
      accounts: {},
    });
  });

  it('works without storage (private mode)', () => {
    expect(loadChoice('dev-hq', null)).toBeNull();
    expect(() => saveChoice('dev-hq', defaultChoice(), null)).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadChoice('dev-hq', throwing)).toBeNull();
    expect(() => saveChoice('dev-hq', defaultChoice(), throwing)).not.toThrow();
  });
});

describe('composer rows', () => {
  it('"All rows on" sets every agent and resets models; rowsRunOn reads the common CLI', () => {
    const rows = [{ agent: 'claude' as const, model: 'opus' }, { agent: 'gemini' as const }];
    expect(rowsRunOn(rows)).toBe('mixed');
    const all = applyAllRows(rows, 'codex', '');
    expect(all.map((r) => [r.agent, r.model])).toEqual([
      ['codex', ''],
      ['codex', ''],
    ]);
    expect(rowsRunOn(all)).toBe('codex');
    expect(rowsRunOn([{}, { agent: 'claude' }])).toBe('claude');
  });

  it('cleanComposerRow drops claude and empty models', () => {
    expect(cleanComposerRow({ role: 'Tests', agent: 'claude', model: ' ' })).toEqual({ role: 'Tests' });
    expect(cleanComposerRow({ role: 'Tests', agent: 'codex', model: ' gpt-5 ' })).toEqual({ role: 'Tests', agent: 'codex', model: 'gpt-5' });
  });
});

describe('providers readiness', () => {
  it('normalizes /api/providers and derives readiness', () => {
    const list = normalizeProviders({
      providers: [
        { id: 'claude', label: 'Claude Code', installed: true, loggedIn: true, accounts: [{ id: 'default', name: 'Me', loggedIn: true }] },
        { id: 'codex', installed: true, loggedIn: false, accounts: [] },
        { id: 'gemini', installed: false, loggedIn: false, accounts: [] },
        { id: 'nope', installed: true },
      ],
    });
    expect(list.map((p) => p.id)).toEqual(['claude', 'codex', 'gemini']);
    expect(list[0].accounts).toEqual([{ id: 'default', name: 'Me', status: 'ok' }]);
    expect(list.map((p) => readinessOf(p, p.id))).toEqual(['ready', 'logged_out', 'not_installed']);
    expect(readinessOf(undefined, 'claude')).toBe('ready');
    expect(readinessOf(undefined, 'codex')).toBe('checking');
  });
});

describe('switch progress', () => {
  it('starting -> sending -> done', () => {
    expect(stepAfterResponse(undefined, undefined, false, true)).toBe('starting');
    expect(stepAfterResponse({ status: 'starting' }, { status: 'sent' }, false, true)).toBe('starting');
    expect(stepAfterResponse({ status: 'idle' }, { status: 'sent' }, false, true)).toBe('sending');
    expect(stepAfterResponse({ status: 'working' }, { status: 'working' }, false, true)).toBe('done');
    expect(stepAfterResponse({ status: 'idle' }, { status: 'sent' }, true, true)).toBe('done');
    expect(stepAfterResponse({ status: 'exited' }, { status: 'sent' }, false, false)).toBe('error');
  });
});
