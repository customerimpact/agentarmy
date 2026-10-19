import { useState, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  Bell,
  Bot,
  Copy,
  Globe,
  LayoutGrid,
  Palette,
  Plug,
  Send,
  SlidersHorizontal,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Gauge } from 'lucide-react';
import { PauseJobsControl, ProjectBudgetsBelow, budgetBelow } from './settings/UsageSettings';
import type { PermissionModeSetting, SettingsPatch, StartupResume, WebhookKind } from '../../shared/protocol';
import { api } from '../lib/api';
import { useBoardUi } from '../lib/board-ui';
import { setSoundEnabled, testSound, useSoundEnabled } from '../lib/notify';
import { PREF_LIMITS, usePrefs, type DefaultSidebarTab } from '../lib/prefs';
import { useServerSettings } from '../lib/settings';
import { useBoard } from '../lib/store';
import { DEFAULT_THEME, THEMES, setTheme, useTheme } from '../lib/theme';
import { NtfyBelow } from './settings/NtfySetting';
import { AccountsBelow, AutoSwitchBelow, AutoSwitchControl, NewAgentAccountControl, PriorityBelow } from './settings/AccountsSettings';
import { UsersRound } from 'lucide-react';
import { Note, Segmented, Select, SmallButton, Stepper, TextSave, Toggle } from './settings/fields';

// Settings registry: general first, then increasingly specific sections. Every row is data
// (label, description, keywords) so the search box can filter across all of them.
// SettingsWindow.tsx renders it: one left-nav category per section (any new section gets its own
// nav item automatically), rows grouped into cards by `group`.

export type SectionKey =
  | 'general'
  | 'accounts'
  | 'appearance'
  | 'notifications'
  | 'board'
  | 'terminals'
  | 'claude'
  | 'usage'
  | 'browser'
  | 'integrations'
  | 'advanced';

export interface SectionDef {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  note?: string;
}

export const SECTIONS: SectionDef[] = [
  { key: 'general', label: 'General', icon: SlidersHorizontal },
  { key: 'accounts', label: 'Accounts', icon: UsersRound },
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'board', label: 'Board', icon: LayoutGrid },
  { key: 'terminals', label: 'Terminals', icon: SquareTerminal },
  {
    key: 'claude',
    label: 'Claude Code',
    icon: Bot,
    note: 'Applies to consoles you create or restart from now on. Running consoles keep their current settings.',
  },
  {
    key: 'usage',
    label: 'Usage & budgets',
    icon: Gauge,
    note: 'Budgets count weighted tokens (cache reads count a tenth) read from Claude Code’s local transcripts. You get an alert at 80% and 100%.',
  },
  { key: 'browser', label: 'Browser & Previews', icon: Globe },
  { key: 'integrations', label: 'Integrations', icon: Plug },
  { key: 'advanced', label: 'Advanced', icon: Wrench },
];

export interface SettingDef {
  id: string;
  section: SectionKey;
  label: string;
  description: string;
  keywords?: string;
  Control?: () => ReactNode; // right-aligned control
  Below?: () => ReactNode; // full-width content under the text (inputs, warnings, cards)
  group?: string; // card label inside its section (rows with the same group share a card)
  badge?: 'new-agents' | 'restart'; // "Applies to new agents" / "Restart needed" chip
}

const toast = (message: string) => useBoard.getState().toast(message);

async function patchServer(patch: SettingsPatch, ok?: string): Promise<boolean> {
  try {
    await useServerSettings.getState().patch(patch);
    if (ok) toast(ok);
    return true;
  } catch (e) {
    toast(`Could not save: ${(e as Error).message}`);
    return false;
  }
}

function useServer() {
  return useServerSettings((s) => s.data);
}

function Loading() {
  return <span className="text-[11.5px] text-fg-subtle">Loading…</span>;
}

// ---------- General ----------

