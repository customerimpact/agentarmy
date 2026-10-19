import { useEffect } from 'react';
import { CheckCircle2, CircleSlash, RefreshCw } from 'lucide-react';
import { AGENT_KINDS, AGENT_META, PATH_OVERRIDE_AGENTS, type AgentKind } from '../../../shared/agents';
import { useAgents } from '../../lib/agents';
import { useServerSettings } from '../../lib/settings';
import { useBoard } from '../../lib/store';
import { AgentIcon } from '../AgentIcon';
import { Select, SmallButton, TextSave } from './fields';

// Settings > Agents: which CLIs are installed (path, version), path overrides, default agent.

const toast = (message: string) => useBoard.getState().toast(message);

export function DefaultAgentControl() {
  const value = useServerSettings((s) => s.data?.settings.defaultAgent);
  if (value === undefined) return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
  return (
    <Select
      label="Default agent"
      value={value}
      options={AGENT_KINDS.map((id) => ({ value: id, label: AGENT_META[id].label }))}
      onChange={(defaultAgent: AgentKind) =>
        void useServerSettings
          .getState()
          .patch({ defaultAgent })
          .then(() => toast(`New agents default to ${AGENT_META[defaultAgent].label}`))
          .catch((e: Error) => toast(`Could not save: ${e.message}`))
      }
    />
  );
}

export function AgentsDetectedBelow() {
  const agents = useAgents((s) => s.agents);
  const loading = useAgents((s) => s.loading);
  const paths = useServerSettings((s) => s.data?.settings.agentPaths);
  useEffect(() => {
    void useAgents.getState().load(true);
  }, []);

  const savePath = async (agent: (typeof PATH_OVERRIDE_AGENTS)[number], value: string) => {
    try {
      await useServerSettings.getState().patch({ agentPaths: { ...(paths ?? {}), [agent]: value } });
      toast(value ? `${AGENT_META[agent].label} path saved` : `${AGENT_META[agent].label} path cleared, using PATH`);
      await useAgents.getState().load(true);
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    }
  };

  return (
    <div className="mt-3 space-y-2" data-testid="agents-detected">
      <div className="flex justify-end">
        <SmallButton onClick={() => void useAgents.getState().load(true)} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Detect again
        </SmallButton>
      </div>
      {AGENT_KINDS.map((id) => {
        const found = agents?.find((a) => a.id === id);
        const meta = AGENT_META[id];
        return (
          <div
            key={id}
            data-testid="agent-row"
            data-agent={id}
            data-installed={found ? String(found.installed) : undefined}
            className="rounded-lg border border-line bg-surface px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <AgentIcon agent={id} size={14} className="text-accent" />
              <span className="font-medium text-fg">{meta.label}</span>
              {found &&
                (found.installed ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-resting">
                    <CheckCircle2 size={12} /> {id === 'custom' ? 'ready' : 'installed'}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle">
                    <CircleSlash size={12} /> not installed
                  </span>
                ))}
              {found?.version && <span className="font-mono text-[11px] text-fg-muted">{found.version}</span>}
              <span className="ml-auto text-[11px] text-fg-subtle">
                {found && id !== 'custom'
                  ? [found.supportsResume ? 'resume' : 'no resume', found.supportsHooks ? 'events' : 'output status', found.supportsMcp ? 'MCP' : null]
                      .filter(Boolean)
                      .join(' · ')
                  : null}
              </span>
            </div>
            {found?.path && <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle" title={found.path}>{found.path}</div>}
            {found && !found.installed && meta.installCommand && (
              <div className="mt-1 text-[11.5px] text-fg-muted">
                Install: <code className="font-mono">{meta.installCommand}</code>
                {meta.installUrl && (
                  <a href={meta.installUrl} target="_blank" rel="noreferrer" className="ml-2 text-accent hover:underline">
                    guide
                  </a>
                )}
              </div>
            )}
            {found?.notes && <div className="mt-0.5 text-[11.5px] text-fg-subtle">{found.notes}</div>}
            {id === 'claude' && <div className="mt-0.5 text-[11.5px] text-fg-subtle">Path and flags: Settings › Claude Code.</div>}
            {(PATH_OVERRIDE_AGENTS as AgentKind[]).includes(id) && paths && (
              <div className="mt-1.5">
                <TextSave
                  label={`${meta.label} path`}
                  value={paths[id as (typeof PATH_OVERRIDE_AGENTS)[number]] ?? ''}
                  placeholder={`Auto-detect (${id} on PATH)`}
                  onSave={(v) => savePath(id as (typeof PATH_OVERRIDE_AGENTS)[number], v)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
