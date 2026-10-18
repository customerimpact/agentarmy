import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  ExternalLink,
  Gauge,
  Info,
  Plug,
  Search,
  Settings2,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useServerSettings } from '../lib/settings';
import { useBoard } from '../lib/store';
import { SECTIONS, SETTINGS, matches, searchTokens, type SettingDef } from './SettingsPanel';
import { Badge, Highlight, Note } from './settings/fields';

// Cursor-style Settings: a large window (or the /?view=settings page) with a searchable left nav
// of categories and, on the right, the selected category's rows grouped into cards.
// The rows themselves live in the SettingsPanel.tsx registry; this file only lays them out.

// ---------- Layout of the registry ----------

// Nav order. Sections not listed here (added later) slot in before Advanced, in registry order.
const ORDER = [
  'general',
  'accounts',
  'appearance',
  'notifications',
  'board',
  'terminals',
  'claude',
  'browser',
  'usage',
  'integrations',
  'advanced',
];

// Nav items that may exist before their section does (Accounts shows a placeholder)
const FALLBACK_NAV: Record<string, { label: string; icon: LucideIcon }> = {
  accounts: { label: 'Accounts', icon: UsersRound },
  usage: { label: 'Usage & Budgets', icon: Gauge },
  integrations: { label: 'Integrations', icon: Plug },
};
const ALWAYS_SHOWN = new Set(['accounts']);

const SUBTITLES: Record<string, string> = {
  general: 'Startup behaviour and the sidebar.',
  accounts: 'Claude accounts used by your agents.',
  appearance: 'How AgentArmy looks in this browser.',
  notifications: 'How AgentArmy tells you an agent needs you or is stuck.',
  board: 'Snapping, layout and motion on the canvas.',
  terminals: 'Text and scrollback of every console.',
  claude: 'Defaults for the claude command each console runs.',
  browser: 'Browser tiles and automatic dev-server previews.',
  usage: 'Token budgets and what happens when one runs out.',
  integrations: 'Send alerts and recaps to Slack, Discord or your phone.',
  advanced: 'Server details, access token and reset.',
};

// Card groups, badges and category moves for registry rows. Rows can also set `group` / `badge`
// themselves; rows not listed share one unlabeled card in their section.
const LAYOUT: Record<string, { category?: string; group?: string; badge?: SettingDef['badge'] }> = {
  desktop: { group: 'Alerts' },
  sound: { group: 'Alerts' },
  volume: { group: 'Alerts' },
  'stuck-alerts': { group: 'Stuck agents' },
  'stall-minutes': { group: 'Stuck agents' },
  'long-turn-minutes': { group: 'Stuck agents' },
  slack: { category: 'integrations', group: 'Chat webhooks' },
  discord: { category: 'integrations', group: 'Chat webhooks' },
  ntfy: { category: 'integrations', group: 'Phone' },
  'recap-send': { category: 'integrations', group: 'Daily recap' },
  snap: { group: 'Snapping' },
  'grid-size': { group: 'Snapping' },
  'console-size': { group: 'Layout' },
  'arrange-columns': { group: 'Layout' },
  'arrange-gap': { group: 'Layout' },
  minimap: { group: 'Display' },
  'reduce-motion': { group: 'Display' },
  'font-size': { group: 'Text' },
  'line-height': { group: 'Text' },
  'cursor-blink': { group: 'Text' },
  scrollback: { group: 'History' },
  model: { group: 'Agent defaults', badge: 'new-agents' },
  'permission-mode': { group: 'Agent defaults', badge: 'new-agents' },
  'extra-args': { group: 'Launch', badge: 'new-agents' },
  'claude-path': { group: 'Launch', badge: 'new-agents' },
  'task-list': { group: 'Features', badge: 'new-agents' },
  'api-key': { group: 'Features', badge: 'new-agents' },
  'budget-daily': { group: 'Token budgets' },
  'budget-5h': { group: 'Token budgets' },
  'budget-weekly': { group: 'Token budgets' },
  'budget-projects': { group: 'Per project' },
  'budget-pause': { group: 'When a budget runs out' },
  'browser-path': { group: 'Browser' },
  'auto-preview': { group: 'Dev previews' },
  'preview-mode': { group: 'Dev previews' },
  'data-dir': { group: 'Server' },
  port: { group: 'Server', badge: 'restart' },
  token: { group: 'Server' },
  reset: { group: 'Reset' },
  about: { group: 'About' },
};