function ThemeCards() {
  const current = useTheme();
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => {
        const active = t.id === current;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`theme-card-${t.id}`}
            onClick={() => setTheme(t.id)}
            className={`group rounded-xl border p-2 text-left transition-colors
                        hover:border-fg-subtle
                        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
                        ${active ? 'border-accent ring-1 ring-accent' : 'border-line-strong'}`}
          >
            {/* Mini board: sidebar strip, a console card, status dots */}
            <span
              className="flex h-[72px] overflow-hidden rounded-lg border border-black/20"
              style={{ background: t.swatches[0] }}
              aria-hidden
            >
              <span className="w-5 shrink-0 border-r border-black/15" style={{ background: t.swatches[1] }} />
              <span className="flex flex-1 flex-col gap-1.5 p-2">
                <span className="h-7 rounded-md border border-black/15" style={{ background: t.swatches[1] }}>
                  <span className="mx-1.5 mt-1.5 block h-1 w-8 rounded-full" style={{ background: t.swatches[2] }} />
                </span>
                <span className="mt-auto flex gap-1">
                  {t.swatches.slice(2).map((c) => (
                    <span key={c} className="size-2 rounded-full" style={{ background: c }} />
                  ))}
                </span>
              </span>
            </span>
            <span className="mt-2 flex items-center gap-1.5 px-0.5 text-[12.5px] font-semibold text-fg">
              {t.name}
              {active && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
            </span>
            <span className="line-clamp-2 block px-0.5 text-[11.5px] leading-[15px] text-fg-subtle">{t.description}</span>
          </button>
        );
      })}
    </div>
  );
}

const STARTUP_OPTIONS: { value: StartupResume; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'always', label: 'Resume all' },
  { value: 'never', label: 'Keep stopped' },
];

function StartupControl() {
  const data = useServer();
  if (!data) return <Loading />;
  return (
    <Segmented
      label="On startup"
      value={data.settings.startupResume}
      options={STARTUP_OPTIONS}
      onChange={(startupResume) => void patchServer({ startupResume })}
    />
  );
}

const TAB_OPTIONS: { value: DefaultSidebarTab; label: string }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'actions', label: 'Actions' },
  { value: 'progress', label: 'Progress' },
];

function SidebarTabControl() {
  const value = usePrefs((s) => s.prefs.defaultSidebarTab);
  return (
    <Select
      label="Sidebar opens on"
      value={value === 'settings' ? 'agents' : value}
      options={TAB_OPTIONS}
      onChange={(defaultSidebarTab) => usePrefs.getState().setPrefs({ defaultSidebarTab })}
    />
  );
}

// ---------- Notifications ----------

function permissionState(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function DesktopControl() {
  const [state, setState] = useState(permissionState);
  if (state === 'granted') return <span className="text-[12px] font-medium text-resting">Allowed</span>;
  if (state === 'unsupported') return <span className="text-[12px] text-fg-subtle">Not supported here</span>;
  if (state === 'denied') return <span className="text-[12px] font-medium text-error">Blocked</span>;
  return (
    <SmallButton
      testId="request-notifications"
      onClick={() => void Notification.requestPermission().then(() => setState(permissionState()))}
    >
      Allow
    </SmallButton>
  );
}

function DesktopBelow() {
  const state = permissionState();
  if (state !== 'denied') return null;
  return <Note tone="warn">Blocked in this browser. Allow notifications for this site in the address bar's site settings.</Note>;
}

function SoundControl() {
  const on = useSoundEnabled();
  return <Toggle label="Sound" checked={on} onChange={setSoundEnabled} />;
}

function VolumeControl() {
  const volume = usePrefs((s) => s.prefs.soundVolume);
  const on = useSoundEnabled();
  const { min, max, step } = PREF_LIMITS.soundVolume;
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        aria-label="Volume"
        min={min}
        max={max}
        step={step}
        value={volume}
        disabled={!on}
        onChange={(e) => usePrefs.getState().setPrefs({ soundVolume: Number(e.target.value) })}
        onPointerUp={() => testSound()}
        onKeyUp={() => testSound()}
        className="w-28 accent-[var(--aa-accent)] disabled:opacity-40"
      />
      <span className="w-8 text-right text-[11.5px] text-fg-muted tabular-nums">{Math.round(volume * 100)}%</span>
    </div>
  );
}

const WEBHOOK = {
  slack: { name: 'Slack', field: 'slackWebhookUrl', placeholder: 'https://hooks.slack.com/services/…' },
  discord: { name: 'Discord', field: 'discordWebhookUrl', placeholder: 'https://discord.com/api/webhooks/…' },
} as const;

