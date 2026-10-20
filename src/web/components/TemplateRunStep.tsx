import type { MouseEvent } from 'react';
import { AlertTriangle, Crown, Rocket } from 'lucide-react';
import type { AgentKind } from '../../shared/agents';
import type { Template } from '../../shared/protocol';
import { agentMix, resolveAgents, runOnLabelKind, usedAgents, type RunChoice, type RunOn } from '../lib/agent-choice';
import { isOrchestratorReady, providerKinds, providerShort, readinessOf, type ProviderKind } from '../lib/provider-readiness';
import { useProviders } from '../lib/provider-store';
import { AgentIcon } from './AgentIcon';
import { ModelField, ProviderAccountSelect, ProviderSelect, ReadinessWarning, RunOnControl } from './ProviderPicker';

// Templates launch step: "Run this team on: Claude Code · Codex · … · Mixed", per-provider model and
// account, and (Mixed) a CLI per team plus one for the orchestrator.

export function TemplateRunStep({
  template,
  choice,
  onChange,
}: {
  template: Template;
  choice: RunChoice;
  onChange: (choice: RunChoice) => void;
}) {
  const used = usedAgents(template, choice);
  const { teams, orchestrator } = resolveAgents(template, choice);

  const pickRunOn = (runOn: RunOn) => {
    if (runOn === 'mixed') {
      // Start Mixed from what is on screen, so switching to it changes nothing until a team is edited
      onChange({ ...choice, runOn, teamAgents: teams, orchestratorAgent: orchestrator ?? 'claude' });
    } else onChange({ ...choice, runOn });
  };
  const setTeam = (i: number, agent: AgentKind) => {
    const next = template.teams.map((_, j) => choice.teamAgents[j] ?? 'claude');
    next[i] = agent;
    onChange({ ...choice, teamAgents: next });
  };

  return (
    <div data-testid="template-run-step" className="border-b border-line bg-surface-2/60 px-5 py-3">
      <RunOnControl value={choice.runOn} onChange={pickRunOn} label="Run this team on" testId="template-run-on" />

      {choice.runOn === 'mixed' && (
        <div data-testid="team-agents" className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {template.orchestrator && (
            <label className="flex min-w-0 items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-[12px] text-fg-muted">
              <Crown size={12} className="shrink-0 text-accent" />
              <span className="w-24 shrink-0 truncate font-medium text-fg">Orchestrator</span>
              <ProviderSelect
                testId="orchestrator-agent-select"
                value={choice.orchestratorAgent}
                onChange={(orchestratorAgent) => onChange({ ...choice, orchestratorAgent })}
                className="min-w-0 flex-1"
              />
            </label>
          )}
          {template.teams.map((team, i) => (
            <label key={`${team.name}-${i}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-fg-muted">
              <AgentIcon agent={teams[i]} size={12} className="shrink-0" />
              <span className="w-24 shrink-0 truncate font-medium text-fg">
                {team.name} <span className="font-normal text-fg-subtle">· {team.count}</span>
              </span>
              <ProviderSelect testId="team-agent-select" value={teams[i]} onChange={(a) => setTeam(i, a)} className="min-w-0 flex-1" />
            </label>
          ))}
        </div>
      )}

      {orchestrator && !isOrchestratorReady(orchestrator) && (
        <p data-testid="orchestrator-limited" className="mt-2 flex items-start gap-1.5 text-[11.5px] text-needs">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          The orchestrator on {providerShort(orchestrator)}: jobs need the agentarmy MCP tools, which are verified on Claude Code and Codex. Coordination
          may be limited.
        </p>
      )}

      <div className="mt-2.5 flex flex-col gap-1.5" data-testid="template-provider-options">
        {used.map((kind) => (
          <div key={kind} data-testid="provider-options" data-agent={kind} className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-fg-muted">
            <span className="inline-flex w-28 shrink-0 items-center gap-1.5 font-medium text-fg">
              <AgentIcon agent={kind} size={12} className="text-accent" />
              {providerShort(kind)}
            </span>
            <ModelField
              kind={kind}
              value={choice.models[kind] ?? ''}
              onChange={(m) => onChange({ ...choice, models: { ...choice.models, [kind]: m } })}
              className="w-52"
              testId={`template-model-${kind}`}
            />
            <ProviderAccountSelect
              kind={kind}
              value={choice.accounts[kind] ?? 'auto'}
              onChange={(a) => onChange({ ...choice, accounts: { ...choice.accounts, [kind]: a } })}
              testId={`template-account-${kind}`}
            />
            <ReadinessWarning kind={kind} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Which CLIs a launch would use are all installed (logged-out ones are allowed but flagged)
export function useLaunchBlocked(template: Template | null, choice: RunChoice): string | null {
  const providers = useProviders((s) => s.providers);
  if (!template) return null;
  for (const kind of usedAgents(template, choice)) {
    if (readinessOf(providers?.find((p) => p.id === kind), kind) === 'not_installed') return `${providerShort(kind)} is not installed`;
  }
  return null;
}

// Gallery card: icons of the agent mix + "Runs on: …", and the hover shortcut "Launch on Codex…"
export function TemplateCardAgents({ template, choice }: { template: Template; choice: RunChoice }) {
  const mix = agentMix(template, choice);
  const label = runOnLabelKind(template, choice);
  return (
    <div data-testid="template-card-agents" data-runs-on={label} className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-muted">
      <span className="inline-flex shrink-0 items-center -space-x-0.5">
        {mix.map(({ agent, count }) => (
          <span
            key={agent}
            title={`${count} on ${providerShort(agent)}`}
            className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-[1px] ring-1 ring-line"
          >
            <AgentIcon agent={agent} size={10} className="text-accent" />
            <span className="font-medium tabular-nums">{count}</span>
          </span>
        ))}
      </span>
      <span className="truncate">
        Runs on: <span className="font-medium text-fg">{label === 'mixed' ? 'Mixed' : providerShort(label)}</span>
      </span>
    </div>
  );
}

// The alternative offered on hover: Codex (or the first other ready CLI) for Claude teams, else Claude
export function useAlternativeProvider(current: RunOn): ProviderKind {
  const providers = useProviders((s) => s.providers);
  if (current !== 'claude') return 'claude';
  const ready = providerKinds().filter((k) => k !== 'claude' && readinessOf(providers?.find((p) => p.id === k), k) === 'ready');
  return ready.includes('codex') ? 'codex' : (ready[0] ?? 'codex');
}

export function LaunchOnButton({ current, onPick }: { current: RunOn; onPick: (kind: ProviderKind) => void }) {
  const kind = useAlternativeProvider(current);
  const onClick = () => onPick(kind);
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid="template-launch-on"
      data-agent={kind}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full border border-line-strong bg-elevated/95 px-2 py-0.5 text-[11.5px] font-medium text-fg
                 opacity-0 shadow-lg backdrop-blur transition-opacity
                 group-hover:opacity-100 hover:border-accent/60 hover:text-accent focus-visible:opacity-100"
    >
      <Rocket size={11} />
      Launch on {providerShort(kind)}…
    </span>
  );
}