const BADGES: Record<NonNullable<SettingDef['badge']>, { text: string; tone: 'info' | 'warn' }> = {
  'new-agents': { text: 'Applies to new agents', tone: 'info' },
  restart: { text: 'Restart needed', tone: 'warn' },
};

const categoryOf = (def: SettingDef): string => LAYOUT[def.id]?.category ?? def.section;
const groupOf = (def: SettingDef): string => def.group ?? LAYOUT[def.id]?.group ?? '';
const badgeOf = (def: SettingDef) => def.badge ?? LAYOUT[def.id]?.badge;

interface Category {
  key: string;
  label: string;
  icon: LucideIcon;
  note?: string;
}

// Nav = every section in the registry (deduped) + the fixed ones above, in ORDER
function buildCategories(): Category[] {
  const byKey = new Map<string, Category>();
  for (const s of SECTIONS) if (!byKey.has(s.key)) byKey.set(s.key, { ...s });
  const used = new Set(SETTINGS.map(categoryOf));
  for (const key of [...ORDER, ...used]) {
    if (byKey.has(key) || !(used.has(key) || ALWAYS_SHOWN.has(key))) continue;
    const fallback = FALLBACK_NAV[key];
    byKey.set(key, { key, label: fallback?.label ?? key[0].toUpperCase() + key.slice(1), icon: fallback?.icon ?? Settings2 });
  }
  const registryOrder = [...byKey.keys()];
  const rank = (key: string) => {
    const i = ORDER.indexOf(key);
    if (i >= 0) return i;
    // Unknown sections go just before Advanced
    return ORDER.indexOf('advanced') - 0.5 + registryOrder.indexOf(key) / 1000;
  };
  return [...byKey.values()]
    .filter((c) => used.has(c.key) || ALWAYS_SHOWN.has(c.key) || SECTIONS.some((s) => s.key === c.key))
    .sort((a, b) => rank(a.key) - rank(b.key));
}

// Card order where registry order would read oddly; unlisted groups follow in registry order
const GROUP_ORDER: Record<string, string[]> = {
  integrations: ['Chat webhooks', 'Phone', 'Daily recap'],
};

function groupRows(category: string, rows: SettingDef[]): { label: string; rows: SettingDef[] }[] {
  const groups: { label: string; rows: SettingDef[] }[] = [];
  for (const def of rows) {
    const label = groupOf(def);
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.rows.push(def);
    else groups.push({ label, rows: [def] });
  }
  const order = GROUP_ORDER[category] ?? [];
  const rank = (label: string) => (order.includes(label) ? order.indexOf(label) : order.length);
  return groups.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g.label) - rank(b.g.label) || a.i - b.i).map((x) => x.g);
}

// ---------- Remembered category ----------

const CATEGORY_KEY = 'agentarmy.settings.category';

function loadCategory(): string | null {
  try {
    return localStorage.getItem(CATEGORY_KEY);
  } catch {
    return null;
  }
}

