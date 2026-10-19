import { useEffect } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { AGENT_KINDS, AGENT_META, CUSTOM_COMMAND_PRESETS, type AgentKind } from '../../shared/agents';
import { detectionFor, useAgents } from '../lib/agents';
import { AgentIcon } from './AgentIcon';

// Which CLI a new console runs: Claude Code (default), Codex, Gemini CLI, OpenCode or any command.
// CLIs that are not on PATH stay pickable but show how to install them, and the dialog won't launch.
export function useAgentReady(agent: AgentKind, command: string): { ready: boolean; reason?: string } {
  const agents = useAgents((s) => s.agents);
  if (agent === 'custom') return command.trim() ? { ready: true } : { ready: false, reason: 'Type a command' };
  const found = detectionFor(agents, agent);
  // Claude is assumed present until detection says otherwise (keeps the old flow instant)
  if (!found) return agent === 'claude' ? { ready: true } : { ready: false, reason: 'Checking…' };
  return found.installed ? { ready: true } : { ready: false, reason: `${AGENT_META[agent].label} is not installed` };
}

export function AgentPicker({
  value,
  onChange,
  command,
  onCommandChange,
  onSubmit,
}: {
  value: AgentKind;
  onChange: (agent: AgentKind) => void;
  command: string;
  onCommandChange: (command: string) => void;
  onSubmit?: () => void;
}) {
  const agents = useAgents((s) => s.agents);
  const loading = useAgents((s) => s.loading);
  useEffect(() => {
    void useAgents.getState().load();
  }, []);
  const selected = detectionFor(agents, value);
  const meta = AGENT_META[value];
  const missing = value !== 'custom' && selected && !selected.installed;

  return (
    <div className="border-b border-line px-5 py-2.5" data-testid="agent-picker">
      <div className="flex items-center gap-2">
        <span className="aa-label shrink-0 text-fg-subtle">Agent</span>
        <div role="radiogroup" aria-label="Agent" className="flex min-w-0 flex-wrap gap-1">
          {AGENT_KINDS.map((id) => {
            const found = detectionFor(agents, id);
            const notInstalled = id !== 'custom' && found && !found.installed;
            const active = id === value;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`agent-option-${id}`}
                data-installed={notInstalled ? 'false' : 'true'}
                title={found?.version ?? (notInstalled ? 'Not installed' : AGENT_META[id].label)}
                onClick={() => onChange(id)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors
                            ${active ? 'bg-accent/15 text-fg ring-1 ring-accent/40' : 'text-fg-muted ring-1 ring-line hover:bg-hover hover:text-fg'}
                            ${notInstalled && !active ? 'opacity-55' : ''}`}
              >
                <AgentIcon agent={id} size={12} />
                {AGENT_META[id].label}
                {notInstalled && <span className="text-[10px] font-normal text-fg-subtle">not installed</span>}
              </button>
            );
          })}
          {loading && !agents && <LoaderCircle size={13} className="mt-1.5 animate-spin text-fg-subtle" />}
        </div>
      </div>

      {value === 'custom' && (
        <div className="mt-2">
          <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent">
            <AgentIcon agent="custom" size={13} className="shrink-0 text-accent" />
            <input
              data-testid="custom-command"
              value={command}
              onChange={(e) => onCommandChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmit?.();
              }}
              placeholder="npm run dev"
              spellCheck={false}
              maxLength={2000}
              className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {CUSTOM_COMMAND_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                data-testid="custom-command-preset"
                onClick={() => onCommandChange(preset)}
                className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted ring-1 ring-line hover:text-fg"
              >
                {preset}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] text-fg-subtle">
            Runs in the folder below with your shell ({selected?.path ?? 'cmd.exe / $SHELL'}). Status follows its output: working
            while it prints, resting when quiet. Restart runs the command again.
          </p>
        </div>
      )}

      {missing && (
        <div data-testid="agent-install-hint" className="mt-2 rounded-lg border border-needs/30 bg-needs/10 px-3 py-2 text-[12px] text-fg">
          <div className="font-medium">{meta.label} was not found on PATH.</div>
          {meta.installCommand && (
            <div className="mt-1">
              Install it with <code className="rounded bg-surface px-1 font-mono text-[11.5px]">{meta.installCommand}</code>, or set its path in
              Settings › Agents.
            </div>
          )}
          {meta.installUrl && (
            <a
              href={meta.installUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-accent hover:underline"
            >
              Install guide <ExternalLink size={11} />
            </a>
          )}
          <button type="button" onClick={() => void useAgents.getState().load(true)} className="ml-3 text-fg-muted hover:text-fg">
            Check again
          </button>
        </div>
      )}

      {value !== 'custom' && value !== 'claude' && selected?.installed && (
        <p className="mt-1.5 text-[11.5px] text-fg-subtle" data-testid="agent-capabilities">
          {selected.version ? `${selected.version} · ` : ''}
          {selected.supportsResume ? 'restart resumes the conversation' : 'restart starts a new conversation'} ·{' '}
          {selected.supportsHooks ? 'status from its notifications and output' : 'status from its terminal output'}
          {selected.supportsMcp ? ' · agentarmy tools' : ''}
        </p>
      )}
    </div>
  );
}

// Templates: which CLI each team runs (custom commands need a command line, so they are not offered).
// The orchestrator always runs Claude Code: it coordinates the board with the agentarmy MCP tools.
const TEAM_AGENTS: AgentKind[] = ['claude', 'codex', 'gemini', 'opencode'];

export function TeamAgentsPicker({
  teams,
  value,
  onChange,
}: {
  teams: { name: string }[];
  value: AgentKind[];
  onChange: (value: AgentKind[]) => void;
}) {
  const agents = useAgents((s) => s.agents);
  useEffect(() => {
    void useAgents.getState().load();
  }, []);
  if (!teams.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-5 py-2" data-testid="team-agents">
      <span className="aa-label text-fg-subtle">Agents</span>
      {teams.map((team, i) => (
        <label key={`${team.name}-${i}`} className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted">
          {team.name}
          <select
            data-testid="team-agent-select"
            value={value[i] ?? 'claude'}
            onChange={(e) => {
              const next = teams.map((_, j) => value[j] ?? 'claude');
              next[i] = e.target.value as AgentKind;
              onChange(next);
            }}
            className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-accent"
          >
            {TEAM_AGENTS.map((id) => {
              const found = detectionFor(agents, id);
              const missing = found && !found.installed;
              return (
                <option key={id} value={id} disabled={!!missing}>
                  {AGENT_META[id].label}
                  {missing ? ' (not installed)' : ''}
                </option>
              );
            })}
          </select>
        </label>
      ))}
    </div>
  );
}

// Composer: the CLI for one row (same choices as TeamAgentsPicker)
export function RowAgentSelect({ value, onChange, className }: { value: AgentKind; onChange: (agent: AgentKind) => void; className?: string }) {
  const agents = useAgents((s) => s.agents);
  useEffect(() => {
    void useAgents.getState().load();
  }, []);
  return (
    <select data-testid="composer-agent" value={value} onChange={(e) => onChange(e.target.value as AgentKind)} className={className} title="Agent CLI">
      {TEAM_AGENTS.map((id) => {
        const missing = detectionFor(agents, id)?.installed === false;
        return (
          <option key={id} value={id} disabled={missing}>
            {AGENT_META[id].label}
            {missing ? ' (not installed)' : ''}
          </option>
        );
      })}
    </select>
  );
}
