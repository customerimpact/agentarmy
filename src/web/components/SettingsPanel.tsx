import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  Bell,
  Bot,
  ChevronDown,
  Copy,
  Globe,
  LayoutGrid,
  Search,
  Send,
  SlidersHorizontal,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionModeSetting, SettingsPatch, StartupResume, WebhookKind } from '../../shared/protocol';
import { api } from '../lib/api';
import { useBoardUi } from '../lib/board-ui';
import { setSoundEnabled, testSound, useSoundEnabled } from '../lib/notify';
import { PREF_LIMITS, usePrefs, type DefaultSidebarTab } from '../lib/prefs';
import { useServerSettings } from '../lib/settings';
import { useBoard } from '../lib/store';
import { DEFAULT_THEME, THEMES, setTheme, useTheme } from '../lib/theme';
import { Highlight, Note, Segmented, Select, SmallButton, Stepper, TextSave, Toggle } from './settings/fields';

// Settings tab: general first, then increasingly specific sections. Every row is data
// (label, description, keywords) so the search box can filter across all of them.

type SectionKey = 'general' | 'notifications' | 'board' | 'terminals' | 'claude' | 'browser' | 'advanced';

const SECTIONS: { key: SectionKey; label: string; icon: LucideIcon; note?: string }[] = [
  { key: 'general', label: 'General', icon: SlidersHorizontal },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'board', label: 'Board', icon: LayoutGrid },
  { key: 'terminals', label: 'Terminals', icon: SquareTerminal },
  {
    key: 'claude',
    label: 'Claude Code',
    icon: Bot,
    note: 'Applies to consoles you create or restart from now on. Running consoles keep their current settings.',
  },
  { key: 'browser', label: 'Browser tiles', icon: Globe },
  { key: 'advanced', label: 'Advanced', icon: Wrench },
];

interface SettingDef {
  id: string;
  section: SectionKey;
  label: string;
  description: string;
  keywords?: string;
  Control?: () => ReactNode; // right-aligned control
  Below?: () => ReactNode; // full-width content under the text (inputs, warnings, cards)
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
    <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Theme">
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
            className={`rounded-lg border p-2 text-left transition-colors
                        hover:border-line-strong
                        ${active ? 'border-accent ring-1 ring-accent/50' : 'border-line'}`}
          >
            <span
              className="flex h-9 overflow-hidden rounded-md border border-black/20"
              style={{ background: t.swatches[0] }}
              aria-hidden
            >
              <span className="m-1.5 w-7 rounded-sm" style={{ background: t.swatches[1] }} />
              <span className="flex flex-1 items-end gap-1 p-1.5">
                {t.swatches.slice(2).map((c) => (
                  <span key={c} className="size-2.5 rounded-full" style={{ background: c }} />
                ))}
              </span>
            </span>
            <span className="mt-1.5 block text-[12px] font-semibold text-fg">{t.name}</span>
            <span className="line-clamp-2 block text-[11px] leading-[14px] text-fg-subtle">{t.description}</span>
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
  { value: 'settings', label: 'Settings' },
];