function saveCategory(key: string): void {
  try {
    localStorage.setItem(CATEGORY_KEY, key);
  } catch {
    // storage blocked: the window just opens on General next time
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

// ---------- Pieces ----------

function Row({ def, tokens }: { def: SettingDef; tokens: string[] }) {
  const { Control, Below } = def;
  const badge = badgeOf(def);
  return (
    <div data-setting-id={def.id} className="flex min-h-14 flex-col justify-center px-4 py-3.5">
      <div className="flex items-center gap-x-6 gap-y-2.5 max-sm:flex-wrap">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 font-medium text-fg">
            <Highlight text={def.label} tokens={tokens} />
            {badge && <Badge tone={BADGES[badge].tone}>{BADGES[badge].text}</Badge>}
          </div>
          <div className="mt-0.5 text-[12px] leading-[17px] text-fg-subtle">
            <Highlight text={def.description} tokens={tokens} />
          </div>
        </div>
        {Control && (
          <div className="flex shrink-0 items-center">
            <Control />
          </div>
        )}
      </div>
      {Below && <Below />}
    </div>
  );
}

function Card({ children, testSection }: { children: ReactNode; testSection?: string }) {
  return (
    <div
      data-section={testSection}
      className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-elevated shadow-[0_1px_2px_var(--aa-shadow)]"
    >
      {children}
    </div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 px-1 text-[11px] font-semibold tracking-[0.07em] text-fg-subtle uppercase">{children}</h3>;
}

function ComingSoon({ category }: { category: Category }) {
  const Icon = category.icon;
  return (
    <div
      data-testid="settings-coming-soon"
      className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-12 text-center"
    >
      <span className="grid size-11 place-items-center rounded-full bg-accent/12 text-accent">
        <Icon size={20} />
      </span>
      <p className="mt-3 text-[14px] font-semibold text-fg">Coming soon</p>
      <p className="mt-1 max-w-sm text-[12.5px] leading-[18px] text-fg-subtle">
        {category.key === 'accounts'
          ? 'Use more than one Claude account and pick one per agent. This page fills in when account profiles land.'
          : 'Nothing to configure here yet.'}
      </p>
    </div>
  );
}

function Profile() {
  const data = useServerSettings((s) => s.data);
  const billing = data ? (data.settings.useApiKey ? 'API key billing' : 'Claude subscription') : 'Loading…';
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-2 max-sm:hidden">
      <span className="grid size-9 shrink-0 place-items-center rounded-full border border-line-strong bg-elevated">
        <img src="/icon.svg" alt="" className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] leading-[18px] font-semibold text-fg">AgentArmy</span>
        <span className="block truncate text-[11.5px] leading-4 text-fg-subtle" data-testid="settings-profile">
          {billing}
          {data ? ` · v${data.version}` : ''}
        </span>
      </span>
    </div>
  );
}

// ---------- The view (nav + content), shared by the window and the full page ----------

export function SettingsView({ onClose, onPopout }: { onClose?: () => void; onPopout?: () => void }) {
  const categories = useMemo(buildCategories, []);
  const requested = useBoard((s) => s.settingsCategory);
  const [active, setActive] = useState(() => {
    const wanted = requested ?? loadCategory();
    return categories.some((c) => c.key === wanted) ? wanted! : categories[0].key;
  });
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const error = useServerSettings((s) => s.error);
  const tokens = useMemo(() => searchTokens(query), [query]);
  const searching = tokens.length > 0;
  const labelOf = (key: string) => categories.find((c) => c.key === key)?.label ?? key;
  const visible = useMemo(
    () => SETTINGS.filter((d) => matches(d, tokens, labelOf(categoryOf(d)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens],
  );

  useEffect(() => {
    void useServerSettings.getState().load();
  }, []);

  useEffect(() => {
    if (requested && categories.some((c) => c.key === requested)) setActive(requested);
  }, [requested, categories]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [active, searching]);

  // '/' or Ctrl+F focuses the search (never stolen from a field or a nested dialog)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
      const find = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f';
      if (!slash && !find) return;
      if (useBoard.getState().confirm) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (key: string, rowId?: string) => {
    setQuery('');
    setActive(key);
    saveCategory(key);
    if (rowId) {
      requestAnimationFrame(() =>
        contentRef.current?.querySelector(`[data-setting-id="${rowId}"]`)?.scrollIntoView({ block: 'center' }),
      );
    }
  };

  const category = categories.find((c) => c.key === active) ?? categories[0];
  const hitCount = (key: string) => visible.filter((d) => categoryOf(d) === key).length;

  return (
    <div className="flex h-full min-h-0 w-full flex-col sm:flex-row">
      {/* ---------- Left nav ---------- */}
      <aside
        className="flex shrink-0 flex-col gap-3 border-line bg-[color-mix(in_srgb,var(--aa-canvas)_55%,var(--aa-surface))] p-3
                   max-sm:border-b sm:w-60 sm:border-r"
      >
        <Profile />
        <label
          className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 transition-colors
                     focus-within:border-accent"
        >
          <Search size={14} className="shrink-0 text-fg-subtle" />
          <input
            ref={searchRef}
            data-testid="settings-search"
            type="search"
            value={query}
            autoFocus
            placeholder="Search settings"
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

        <nav
          aria-label="Settings categories"
          className="aa-scroll -mx-1 flex min-h-0 gap-0.5 overflow-x-auto px-1 max-sm:pb-0.5 sm:flex-1 sm:flex-col sm:overflow-y-auto"
        >
          {categories.map((c) => {
            const Icon = c.icon;
            const current = !searching && c.key === category.key;
            const hits = searching ? hitCount(c.key) : 0;
            return (
              <button
                key={c.key}
                type="button"
                data-testid={`settings-nav-${c.key}`}
                aria-current={current ? 'page' : undefined}
                onClick={() => go(c.key)}
                className={`flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] whitespace-nowrap transition-colors
                            focus-visible:outline-2 focus-visible:outline-accent
                            ${current ? 'bg-hover font-medium text-fg' : 'text-fg-muted hover:bg-hover/60 hover:text-fg'}
                            ${searching && hits === 0 ? 'opacity-45' : ''}`}
              >
                <Icon size={15} className={current ? 'text-accent' : 'text-fg-subtle'} />
                <span className="truncate">{c.label}</span>
                {searching && hits > 0 && (
                  <span className="ml-auto rounded-full bg-accent/15 px-1.5 text-[10.5px] leading-4 font-semibold text-accent tabular-nums">
                    {hits}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <p className="px-2 text-[11px] leading-4 text-fg-subtle max-sm:hidden">
          Changes save automatically.
          <br />
          <kbd className="font-mono">Ctrl</kbd> <kbd className="font-mono">,</kbd> opens settings, <kbd className="font-mono">Esc</kbd>{' '}
          closes.
        </p>
      </aside>

      {/* ---------- Content ---------- */}
      <div data-testid="settings-panel" className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
          {onPopout && (
            <button
              type="button"
              data-testid="settings-popout"
              title="Open settings in its own window"
              aria-label="Open settings in its own window"
              onClick={onPopout}
              className="grid size-8 place-items-center rounded-lg text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <ExternalLink size={15} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              data-testid="settings-close"
              title="Close (Esc)"
              aria-label="Close settings"
              onClick={onClose}
              className="grid size-8 place-items-center rounded-lg text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X size={17} />
            </button>
          )}
        </div>

        <div ref={contentRef} className="aa-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-5 pt-7 pb-12 sm:px-10 sm:pt-9">
            {error && <Note tone="danger">Could not load server settings: {error}</Note>}

            {searching ? (
              <>
                <h1 className="pr-20 text-[22px] leading-7 font-semibold tracking-tight text-fg">Search results</h1>
                <p data-testid="settings-result-count" className="mt-1 text-[13px] text-fg-muted">
                  {visible.length} {visible.length === 1 ? 'result' : 'results'}
                </p>
                {visible.length === 0 && (
                  <div className="mt-8 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center text-[13px] text-fg-subtle">
                    No settings match “{query.trim()}”.
                  </div>
                )}
                {categories.map((c) => {
                  const rows = visible.filter((d) => categoryOf(d) === c.key);
                  if (rows.length === 0) return null;
                  const Icon = c.icon;
                  return (
                    <section key={c.key} className="mt-7">
                      <button
                        type="button"
                        onClick={() => go(c.key, rows[0].id)}
                        className="group mb-2 flex items-center gap-2 px-1 text-[12px] font-semibold text-fg-muted hover:text-fg"
                      >
                        <Icon size={14} className="text-accent" />
                        {c.label}
                        <span className="text-fg-subtle tabular-nums">{rows.length}</span>
                        <ArrowUpRight size={13} className="opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                      <Card testSection={c.key}>
                        {rows.map((def) => (
                          <Row key={def.id} def={def} tokens={tokens} />
                        ))}
                      </Card>
                    </section>
                  );
                })}
              </>
            ) : (
              <CategoryPage category={category} />
            )}

            <p className="mt-10 px-1 text-[11.5px] leading-4 text-fg-subtle">
              Theme, sound, board and terminal settings are saved in this browser. Claude Code, startup, webhook and
              browser settings are saved on the server for every tab.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryPage({ category }: { category: Category }) {
  const rows = SETTINGS.filter((d) => categoryOf(d) === category.key);
  const groups = groupRows(category.key, rows);
  return (
    <>
      <h1 data-testid="settings-title" className="pr-20 text-[22px] leading-7 font-semibold tracking-tight text-fg">
        {category.label}
      </h1>
      {SUBTITLES[category.key] && <p className="mt-1 text-[13px] text-fg-muted">{SUBTITLES[category.key]}</p>}
      {category.note && (
        <p className="mt-4 flex gap-2 rounded-lg border border-accent/25 bg-accent/8 px-3 py-2.5 text-[12px] leading-[18px] text-fg-muted">
          <Info size={14} className="mt-0.5 shrink-0 text-accent" />
          {category.note}
        </p>
      )}
      {rows.length === 0 && (
        <div className="mt-7">
          <ComingSoon category={category} />
        </div>
      )}
      {groups.map((g, i) => (
        <section key={g.label || `_${i}`} className="mt-7">
          {g.label && <GroupLabel>{g.label}</GroupLabel>}
          <Card testSection={category.key}>
            {g.rows.map((def) => (
              <Row key={def.id} def={def} tokens={[]} />
            ))}
          </Card>
        </section>
      ))}
    </>
  );
}

// ---------- Window (overlay on the board) ----------

const POPOUT_NAME = 'agentarmy-settings';

export function openSettingsPage(): void {
  const width = Math.min(1100, window.screen.availWidth);
  const height = Math.min(760, window.screen.availHeight);
  const win = window.open('/?view=settings', POPOUT_NAME, `popup,width=${width},height=${height}`);
  if (!win) useBoard.getState().toast('The pop-up was blocked. Allow pop-ups for this site and try again.');
}

function SettingsWindow() {
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => useBoard.getState().closeSettings();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      // Nested dialogs (Reset… confirm) handle their own Esc in the capture phase
      if (e.defaultPrevented || useBoard.getState().confirm) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      // Keep Tab inside the window
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = [
          ...panelRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const inside = panelRef.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(8_6_5/0.62)] backdrop-blur-[3px] min-[800px]:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-window"
        className="aa-pop flex h-full w-full overflow-hidden bg-surface outline-none
                   min-[800px]:h-[min(720px,100%)] min-[800px]:max-w-[1100px] min-[800px]:rounded-2xl
                   min-[800px]:border min-[800px]:border-line-strong
                   min-[800px]:shadow-[0_30px_80px_-20px_rgb(0_0_0/0.7),0_0_60px_-20px_color-mix(in_srgb,var(--aa-glow)_30%,transparent)]"
      >
        <SettingsView
          onClose={close}
          onPopout={() => {
            close();
            openSettingsPage();
          }}
        />
      </div>
    </div>
  );
}

// Mounted once in the board: renders the window when open and owns Ctrl+, / Cmd+,
export function SettingsHost() {
  const open = useBoard((s) => s.settingsOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key !== ',') return;
      const s = useBoard.getState();
      if (s.confirm || s.newAgentOpen) return;
      // Capture phase + stopPropagation: works even while a terminal has focus
      e.preventDefault();
      e.stopPropagation();
      if (s.settingsOpen) s.closeSettings();
      else s.openSettings();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return open ? <SettingsWindow /> : null;
}

// /?view=settings: the same view as a full page (pop-out window or a browser tab)
export function SettingsPage() {
  useEffect(() => {
    document.title = 'Settings · AgentArmy';
  }, []);
  return (
    <div className="h-full bg-surface" data-testid="settings-page">
      <SettingsView />
    </div>
  );
}