function WebhookBelow({ kind }: { kind: WebhookKind }) {
  const info = useServerSettings((s) => s.data?.[kind]);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const meta = WEBHOOK[kind];
  if (!info) return <Loading />;
  const sendTest = async () => {
    setTesting(true);
    try {
      await api.testWebhook(kind);
      toast(`Test message sent to ${meta.name}`);
    } catch (e) {
      toast(`${meta.name} test failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };
  if (info.set && !editing) {
    return (
      <div className="mt-2 flex items-center gap-1.5">
        <span className="mr-auto inline-flex min-w-0 items-center gap-1.5 truncate text-[12px] text-fg-muted">
          <span className="size-1.5 shrink-0 rounded-full bg-resting" />
          Connected
          <span className="font-mono text-fg-subtle">••••{info.hint}</span>
        </span>
        <SmallButton testId={`test-${kind}`} disabled={testing} onClick={() => void sendTest()}>
          <Send size={12} />
          Test
        </SmallButton>
        <SmallButton onClick={() => setEditing(true)}>Change</SmallButton>
        <SmallButton tone="danger" onClick={() => void patchServer({ [meta.field]: '' }, `${meta.name} webhook removed`)}>
          Remove
        </SmallButton>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-1">
      <TextSave
        label={`${meta.name} webhook URL`}
        type="password"
        value=""
        placeholder={meta.placeholder}
        onSave={async (url) => {
          if (await patchServer({ [meta.field]: url }, `${meta.name} webhook saved`)) setEditing(false);
        }}
      />
      {editing && (
        <button type="button" onClick={() => setEditing(false)} className="self-start text-[11.5px] text-fg-subtle hover:text-fg">
          Cancel
        </button>
      )}
    </div>
  );
}

// Stuck-agent alerts (server settings)
function StuckToggle() {
  const on = useServerSettings((s) => s.data?.settings.stuckAlerts);
  if (on === undefined) return <Loading />;
  return <Toggle label="Stuck-agent alerts" checked={on} onChange={(v) => void patchServer({ stuckAlerts: v })} />;
}

function minutesStepper(key: 'stallMinutes' | 'longTurnMinutes', label: string, min: number, max: number, step: number) {
  return function MinutesStepper() {
    const data = useServer();
    if (!data) return <Loading />;
    return (
      <Stepper
        label={label}
        value={data.settings[key]}
        min={min}
        max={max}
        step={step}
        format={(v) => `${v} min`}
        onChange={(v) => void patchServer({ [key]: v })}
      />
    );
  };
}

// ---------- Board ----------

function SnapControl() {
  const snap = useBoardUi((s) => s.prefs.snap);
  return <Toggle label="Snap to grid" checked={snap} onChange={(v) => useBoardUi.getState().setPrefs({ snap: v })} />;
}

function GridControl() {
  const grid = usePrefs((s) => s.prefs.gridSize);
  const { min, max, step } = PREF_LIMITS.gridSize;
  return (
    <Stepper
      label="Grid size"
      value={grid}
      min={min}
      max={max}
      step={step}
      format={(v) => `${v}px`}
      onChange={(gridSize) => usePrefs.getState().setPrefs({ gridSize })}
    />
  );
}

function SizeControl() {
  const size = usePrefs((s) => s.prefs.defaultSize);
  return (
    <Segmented
      label="New console size"
      value={size}
      options={[
        { value: 'S', label: 'S' },
        { value: 'M', label: 'M' },
        { value: 'L', label: 'L' },
      ]}
      onChange={(defaultSize) => usePrefs.getState().setPrefs({ defaultSize })}
    />
  );
}

function ColumnsControl() {
  const columns = useBoardUi((s) => s.prefs.columns);
  return (
    <Segmented
      label="Arrange columns"
      value={columns}
      options={[
        { value: 2, label: '2' },
        { value: 3, label: '3' },
        { value: 4, label: '4' },
        { value: 'auto', label: 'Auto' },
      ]}
      onChange={(v) => useBoardUi.getState().setPrefs({ columns: v })}
    />
  );
}

function GapControl() {
  const gap = useBoardUi((s) => s.prefs.gap);
  return (
    <Segmented
      label="Arrange gap"
      value={gap}
      options={[
        { value: 24, label: 'Tight' },
        { value: 40, label: 'Normal' },
        { value: 64, label: 'Roomy' },
      ]}
      onChange={(v) => useBoardUi.getState().setPrefs({ gap: v })}
    />
  );
}

function prefToggle(key: 'showMinimap' | 'reduceMotion' | 'termCursorBlink', label: string) {
  return function PrefToggle() {
    const value = usePrefs((s) => s.prefs[key]);
    return <Toggle label={label} checked={value} onChange={(v) => usePrefs.getState().setPrefs({ [key]: v })} />;
  };
}

// ---------- Terminals ----------

function FontSizeControl() {
  const size = usePrefs((s) => s.prefs.termFontSize);
  const { min, max, step } = PREF_LIMITS.termFontSize;
  return (
    <Stepper
      label="Font size"
      value={size}
      min={min}
      max={max}
      step={step}
      format={(v) => `${v}px`}
      onChange={(termFontSize) => usePrefs.getState().setPrefs({ termFontSize })}
    />
  );
}

function LineHeightControl() {
  const value = usePrefs((s) => s.prefs.termLineHeight);
  const { min, max, step } = PREF_LIMITS.termLineHeight;
  return (
    <Stepper
      label="Line height"
      value={value}
      min={min}
      max={max}
      step={step}
      format={(v) => v.toFixed(2)}
      onChange={(termLineHeight) => usePrefs.getState().setPrefs({ termLineHeight })}
    />
  );
}

const SCROLLBACK_OPTIONS = ['1000', '2500', '5000', '10000', '25000', '50000'] as const;

function ScrollbackControl() {
  const value = usePrefs((s) => s.prefs.termScrollback);
  const options = SCROLLBACK_OPTIONS.map((v) => ({ value: v, label: `${Number(v).toLocaleString()} lines` }));
  const current = String(value);
  return (
    <Select
      label="Scrollback"
      value={current}
      options={options.some((o) => o.value === current) ? options : [{ value: current, label: `${value} lines` }, ...options]}
      onChange={(v) => usePrefs.getState().setPrefs({ termScrollback: Number(v) })}
    />
  );
}

// ---------- Claude Code ----------

const MODEL_ALIASES = ['', 'opus', 'sonnet', 'haiku'];
const CUSTOM = '__custom';

// "Custom model id…" picked but not saved yet; shared by the select (Control) and the input (Below)
const useCustomModel = create<{ picked: boolean }>(() => ({ picked: false }));
const pickCustomModel = (picked: boolean) => useCustomModel.setState({ picked });

function useModelMode(): [string | undefined, boolean] {
  const model = useServerSettings((s) => s.data?.settings.model);
  const picked = useCustomModel((s) => s.picked);
  return [model, picked || (model !== undefined && !MODEL_ALIASES.includes(model))];
}

function ModelControl() {
  const [model, custom] = useModelMode();
  if (model === undefined) return <Loading />;
  return (
    <Select
      label="Model"
      value={custom ? CUSTOM : model}
      options={[
        { value: '', label: 'Claude Code default' },
        { value: 'opus', label: 'Opus' },
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'haiku', label: 'Haiku' },
        { value: CUSTOM, label: 'Custom model id…' },
      ]}
      onChange={(v) => {
        pickCustomModel(v === CUSTOM);
        if (v === CUSTOM) return;
        void patchServer({ model: v }, v ? `New consoles will use ${v}` : 'New consoles use Claude Code’s default model');
      }}
    />
  );
}

function ModelBelow() {
  const [model, custom] = useModelMode();
  if (!custom || model === undefined) return null;
  return (
    <div className="mt-2">
      <TextSave
        label="Custom model id"
        value={MODEL_ALIASES.includes(model) ? '' : model}
        placeholder="e.g. claude-opus-4-1 or opus[1m]"
        onSave={(v) => patchServer({ model: v }, v ? `New consoles will use ${v}` : undefined)}
      />
    </div>
  );
}

const PERMISSION_OPTIONS: { value: PermissionModeSetting; label: string }[] = [
  { value: '', label: 'Claude Code default' },
  { value: 'default', label: 'Ask every time' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'bypassPermissions', label: 'Bypass all (unsafe)' },
];

function PermissionControl() {
  const data = useServer();
  if (!data) return <Loading />;
  return (
    <Select
      label="Permission mode"
      value={data.settings.permissionMode}
      options={PERMISSION_OPTIONS}
      onChange={(permissionMode) => void patchServer({ permissionMode })}
    />
  );
}

function PermissionBelow() {
  const mode = useServerSettings((s) => s.data?.settings.permissionMode);
  if (mode === 'bypassPermissions') {
    return (
      <Note tone="danger">
        Agents will run any command and edit any file without asking, including destructive ones. Only use this in a
        sandbox or a throwaway checkout.
      </Note>
    );
  }
  if (mode === 'acceptEdits') return <Note>File edits are applied without asking; commands still need approval.</Note>;
  return null;
}

function ExtraArgsBelow() {
  const data = useServer();
  if (!data) return <Loading />;
  return (
    <div className="mt-2">
      <TextSave
        label="Extra flags"
        value={data.settings.extraArgs}
        placeholder='e.g. --verbose --add-dir "../shared lib"'
        onSave={(extraArgs) => patchServer({ extraArgs }, 'Extra flags saved')}
      />
    </div>
  );
}

function serverToggle(key: 'enableTasks' | 'useApiKey', label: string) {
  return function ServerToggle() {
    const data = useServer();
    if (!data) return <Loading />;
    return <Toggle label={label} checked={data.settings[key]} onChange={(v) => void patchServer({ [key]: v })} />;
  };
}

function ApiKeyBelow() {
  const on = useServerSettings((s) => s.data?.settings.useApiKey);
  if (!on) return null;
  return (
    <Note tone="warn">
      Consoles get ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the server’s environment and bill API credits per
      token instead of your Claude subscription.
    </Note>
  );
}

function pathBelow(key: 'claudePath' | 'browserPath', label: string, placeholder: string) {
  return function PathBelow() {
    const data = useServer();
    if (!data) return <Loading />;
    return (
      <div className="mt-2">
        <TextSave
          label={label}
          value={data.settings[key]}
          placeholder={placeholder}
          onSave={(v) => patchServer({ [key]: v }, v ? `${label} saved` : `${label} cleared, auto-detecting`)}
        />
      </div>
    );
  };
}

// ---------- Auto previews and daily recap ----------

function AutoPreviewControl() {
  const data = useServer();
  if (!data) return <Loading />;
  return <Toggle label="Auto-open previews" checked={data.settings.autoPreview} onChange={(autoPreview) => void patchServer({ autoPreview })} />;
}

function PreviewModeControl() {
  const data = useServer();
  if (!data) return <Loading />;
  return (
    <Segmented
      label="When a dev server starts"
      value={data.settings.previewMode}
      disabled={!data.settings.autoPreview}
      options={[
        { value: 'open', label: 'Open directly' },
        { value: 'ask', label: 'Ask first' },
      ]}
      onChange={(previewMode) => void patchServer({ previewMode })}
    />
  );
}

function RecapSendControl() {
  const data = useServer();
  if (!data) return <Loading />;
  return <Toggle label="Send recap automatically" checked={data.settings.recapAutoSend} onChange={(recapAutoSend) => void patchServer({ recapAutoSend })} />;
}

function RecapSendBelow() {
  const data = useServer();
  if (!data || !data.settings.recapAutoSend) return null;
  const hasHook = data.slack.set || data.discord.set;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-[12px] text-fg-muted">
        Send at
        <input
          type="time"
          data-testid="recap-time"
          aria-label="Recap time"
          value={data.settings.recapTime}
          onChange={(e) => e.target.value && void patchServer({ recapTime: e.target.value }, `Recap goes out at ${e.target.value}`)}
          className="rounded-md border border-line-strong bg-canvas px-2 py-0.5 font-mono text-[12px] text-fg"
        />
        <span className="text-fg-subtle">every day, to {[data.slack.set && 'Slack', data.discord.set && 'Discord'].filter(Boolean).join(' and ') || '…'}</span>
      </label>
      {!hasHook && <Note tone="warn">Add a Slack or Discord webhook above first; nothing is sent without one.</Note>}
    </div>
  );
}

// ---------- Advanced ----------

function CopyValue({ value, testId }: { value: string; testId?: string }) {
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <code
        data-testid={testId}
        className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11.5px] text-fg-muted"
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        title="Copy"
        aria-label="Copy"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(
            () => toast('Copied'),
            () => toast('Could not copy'),
          )
        }
        className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

function DataDirBelow() {
  const data = useServer();
  return data ? <CopyValue value={data.dataDir} testId="settings-data-dir" /> : <Loading />;
}

function PortControl() {
  const data = useServer();
  return data ? <span className="font-mono text-[12px] text-fg-muted">{data.port}</span> : <Loading />;
}

function TokenBelow() {
  return <CopyValue value="npx agentarmy --new-token" />;
}

function resetEverything(): void {
  useBoard.getState().askConfirm({
    title: 'Reset all settings?',
    message:
      'Theme, sound, board, terminal and Claude Code settings go back to their defaults, and the Slack, Discord and phone (ntfy) notifications are removed. Your consoles and projects are not touched.',
    confirmLabel: 'Reset settings',
    danger: true,
    onConfirm: async () => {
      try {
        await useServerSettings.getState().reset();
      } catch (e) {
        toast(`Could not reset server settings: ${(e as Error).message}`);
        return;
      }
      usePrefs.getState().resetPrefs();
      useBoardUi.getState().setPrefs({ columns: 'auto', gap: 40, size: 'common', snap: true });
      setTheme(DEFAULT_THEME);
      setSoundEnabled(true);
      toast('All settings reset to defaults');
    },
  });
}

function ResetControl() {
  return (
    <SmallButton tone="danger" testId="settings-reset" onClick={resetEverything}>
      Reset…
    </SmallButton>
  );
}

function AboutControl() {
  const data = useServer();
  return (
    <span className="text-[12px] text-fg-muted">
      v<span data-testid="settings-version">{data?.version ?? '…'}</span>
      {' · '}
      <a
        href="https://github.com/customerimpact/agentarmy"
        target="_blank"
        rel="noreferrer"
        className="text-accent hover:underline"
      >
        GitHub
      </a>
    </span>
  );
}

// ---------- Registry ----------

const SETTINGS: SettingDef[] = [
  { id: 'theme', section: 'appearance', label: 'Theme', description: 'Colors for the board, panels and terminals.', keywords: 'appearance color colour dark light ember midnight aurora paper look', Below: ThemeCards },
  { id: 'startup', section: 'general', label: 'On startup', description: 'What to do with saved conversations when AgentArmy starts.', keywords: 'resume restore relaunch reopen launch boot', Control: StartupControl },
  { id: 'sidebar-tab', section: 'general', label: 'Sidebar opens on', description: 'The tab shown when the app loads.', keywords: 'default tab panel start', Control: SidebarTabControl },

  { id: 'accounts', section: 'accounts', group: 'Your accounts', label: 'Claude accounts', description: 'Each account is its own Claude Code login (config folder). Log in once in a terminal; agents can then run on it.', keywords: 'account login profile subscription email plan claude_config_dir multiple switch limit usage', Below: AccountsBelow },
  { id: 'account-auto-switch', section: 'accounts', group: 'When an account hits its limit', label: 'Auto-switch accounts', description: 'Move an agent that hits its plan limit to another account you own and resume its conversation there. Only use accounts you are entitled to, and check Anthropic’s terms: using extra accounts to get around usage limits may not be allowed.', keywords: 'limit rate usage switch fallback failover weekly session 5-hour', Control: AutoSwitchControl, Below: AutoSwitchBelow },
  { id: 'account-priority', section: 'accounts', group: 'When an account hits its limit', label: 'Priority order', description: 'Auto and auto-switch use the first account that is logged in and not limited.', keywords: 'order rank fallback first', Below: PriorityBelow },
  { id: 'account-new-agents', section: 'accounts', group: 'New agents', label: 'New agents use', description: 'The account picked for New agent and templates unless you choose one there.', keywords: 'default account auto spawn', Control: NewAgentAccountControl },

  { id: 'desktop', section: 'notifications', label: 'Desktop notifications', description: 'Pop-up when an agent needs you while this tab is in the background.', keywords: 'alert permission browser popup notify', Control: DesktopControl, Below: DesktopBelow },
  { id: 'sound', section: 'notifications', label: 'Sound', description: 'Short chime when an agent needs you.', keywords: 'audio chime beep mute alert', Control: SoundControl },
  { id: 'volume', section: 'notifications', label: 'Volume', description: 'Chime loudness. Release the slider to hear it.', keywords: 'sound audio loud quiet', Control: VolumeControl },
  { id: 'slack', section: 'notifications', label: 'Slack', description: 'Post to a Slack channel when an agent needs you (incoming webhook, max one per agent every 30 s).', keywords: 'webhook chat message phone remote', Below: () => <WebhookBelow kind="slack" /> },
  { id: 'stuck-alerts', section: 'notifications', label: 'Stuck-agent alerts', description: 'Add an Actions item when a working agent stalls, repeats the same tool call 5 times, or runs one turn very long.', keywords: 'stalled looping loop hung frozen idle timeout watchdog nudge interrupt', Control: StuckToggle },
  { id: 'stall-minutes', section: 'notifications', label: 'Stalled after', description: 'Working with no new output and no tool activity for this long.', keywords: 'stuck hung frozen timeout minutes', Control: minutesStepper('stallMinutes', 'Stalled after', 1, 120, 1) },
  { id: 'long-turn-minutes', section: 'notifications', label: 'Long turn after', description: 'One turn running longer than this.', keywords: 'stuck slow duration timeout minutes', Control: minutesStepper('longTurnMinutes', 'Long turn after', 5, 480, 5) },
  { id: 'discord', section: 'notifications', label: 'Discord', description: 'Post to a Discord channel when an agent needs you (channel webhook, max one per agent every 30 s).', keywords: 'webhook chat message phone remote', Below: () => <WebhookBelow kind="discord" /> },
  { id: 'recap-send', section: 'notifications', label: 'Daily recap', description: 'Post the end-of-day recap (Progress › Recap) to Slack / Discord at a set time.', keywords: 'summary report digest end of day schedule webhook', Control: RecapSendControl, Below: RecapSendBelow },
  { id: 'ntfy', section: 'notifications', label: 'Phone (ntfy)', description: 'Push to your phone with the free ntfy app, no account needed (max one per agent every 30 s).', keywords: 'phone mobile push ntfy android ios iphone remote qr', Below: NtfyBelow },

  { id: 'snap', section: 'board', label: 'Snap while dragging', description: 'Align consoles to neighbours and the grid. Hold Alt to place freely.', keywords: 'grid magnet align guides', Control: SnapControl },
  { id: 'grid-size', section: 'board', label: 'Grid size', description: 'Spacing of the snap grid.', keywords: 'snap spacing', Control: GridControl },
  { id: 'console-size', section: 'board', label: 'New console size', description: 'Size of a console created with New console.', keywords: 'default width height small medium large', Control: SizeControl },
  { id: 'arrange-columns', section: 'board', label: 'Arrange columns', description: 'Columns used by Arrange › Grid.', keywords: 'layout tidy grid', Control: ColumnsControl },
  { id: 'arrange-gap', section: 'board', label: 'Arrange gap', description: 'Space between consoles when arranging.', keywords: 'layout spacing margin tidy', Control: GapControl },
  { id: 'minimap', section: 'board', label: 'Minimap', description: 'Overview of the whole board in the corner.', keywords: 'map overview navigator', Control: prefToggle('showMinimap', 'Minimap') },
  { id: 'reduce-motion', section: 'board', label: 'Reduce motion', description: 'Turn off flowing particles, glows and animations.', keywords: 'animation accessibility a11y particles calm', Control: prefToggle('reduceMotion', 'Reduce motion') },

  { id: 'font-size', section: 'terminals', label: 'Font size', description: 'Terminal text size. Updates open terminals right away.', keywords: 'text zoom bigger smaller type', Control: FontSizeControl },
  { id: 'line-height', section: 'terminals', label: 'Line height', description: 'Space between terminal lines.', keywords: 'font spacing leading', Control: LineHeightControl },
  { id: 'cursor-blink', section: 'terminals', label: 'Blinking cursor', description: 'Blink the terminal cursor.', keywords: 'caret', Control: prefToggle('termCursorBlink', 'Blinking cursor') },
  { id: 'scrollback', section: 'terminals', label: 'Scrollback', description: 'Lines each terminal keeps for scrolling up.', keywords: 'history buffer memory lines', Control: ScrollbackControl },

  { id: 'model', section: 'claude', label: 'Model', description: 'Model for new consoles (--model).', keywords: 'opus sonnet haiku llm claude version', Control: ModelControl, Below: ModelBelow },
  { id: 'permission-mode', section: 'claude', label: 'Permission mode', description: 'How much agents may do without asking (--permission-mode).', keywords: 'approve accept edits plan bypass dangerously skip yolo safety', Control: PermissionControl, Below: PermissionBelow },
  { id: 'extra-args', section: 'claude', label: 'Extra flags', description: 'More claude command-line flags. Quotes group words; no shell is involved.', keywords: 'arguments args cli options command line', Below: ExtraArgsBelow },
  { id: 'task-list', section: 'claude', label: 'Task list', description: 'Let agents keep a task list that feeds the Progress tab.', keywords: 'todo tasks progress CLAUDE_CODE_ENABLE_TASKS', Control: serverToggle('enableTasks', 'Task list') },
  { id: 'api-key', section: 'claude', label: 'Use API key', description: 'Bill API credits instead of your Claude subscription login.', keywords: 'anthropic_api_key billing subscription credits token', Control: serverToggle('useApiKey', 'Use API key'), Below: ApiKeyBelow },
  { id: 'claude-path', section: 'claude', label: 'Claude executable', description: 'Path to claude, if it is not on PATH.', keywords: 'binary exe location install AGENTARMY_CLAUDE_PATH', Below: pathBelow('claudePath', 'Claude path', 'Auto-detect (claude on PATH)') },

  { id: 'budget-daily', section: 'usage', label: 'Daily budget', description: 'All Claude Code sessions on this machine, since midnight.', keywords: 'usage tokens limit cost spend today plan', Below: budgetBelow('budgetDailyTokens', 'Daily') },
  { id: 'budget-5h', section: 'usage', label: '5-hour budget', description: 'Rolling last 5 hours, like the plan’s session limit.', keywords: 'usage tokens limit pressure plan session window', Below: budgetBelow('budget5hTokens', '5-hour') },
  { id: 'budget-weekly', section: 'usage', label: 'Weekly budget', description: 'Rolling last 7 days, like the plan’s weekly limit.', keywords: 'usage tokens limit pressure plan week', Below: budgetBelow('budgetWeeklyTokens', 'Weekly') },
  { id: 'budget-projects', section: 'usage', label: 'Project daily budgets', description: 'Today’s tokens of the consoles in each project.', keywords: 'usage tokens limit team group', Below: ProjectBudgetsBelow },
  { id: 'budget-pause', section: 'usage', label: 'Pause new jobs at 100%', description: 'Agents cannot send each other jobs while a budget is used up.', keywords: 'usage budget stop block send_job orchestrator limit', Control: PauseJobsControl },
  { id: 'browser-path', section: 'browser', label: 'Browser executable', description: 'Chrome, Edge or Chromium used for browser tiles.', keywords: 'chrome edge chromium path binary AGENTARMY_BROWSER_PATH web', Below: pathBelow('browserPath', 'Browser path', 'Auto-detect Chrome / Edge / Chromium') },
  { id: 'auto-preview', section: 'browser', label: 'Auto-open dev previews', description: 'When an agent starts a dev server (e.g. http://localhost:5173), show it in a browser tile next to that agent.', keywords: 'preview localhost dev server vite next port url automatic', Control: AutoPreviewControl },
  { id: 'preview-mode', section: 'browser', label: 'Preview prompt', description: 'Open the preview right away, or ask first with a small prompt.', keywords: 'ask confirm toast preview automatic', Control: PreviewModeControl },

  { id: 'data-dir', section: 'advanced', label: 'Data folder', description: 'Board, settings and token files live here.', keywords: 'storage state json home AGENTARMY_HOME location', Below: DataDirBelow },
  { id: 'port', section: 'advanced', label: 'Server port', description: 'Change it with agentarmy --port <n>.', keywords: 'network localhost url', Control: PortControl },
  { id: 'token', section: 'advanced', label: 'Access token', description: 'Rotate it if the board URL leaked: restart with --new-token, then open the new URL.', keywords: 'security rotate secret url new-token', Below: TokenBelow },
  { id: 'reset', section: 'advanced', label: 'Reset all settings', description: 'Back to defaults, in this browser and on the server.', keywords: 'defaults restore clear', Control: ResetControl },
  { id: 'about', section: 'advanced', label: 'About', description: 'Free, open-source (MIT) board for Claude Code agents. Independent project, not affiliated with or endorsed by Anthropic.', keywords: 'version license update', Control: AboutControl },
];

export { SETTINGS };

export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// sectionLabel: the nav category the row is shown under (searching its name finds the row)
export function matches(def: SettingDef, tokens: string[], sectionLabel?: string): boolean {
  const section = sectionLabel ?? SECTIONS.find((s) => s.key === def.section)?.label ?? def.section;
  const hay = `${def.label} ${def.description} ${def.keywords ?? ''} ${section}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