function SidebarTabControl() {
  const value = usePrefs((s) => s.prefs.defaultSidebarTab);
  return (
    <Select
      label="Sidebar opens on"
      value={value}
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
      'Theme, sound, board, terminal and Claude Code settings go back to their defaults, and the Slack and Discord webhooks are removed. Your consoles and projects are not touched.',
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
  { id: 'theme', section: 'general', label: 'Theme', description: 'Colors for the board, panels and terminals.', keywords: 'appearance color colour dark light ember midnight aurora paper look', Below: ThemeCards },
  { id: 'startup', section: 'general', label: 'On startup', description: 'What to do with saved conversations when AgentArmy starts.', keywords: 'resume restore relaunch reopen launch boot', Control: StartupControl },
  { id: 'sidebar-tab', section: 'general', label: 'Sidebar opens on', description: 'The tab shown when the app loads.', keywords: 'default tab panel start', Control: SidebarTabControl },

  { id: 'desktop', section: 'notifications', label: 'Desktop notifications', description: 'Pop-up when an agent needs you while this tab is in the background.', keywords: 'alert permission browser popup notify', Control: DesktopControl, Below: DesktopBelow },
  { id: 'sound', section: 'notifications', label: 'Sound', description: 'Short chime when an agent needs you.', keywords: 'audio chime beep mute alert', Control: SoundControl },
  { id: 'volume', section: 'notifications', label: 'Volume', description: 'Chime loudness. Release the slider to hear it.', keywords: 'sound audio loud quiet', Control: VolumeControl },
  { id: 'slack', section: 'notifications', label: 'Slack', description: 'Post to a Slack channel when an agent needs you (incoming webhook, max one per agent every 30 s).', keywords: 'webhook chat message phone remote', Below: () => <WebhookBelow kind="slack" /> },
  { id: 'discord', section: 'notifications', label: 'Discord', description: 'Post to a Discord channel when an agent needs you (channel webhook, max one per agent every 30 s).', keywords: 'webhook chat message phone remote', Below: () => <WebhookBelow kind="discord" /> },

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

  { id: 'browser-path', section: 'browser', label: 'Browser executable', description: 'Chrome, Edge or Chromium used for browser tiles.', keywords: 'chrome edge chromium path binary AGENTARMY_BROWSER_PATH web', Below: pathBelow('browserPath', 'Browser path', 'Auto-detect Chrome / Edge / Chromium') },

  { id: 'data-dir', section: 'advanced', label: 'Data folder', description: 'Board, settings and token files live here.', keywords: 'storage state json home AGENTARMY_HOME location', Below: DataDirBelow },
  { id: 'port', section: 'advanced', label: 'Server port', description: 'Change it with agentarmy --port <n>.', keywords: 'network localhost url', Control: PortControl },
  { id: 'token', section: 'advanced', label: 'Access token', description: 'Rotate it if the board URL leaked: restart with --new-token, then open the new URL.', keywords: 'security rotate secret url new-token', Below: TokenBelow },
  { id: 'reset', section: 'advanced', label: 'Reset all settings', description: 'Back to defaults, in this browser and on the server.', keywords: 'defaults restore clear', Control: ResetControl },
  { id: 'about', section: 'advanced', label: 'About', description: 'Free, open-source (MIT) board for Claude Code agents.', keywords: 'version license update', Control: AboutControl },
];

function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(def: SettingDef, tokens: string[]): boolean {
  const section = SECTIONS.find((s) => s.key === def.section)!.label;
  const hay = `${def.label} ${def.description} ${def.keywords ?? ''} ${section}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function Row({ def, tokens }: { def: SettingDef; tokens: string[] }) {
  const { Control, Below } = def;
  return (
    <div data-setting-id={def.id} className="border-t border-line/70 px-3 py-2.5 first:border-t-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] leading-5 font-medium text-fg">
            <Highlight text={def.label} tokens={tokens} />
          </div>
          <div className="text-[11.5px] leading-4 text-fg-subtle">
            <Highlight text={def.description} tokens={tokens} />
          </div>
        </div>
        {Control && <Control />}
      </div>
      {Below && <Below />}
    </div>
  );
}

export function SettingsPanel() {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const error = useServerSettings((s) => s.error);
  const tokens = useMemo(() => searchTokens(query), [query]);
  const visible = useMemo(() => SETTINGS.filter((d) => matches(d, tokens)), [tokens]);
  const searching = tokens.length > 0;

  useEffect(() => {
    void useServerSettings.getState().load();
  }, []);

  // '/' or Ctrl+F focuses the search while the panel is open (never stolen from a terminal)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
      const find =
        (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f' &&
        !(e.target instanceof HTMLElement && e.target.closest('.xterm'));
      if (!slash && !find) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const jumpTo = (key: SectionKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    requestAnimationFrame(() =>
      document.getElementById(`settings-section-${key}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
  };

  const toggle = (key: SectionKey) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div data-testid="settings-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-3 pt-3 pb-2.5">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-canvas px-2.5
                          focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-subtle" />
          <input
            ref={searchRef}
            data-testid="settings-search"
            type="search"
            value={query}
            placeholder="Search settings…"
            aria-label="Search settings"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-subtle
                       [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
              className="grid size-5 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X size={12} />
            </button>
          ) : (
            <kbd className="rounded border border-line px-1 font-mono text-[10px] text-fg-subtle">/</kbd>
          )}
        </label>
        {searching ? (
          <div data-testid="settings-result-count" className="mt-2 text-[11.5px] text-fg-subtle">
            {visible.length} {visible.length === 1 ? 'result' : 'results'}
          </div>
        ) : (
          <nav aria-label="Settings sections" className="mt-2 flex flex-wrap gap-1">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => jumpTo(s.key)}
                className="rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-muted
                           hover:border-line-strong hover:text-fg"
              >
                {s.label}
              </button>
            ))}
          </nav>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-6">
        {error && <Note tone="danger">Could not load server settings: {error}</Note>}
        {searching && visible.length === 0 && (
          <div className="px-3 py-10 text-center text-[12.5px] text-fg-subtle">
            No settings match “{query.trim()}”.
          </div>
        )}
        {SECTIONS.map((section) => {
          const rows = visible.filter((d) => d.section === section.key);
          if (rows.length === 0) return null;
          const open = searching || !collapsed.has(section.key);
          const Icon = section.icon;
          return (
            <section
              key={section.key}
              id={`settings-section-${section.key}`}
              data-section={section.key}
              className="mb-2 scroll-mt-2 rounded-xl border border-line bg-surface-2"
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => !searching && toggle(section.key)}
                className="flex h-9 w-full items-center gap-2 px-3 text-left"
              >
                <Icon size={14} className="text-accent" />
                <span className="text-[11px] font-semibold tracking-wider text-fg-muted uppercase">{section.label}</span>
                {searching && <span className="text-[11px] text-fg-subtle tabular-nums">{rows.length}</span>}
                {!searching && (
                  <ChevronDown
                    size={14}
                    className={`ml-auto text-fg-subtle transition-transform ${open ? '' : '-rotate-90'}`}
                  />
                )}
              </button>
              {open && (
                <div className="border-t border-line">
                  {section.note && !searching && (
                    <p className="mx-3 mt-2.5 rounded-md bg-accent/10 px-2 py-1.5 text-[11.5px] leading-4 text-fg-muted">
                      {section.note}
                    </p>
                  )}
                  {rows.map((def) => (
                    <Row key={def.id} def={def} tokens={tokens} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {!searching && (
          <p className="px-3 pt-1 text-[11px] text-fg-subtle">
            Theme, sound, board and terminal settings are saved in this browser. Claude Code, startup, webhook and
            browser settings are saved on the server for every tab.
          </p>
        )}
      </div>
    </div>
  );
}
