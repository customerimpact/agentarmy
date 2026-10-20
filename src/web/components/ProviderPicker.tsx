import { useEffect, useId } from 'react';
import { Download, LogIn, Shuffle } from 'lucide-react';
import type { AgentKind } from '../../shared/agents';
import type { RunOn } from '../lib/agent-choice';
import {
  modelPresets,
  providerKinds,
  providerLabel,
  providerShort,
  READINESS_TEXT,
  readinessOf,
  type ProviderInfo,
  type ProviderKind,
  type Readiness,
} from '../lib/provider-readiness';
import { openProviderSettings, useProvider, useProviders } from '../lib/provider-store';
import { AgentIcon } from './AgentIcon';

// Building blocks for choosing which AI runs a console: readiness dots, the "Run on" segmented
// control, a model field (presets + free text) and an account select. Used by Templates, Composer,
// New agent and Switch agent.

export function useLoadProviders(): ProviderInfo[] | null {
  const providers = useProviders((s) => s.providers);
  useEffect(() => {
    void useProviders.getState().load();
  }, []);
  return providers;
}

const dot = (on: boolean | null, bad: string) => (on === null ? 'bg-line-strong' : on ? 'bg-project-green' : bad);

// Two dots: installed · logged in (grey = not known yet)
export function ReadinessDots({ kind, className = '' }: { kind: AgentKind; className?: string }) {
  const p = useProvider(kind);
  const installed = p ? p.installed : kind === 'claude' ? true : null;
  const loggedIn = installed === false ? null : (p?.loggedIn ?? null);
  const title = `${providerLabel(kind)}: ${installed === null ? 'checking install' : installed ? 'installed' : 'not installed'} · ${
    loggedIn === null ? 'login unknown' : loggedIn ? 'logged in' : 'not logged in'
  }`;
  return (
    <span className={`inline-flex shrink-0 items-center gap-[3px] ${className}`} title={title} aria-label={title} data-testid="readiness-dots">
      <span className={`size-1.5 rounded-full ${dot(installed, 'bg-error')}`} />
      <span className={`size-1.5 rounded-full ${dot(loggedIn, 'bg-needs')}`} />
    </span>
  );
}

// "Install" / "Log in" link that opens Settings > Agents & accounts at that provider
export function FixLink({ kind, readiness }: { kind: AgentKind; readiness: Readiness }) {
  if (readiness !== 'not_installed' && readiness !== 'logged_out') return null;
  const install = readiness === 'not_installed';
  return (
    <button
      type="button"
      data-testid={`provider-fix-${kind}`}
      onClick={() => openProviderSettings(kind)}
      className="inline-flex items-center gap-1 rounded-md px-1 text-[11.5px] font-medium text-accent hover:underline"
    >
      {install ? <Download size={11} /> : <LogIn size={11} />}
      {install ? 'Install' : 'Log in'}
    </button>
  );
}

function Segment({
  kind,
  active,
  onPick,
  testPrefix,
}: {
  kind: ProviderKind;
  active: boolean;
  onPick: () => void;
  testPrefix: string;
}) {
  const p = useProvider(kind);
  const readiness = readinessOf(p, kind);
  const usable = readiness === 'ready' || readiness === 'logged_out' || readiness === 'checking';
  // Not installed: disabled, the hint row below offers Install. Logged out stays pickable (it may
  // still work, e.g. API key in the environment) but is flagged.
  const disabled = readiness === 'not_installed';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      data-testid={`${testPrefix}-${kind}`}
      data-readiness={readiness}
      title={`${providerLabel(kind)} · ${READINESS_TEXT[readiness]}${p?.version ? ` · ${p.version}` : ''}`}
      onClick={onPick}
      className={`relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors
                  ${active ? 'bg-surface text-fg shadow-[0_1px_0_0_var(--aa-line-strong),0_0_0_1px_color-mix(in_srgb,var(--aa-accent)_55%,transparent)]' : 'text-fg-muted hover:bg-hover hover:text-fg'}
                  ${disabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-fg-muted' : ''}`}
    >
      <AgentIcon agent={kind} size={13} className={active ? 'text-accent' : ''} />
      <span className="truncate">{providerShort(kind)}</span>
      {usable && <ReadinessDots kind={kind} />}
    </button>
  );
}

