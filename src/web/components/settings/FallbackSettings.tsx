import { AlertTriangle, CheckCircle2, KeyRound } from 'lucide-react';
import { AGENT_META, type AgentKind } from '../../../shared/agents';
import type { LimitFallbackMode, ProviderKeyId } from '../../../shared/protocol';
import { useProviderHub } from '../../lib/providers-hub';
import { useServerSettings } from '../../lib/settings';
import { useBoard } from '../../lib/store';
import { Note, Segmented, Select, SmallButton, TextSave } from './fields';

// Two Agents & accounts pieces that belong to the cross-provider fallback (src/server/provider-fallback.ts):
// - "When every Claude account is limited": Ask / Continue on <CLI> / Wait, plus which CLI, with its readiness
// - the API key field of a provider card (Grok): stored server-side, only "set ••••last4" comes back

const toast = (message: string) => useBoard.getState().toast(message);

const FALLBACK_AGENTS: AgentKind[] = ['codex', 'gemini', 'opencode', 'grok'];

async function save(patch: Parameters<ReturnType<typeof useServerSettings.getState>['patch']>[0], ok: string): Promise<boolean> {
  try {
    await useServerSettings.getState().patch(patch);
    toast(ok);
    return true;
  } catch (e) {
    toast(`Saving failed: ${(e as Error).message}`);
    return false;
  }
}

export function LimitFallbackSetting() {
  const settings = useServerSettings((s) => s.data?.settings);
  const providers = useProviderHub((s) => s.data?.providers);
  if (!settings) return null;
  const mode: LimitFallbackMode = settings.limitFallback ?? 'ask';
  const agent: AgentKind = settings.limitFallbackAgent && settings.limitFallbackAgent !== 'claude' ? settings.limitFallbackAgent : 'codex';
  const label = AGENT_META[agent].short;
  const status = providers?.find((p) => p.agent === agent);
  const ready = !!status?.installed && !!status.loggedIn;
  const why = !status ? 'Checking…' : !status.installed ? `${AGENT_META[agent].label} is not installed` : !status.loggedIn ? `${AGENT_META[agent].label} is not logged in` : '';
  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas/40 p-2.5" data-testid="limit-fallback">
      <div className="text-[12px] font-semibold text-fg">When every Claude account is limited</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Segmented
          label="When every Claude account is limited"
          value={mode}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'switch', label: `Continue on ${label}` },
            { value: 'wait', label: 'Wait' },
          ]}
          onChange={(v) => void save({ limitFallback: v }, v === 'switch' ? `Limited Claude agents continue on ${label}` : v === 'ask' ? 'You will be asked' : 'Limited agents wait for the reset')}
        />
        <Select
          label="CLI to continue on"
          value={agent}
          options={FALLBACK_AGENTS.map((a) => ({ value: a, label: AGENT_META[a].label }))}
          onChange={(v) => void save({ limitFallbackAgent: v }, `Fallback CLI: ${AGENT_META[v].label}`)}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px]" data-testid="limit-fallback-readiness" data-ready={String(ready)}>
        {ready ? <CheckCircle2 size={13} className="text-resting" aria-hidden /> : <AlertTriangle size={13} className="text-needs" aria-hidden />}
        <span className={ready ? 'text-fg-muted' : 'text-fg-muted'}>
          {ready ? `${AGENT_META[agent].label} is ready to take over.` : `${why}: limited agents will wait until you fix that.`}
        </span>
      </div>
      <Note>
        The agent gets a handoff brief from its conversation and “Continue the task.” in {AGENT_META[agent].label}, same name and folder.
        When Claude is available again, Actions offers “Switch back to Claude”. Codex, Gemini, Grok and OpenCode limits switch the other way.
      </Note>
    </div>
  );
}

export function ProviderKeyField({ id, envVar, vendor }: { id: ProviderKeyId; envVar: string; vendor: string }) {
  const info = useServerSettings((s) => s.data?.providerKeys?.[id]);
  const patchKey = async (value: string) => {
    if (await save({ providerKeys: { [id]: value } }, value ? 'API key saved' : 'API key removed')) void useProviderHub.getState().load(true);
  };
  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas/40 p-2.5" data-testid="provider-key" data-provider={id} data-set={String(!!info?.set)}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-[12px] font-semibold text-fg">{vendor} API key</span>
        <span className="aa-label rounded-md bg-needs/12 px-1.5 py-[1px] text-needs">API key — pay per token at {vendor}</span>
        <span className="ml-auto" />
        {info?.set && (
          <>
            <span data-testid="provider-key-status" className="font-mono text-[11.5px] text-fg-subtle">
              set ••••{info.hint}
            </span>
            <SmallButton testId="provider-key-clear" tone="danger" onClick={() => void patchKey('')}>
              Remove
            </SmallButton>
          </>
        )}
      </div>
      <div className="mt-1.5" data-testid="provider-key-input">
        <TextSave key={info?.hint ?? ''} label={`${vendor} API key`} type="password" value="" placeholder={info?.set ? 'Paste a new key to replace it' : `${envVar}, optional`} onSave={patchKey} />
      </div>
      <div className="mt-1 text-[11.5px] text-fg-subtle">
        Optional. Without it, the CLI uses its own sign-in (subscription). With it, {vendor} bills each token to your API account. Stored in
        GridHive’s settings.json and given only to these consoles as {envVar}; it is never shown again.
      </div>
    </div>
  );
}
