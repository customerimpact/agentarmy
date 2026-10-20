import { useEffect } from 'react';
import {
  Brain,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { attentionCount } from '../lib/fleet';
import { useBoard, type SidebarTab } from '../lib/store';
import { openPopout } from '../lib/popout';
import { openMemory } from '../lib/handoff-memory';
import { ActionsPanel } from './ActionsPanel';
import { AgentsPanel } from './AgentsPanel';
import { ProgressPanel } from './ProgressPanel';
import { AccountSwitcherChip } from './AccountChip';

const TABS: { key: SidebarTab; label: string; icon: LucideIcon; hotkey: string }[] = [
  { key: 'agents', label: 'Agents', icon: Users, hotkey: '1' },
  { key: 'actions', label: 'Actions', icon: Inbox, hotkey: '2' },
  { key: 'progress', label: 'Progress', icon: ListChecks, hotkey: '3' },
  // Settings opens the Settings window (also Ctrl+,), it is not a panel in the sidebar
  { key: 'settings', label: 'Settings', icon: Settings, hotkey: '4' },
];

// Same rule as use-shortcuts: never steal keys from terminals or text fields
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function useSidebarKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useBoard.getState();
      if (s.newAgentOpen || s.confirm || s.templatesOpen || s.missionMapOpen || s.helpOpen) return;
      if (isTypingTarget(e.target) || document.querySelector('[role="dialog"]')) return;
      const tab = TABS.find((t) => t.hotkey === e.key);
      if (tab) {
        e.preventDefault();
        s.setSidebarTab(tab.key);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        s.setMissionMapOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Badge({ count, tone }: { count: number; tone: 'needs' | 'muted' }) {
  if (count <= 0) return null;
  return (
    <span
      className={`grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] leading-none font-bold tabular-nums
                  ${tone === 'needs' ? 'bg-needs text-black' : 'bg-hover text-fg-muted'}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function useCounts() {
  const consoles = useBoard((s) => s.consoles);
  const actions = useBoard((s) => s.actions);
  return {
    agents: Object.keys(consoles).length,
    actions: attentionCount(consoles, actions),
    working: Object.values(consoles).filter((c) => c.status === 'working').length,
  };
}

const iconButton = `grid size-8 place-items-center rounded-md text-fg-muted
                    hover:bg-hover hover:text-fg`;

export function Sidebar() {
  const open = useBoard((s) => s.sidebarOpen);
  const tab = useBoard((s) => s.sidebarTab);
  const settingsOpen = useBoard((s) => s.settingsOpen);
  const counts = useCounts();
  const { setSidebarOpen, setSidebarTab, setMissionMapOpen } = useBoard.getState();
  useSidebarKeys();

  if (!open) {
    return (
      <aside
        data-testid="sidebar-rail"
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3"
      >
        <button
          type="button"
          title="Show sidebar"
          aria-label="Show sidebar"
          onClick={() => setSidebarOpen(true)}
          className={iconButton}
        >
          <PanelLeftOpen size={16} />
        </button>
        <span className="my-1 h-px w-6 bg-line" />
        {TABS.map((t) => {
          const Icon = t.icon;
          const count =
            t.key === 'actions' ? counts.actions : t.key === 'agents' ? counts.working : 0;
          return (
            <button
              key={t.key}
              type="button"
              title={t.key === 'settings' ? 'Settings (4 or Ctrl+,)' : `${t.label} (${t.hotkey})`}
              aria-label={t.label}
              onClick={() => setSidebarTab(t.key)}
              className={`relative ${iconButton}`}
            >
              <Icon size={16} />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5">
                  <Badge count={count} tone={t.key === 'actions' ? 'needs' : 'muted'} />
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          title="Mission Map (M)"
          aria-label="Mission Map"
          onClick={() => setMissionMapOpen(true)}
          className={iconButton}
        >
          <Network size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="sidebar"
      className="flex w-80 shrink-0 flex-col border-r border-line bg-surface"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <img src="/icon.svg" alt="" className="size-5" />
        <span className="font-semibold tracking-tight text-fg">GridHive</span>
        <span className="ml-auto" />
        <AccountSwitcherChip />
        <button
          type="button"
          data-testid="open-memory"
          title="Project memory: notes you push into agents"
          aria-label="Project memory"
          onClick={() => openMemory()}
          className={iconButton}
        >
          <Brain size={15} />
        </button>
        <button
          type="button"
          data-testid="open-mission-map"
          title="Mission Map (M)"
          onClick={() => setMissionMapOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          <Network size={14} />
          Map
        </button>
        <button
          type="button"
          data-testid="open-focus-wall"
          title="Focus wall: every agent that needs you or is working, in its own window"
          aria-label="Focus wall"
          onClick={() => openPopout({ kind: 'focus' })}
          className={iconButton}
        >
          <LayoutDashboard size={15} />
        </button>
        <button
          type="button"
          title="Hide sidebar"
          aria-label="Hide sidebar"
          onClick={() => setSidebarOpen(false)}
          className={iconButton}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div role="tablist" className="flex shrink-0 gap-1 border-b border-line px-2 pt-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.key === 'settings' ? settingsOpen : tab === t.key;
          // Settings is a gear-only button at the end so the three work tabs keep their room
          const iconOnly = t.key === 'settings';
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              data-testid={`sidebar-tab-${t.key}`}
              aria-selected={active}
              aria-label={t.label}
              title={t.key === 'settings' ? 'Settings (4 or Ctrl+,)' : `${t.label} (${t.hotkey})`}
              onClick={() => setSidebarTab(t.key)}
              className={`relative flex items-center justify-center gap-1.5 rounded-t-md px-2 pt-1.5 pb-2 text-[12.5px] font-medium transition-colors
                          ${iconOnly ? 'flex-none' : 'flex-1'}
                          ${active ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'}`}
            >
              <Icon size={14} />
              {!iconOnly && t.label}
              {t.key === 'actions' && <Badge count={counts.actions} tone="needs" />}
              {t.key === 'agents' && counts.agents > 0 && (
                <span className="text-[11px] text-fg-subtle tabular-nums">{counts.agents}</span>
              )}
              <span
                className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-colors ${active ? 'bg-accent' : 'bg-transparent'}`}
              />
            </button>
          );
        })}
      </div>

      {tab === 'agents' && <AgentsPanel />}
      {tab === 'actions' && <ActionsPanel />}
      {tab === 'progress' && <ProgressPanel />}
    </aside>
  );
}