// Segmented control: one option per known CLI (+ Mixed). Below it, one line per unavailable CLI with
// the quick fix, so a disabled option always says why.
export function RunOnControl({
  value,
  onChange,
  allowMixed = true,
  label = 'Run on',
  testId = 'run-on',
  kinds,
}: {
  value: RunOn;
  onChange: (value: RunOn) => void;
  allowMixed?: boolean;
  label?: string;
  testId?: string;
  kinds?: ProviderKind[];
}) {
  const providers = useLoadProviders();
  const list = kinds ?? providerKinds();
  const unavailable = list
    .map((k) => ({ kind: k, readiness: readinessOf(providers?.find((p) => p.id === k), k) }))
    .filter((x) => x.readiness === 'not_installed');
  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="aa-label shrink-0 text-fg-subtle">{label}</span>
        <div role="radiogroup" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-0.5 rounded-xl border border-line bg-canvas/70 p-0.5">
          {list.map((kind) => (
            <Segment key={kind} kind={kind} active={value === kind} onPick={() => onChange(kind)} testPrefix={`${testId}-option`} />
          ))}
          {allowMixed && (
            <>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
              <button
                type="button"
                role="radio"
                aria-checked={value === 'mixed'}
                data-testid={`${testId}-option-mixed`}
                onClick={() => onChange('mixed')}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors
                            ${value === 'mixed' ? 'bg-surface text-fg shadow-[0_0_0_1px_color-mix(in_srgb,var(--aa-accent)_55%,transparent)]' : 'text-fg-muted hover:bg-hover hover:text-fg'}`}
              >
                <Shuffle size={13} className={value === 'mixed' ? 'text-accent' : ''} />
                Mixed
              </button>
            </>
          )}
        </div>
      </div>
      {unavailable.length > 0 && (
        // Logged-out CLIs stay pickable (amber dot); the options row below says how to log in
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-fg-subtle" data-testid={`${testId}-hints`}>
          <span>Not installed:</span>
          {unavailable.map(({ kind, readiness }) => (
            <span key={kind} className="inline-flex items-center gap-0.5">
              {providerShort(kind)}
              <FixLink kind={kind} readiness={readiness} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Model: presets in a list, any id can be typed ('' = the CLI's default)
export function ModelField({
  kind,
  value,
  onChange,
  className = '',
  testId = 'model-field',
}: {
  kind: AgentKind;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  testId?: string;
}) {
  const listId = useId();
  const presets = modelPresets(kind);
  return (
    <span className={`inline-flex min-w-0 items-center ${className}`}>
      <input
        data-testid={testId}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Default model"
        spellCheck={false}
        maxLength={200}
        title={`Model for ${providerLabel(kind)}: pick a preset or type any model id. Empty = the CLI's own default.`}
        className="h-7 w-full min-w-0 rounded-md border border-line bg-surface px-2 font-mono text-[11.5px] text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle
                   focus:border-accent"
      />
      <datalist id={listId}>
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </datalist>
    </span>
  );
}

// Account select for one CLI; renders nothing when it has one account or none
export function ProviderAccountSelect({
  kind,
  value,
  onChange,
  className = '',
  testId = 'provider-account',
}: {
  kind: AgentKind;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  testId?: string;
}) {
  const p = useProvider(kind);
  const accounts = p?.accounts ?? [];
  if (accounts.length < 2) return null;
  return (
    <select
      data-testid={testId}
      value={value || 'auto'}
      onChange={(e) => onChange(e.target.value)}
      title={`${providerLabel(kind)} account`}
      className={`h-7 rounded-md border border-line bg-surface px-1.5 text-[12px] text-fg outline-none focus:border-accent ${className}`}
    >
      <option value="auto">Auto account</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id} disabled={a.status === 'needs_login'}>
          {a.name}
          {a.status === 'needs_login' ? ' (log in first)' : a.status === 'limited' ? ' (limited)' : ''}
        </option>
      ))}
    </select>
  );
}

// Inline warning for a row / target that is not ready
export function ReadinessWarning({ kind, className = '' }: { kind: AgentKind; className?: string }) {
  const p = useProvider(kind);
  const readiness = readinessOf(p, kind);
  if (readiness === 'ready' || readiness === 'checking') return null;
  return (
    <span data-testid="readiness-warning" className={`inline-flex items-center gap-1 text-[11.5px] text-needs ${className}`}>
      {providerShort(kind)} {READINESS_TEXT[readiness].toLowerCase()}
      <FixLink kind={kind} readiness={readiness} />
    </span>
  );
}

// A compact select of CLIs with readiness in the option text (per team / per row)
export function ProviderSelect({
  value,
  onChange,
  className = '',
  testId,
  kinds,
}: {
  value: AgentKind;
  onChange: (value: AgentKind) => void;
  className?: string;
  testId?: string;
  kinds?: ProviderKind[];
}) {
  const providers = useLoadProviders();
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value as AgentKind)}
      className={`h-7 rounded-md border border-line bg-surface px-1.5 text-[12px] text-fg outline-none focus:border-accent ${className}`}
    >
      {(kinds ?? providerKinds()).map((k) => {
        const r = readinessOf(providers?.find((p) => p.id === k), k);
        return (
          <option key={k} value={k} disabled={r === 'not_installed'}>
            {providerShort(k)}
            {r === 'not_installed' ? ' (not installed)' : r === 'logged_out' ? ' (log in)' : ''}
          </option>
        );
      })}
    </select>
  );
}
