import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  LoaderCircle,
  Monitor,
  Plus,
  Rocket,
  SendHorizontal,
  Smartphone,
  Users,
} from 'lucide-react';
import { AGENT_META, type AgentKind } from '../../shared/agents';
import type { ActionItem, ConsoleInfo, FsListResponse, Template } from '../../shared/protocol';
import { folderName, groupByProject, relativeTime } from '../lib/fleet';
import { STATUS_META } from '../lib/status';
import { guessDeviceName, PhoneApiError, phoneApi, phoneSocket, usePhone } from './phone-api';
import { PhoneTerminal } from './PhoneTerminal';

type Phase = 'loading' | 'unpaired' | 'pairing' | 'ready';

// Pairing link from the QR code: http://<computer>:<port>/#pair=<code>
function takePairCode(): string | null {
  const match = /^#pair=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (match) history.replaceState(null, '', location.pathname);
  return match ? match[1] : null;
}

export function PhoneApp() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = takePairCode();
    const boot = async () => {
      if (code) {
        setPhase('pairing');
        try {
          await phoneApi.pair(code, guessDeviceName());
        } catch (e) {
          setError((e as Error).message);
        }
      }
      try {
        await phoneApi.me();
        usePhone.getState().load(await phoneApi.state());
        phoneSocket.start();
        setPhase('ready');
      } catch (e) {
        if (e instanceof PhoneApiError && e.status === 401) setPhase('unpaired');
        else {
          setError((e as Error).message);
          setPhase('unpaired');
        }
      }
    };
    void boot();
    // Scanning a new QR code while this page is open only changes the hash
    const onHash = () => {
      if (/^#pair=/.test(location.hash)) location.reload();
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      phoneSocket.stop();
    };
  }, []);

  if (phase === 'loading' || phase === 'pairing') {
    return (
      <Centered>
        <LoaderCircle className="animate-spin text-accent" size={22} />
        <p className="mt-3 text-fg-muted">{phase === 'pairing' ? 'Pairing with your computer…' : 'Connecting…'}</p>
      </Centered>
    );
  }
  if (phase === 'unpaired') {
    return (
      <Centered>
        <img src="/icon.svg" alt="" className="size-14" />
        <h1 className="mt-4 text-[20px] font-semibold text-fg">Pair this phone</h1>
        <p className="mt-2 max-w-xs text-fg-muted">
          On your computer, open GridHive → Settings → <b className="text-fg">Phone</b> and scan the QR code with this phone's camera.
        </p>
        {error && (
          <p data-testid="phone-pair-error" className="mt-4 max-w-xs text-[13px] text-error">
            {error}
          </p>
        )}
      </Centered>
    );
  }
  return <Ready />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-col items-center justify-center p-6 text-center">{children}</div>;
}

function Ready() {
  const screen = usePhone((s) => s.screen);
  if (screen.kind === 'console') return <ConsoleScreen id={screen.id} />;
  if (screen.kind === 'launch') return <LaunchScreen />;
  return <FleetScreen />;
}

function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  const connected = usePhone((s) => s.connected);
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface/95 px-3 pt-[max(env(safe-area-inset-top),8px)] pb-2 backdrop-blur">
      {onBack ? (
        <button type="button" aria-label="Back" onClick={onBack} className="grid size-9 place-items-center rounded-lg text-fg-muted active:bg-hover">
          <ArrowLeft size={18} />
        </button>
      ) : (
        <img src="/icon.svg" alt="" className="size-7" />
      )}
      <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold text-fg">{title}</h1>
      <span
        className={`size-2 rounded-full ${connected ? 'bg-resting' : 'bg-error'}`}
        title={connected ? 'Connected to your computer' : 'Reconnecting…'}
        data-testid="phone-connection"
        data-connected={connected}
      />
      {right}
    </header>
  );
}

function openActions(actions: Record<string, ActionItem>): ActionItem[] {
  return Object.values(actions)
    .filter((a) => !a.resolvedAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function FleetScreen() {
  const consoles = usePhone((s) => s.consoles);
  const projects = usePhone((s) => s.projects);
  const actions = usePhone((s) => s.actions);
  const go = usePhone((s) => s.go);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const list = Object.values(consoles);
  const { groups, ungrouped } = useMemo(() => groupByProject(list, projects), [consoles, projects]);
  const pending = openActions(actions);
  const working = list.filter((c) => c.status === 'working').length;

  return (
    <div className="flex min-h-full flex-col">
      <Header title="GridHive" />
      <main className="flex-1 space-y-5 px-3 py-3 pb-28">
        <p className="text-[13px] text-fg-muted" data-testid="phone-summary">
          {list.length} {list.length === 1 ? 'agent' : 'agents'} · {working} working · {pending.length} {pending.length === 1 ? 'needs' : 'need'} you
        </p>
        {pending.length > 0 && (
          <section>
            <h2 className="aa-label mb-2 text-needs">Needs you</h2>
            <div className="space-y-2">
              {pending.map((a) => (
                <ActionCard key={a.id} action={a} consoleName={a.consoleId ? consoles[a.consoleId]?.name : undefined} />
              ))}
            </div>
          </section>
        )}
        {groups
          .filter((g) => g.consoles.length > 0)
          .map((g) => (
            <section key={g.project.id}>
              <h2 className="aa-label mb-2 text-fg-subtle">{g.project.name}</h2>
              <AgentList consoles={g.consoles} now={now} onOpen={(id) => go({ kind: 'console', id })} />
            </section>
          ))}
        {ungrouped.length > 0 && (
          <section>
            {groups.some((g) => g.consoles.length > 0) && <h2 className="aa-label mb-2 text-fg-subtle">Other agents</h2>}
            <AgentList consoles={ungrouped} now={now} onOpen={(id) => go({ kind: 'console', id })} />
          </section>
        )}
        {list.length === 0 && (
          <p className="py-10 text-center text-fg-muted">No agents yet. Launch a team and watch it work on your computer.</p>
        )}
      </main>
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),10px)] backdrop-blur">
        <button
          type="button"
          data-testid="phone-launch-open"
          onClick={() => go({ kind: 'launch' })}
          className="aa-btn-primary flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[15px] font-semibold"
        >
          <Rocket size={16} /> Launch agents
        </button>
      </div>
    </div>
  );
}

function AgentList({ consoles, now, onOpen }: { consoles: ConsoleInfo[]; now: number; onOpen: (id: string) => void }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {consoles.map((c) => {
        const meta = STATUS_META[c.status];
        return (
          <li key={c.id}>
            <button
              type="button"
              data-testid="phone-agent"
              data-console-id={c.id}
              onClick={() => onOpen(c.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-hover"
            >
              <span className={`size-2.5 shrink-0 rounded-full ${meta.dot}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-semibold text-fg">{c.name}</span>
                  <span className="truncate text-[12px] text-fg-subtle">
                    {AGENT_META[c.agent ?? 'claude'].short}
                    {c.role ? ` · ${c.role}` : ''}
                  </span>
                </span>
                <span className="block truncate text-[12px] text-fg-muted">
                  {c.status === 'working' && c.activity ? c.activity : `${meta.label} · ${folderName(c.cwd)}`}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-fg-subtle">{relativeTime(c.statusChangedAt, now)}</span>
              <ChevronRight size={15} className="shrink-0 text-fg-subtle" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ActionCard({ action, consoleName }: { action: ActionItem; consoleName?: string }) {
  const go = usePhone((s) => s.go);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await phoneApi.answer(action.id, { key });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="phone-action" className="rounded-xl border border-needs/40 bg-needs/10 p-3">
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => action.consoleId && go({ kind: 'console', id: action.consoleId })}
      >
        <p className="text-[13px] font-semibold text-fg">{consoleName ? `${consoleName}: ${action.title}` : action.title}</p>
        {(action.question || action.detail) && <p className="mt-0.5 text-[12.5px] text-fg-muted">{action.question || action.detail}</p>}
      </button>
      {action.options && action.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {action.options.map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={busy}
              onClick={() => void answer(o.key)}
              className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] font-medium text-fg active:bg-hover disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-1 text-[12px] text-error">{error}</p>}
    </div>
  );
}

const KEYS: { label: string; data: string }[] = [
  { label: 'Esc', data: '\x1b' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: 'Enter', data: '\r' },
  { label: '1', data: '1' },
  { label: '2', data: '2' },
  { label: '3', data: '3' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl-C', data: '\x03' },
];

function ConsoleScreen({ id }: { id: string }) {
  const c = usePhone((s) => s.consoles[id]);
  const actions = usePhone((s) => s.actions);
  const go = usePhone((s) => s.go);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  if (!c) return null;
  const meta = STATUS_META[c.status];
  const pending = openActions(actions).filter((a) => a.consoleId === id);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    try {
      await phoneApi.send(id, value);
      setText('');
      setNote(null);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const toComputer = async () => {
    try {
      await phoneApi.handoff(id, 'desktop');
      setNote(`${c.name} is open on your computer`);
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Header
        title={c.name}
        onBack={() => go({ kind: 'fleet' })}
        right={
          <button
            type="button"
            data-testid="phone-to-computer"
            onClick={() => void toComputer()}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] font-medium text-fg active:bg-hover"
          >
            <Monitor size={13} /> On computer
          </button>
        }
      />
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
        <span className={`rounded-full px-2 py-[1px] ${meta.pill}`} data-testid="phone-console-status">
          {meta.label}
        </span>
        <span className="truncate text-fg-muted">{c.status === 'working' && c.activity ? c.activity : folderName(c.cwd)}</span>
      </div>
      <PhoneTerminal consoleId={id} />
      {pending.map((a) => (
        <div key={a.id} className="border-t border-line px-3 pt-2">
          <ActionCard action={a} />
        </div>
      ))}
      <div className="border-t border-line bg-surface px-2 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
        <div className="aa-scroll mb-2 flex gap-1.5 overflow-x-auto">
          {KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              onClick={() => phoneSocket.input(id, k.data)}
              className="shrink-0 rounded-md border border-line-strong bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-fg active:bg-hover"
            >
              {k.label}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            data-testid="phone-message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Message ${c.name}`}
            enterKeyHint="send"
            className="min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] text-fg outline-none focus:border-accent"
          />
          <button type="submit" aria-label="Send" className="aa-btn-primary grid w-12 place-items-center rounded-xl">
            <SendHorizontal size={17} />
          </button>
        </form>
        {note && <p className="mt-1.5 px-1 text-[12px] text-fg-muted" data-testid="phone-note">{note}</p>}
      </div>
    </div>
  );
}

const SINGLE = '__single__';
const AGENTS: Exclude<AgentKind, 'custom'>[] = ['claude', 'codex', 'gemini', 'opencode', 'grok'];

function LaunchScreen() {
  const go = usePhone((s) => s.go);
  const consoles = usePhone((s) => s.consoles);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [choice, setChoice] = useState<string>(SINGLE);
  const [agent, setAgent] = useState<Exclude<AgentKind, 'custom'>>('claude');
  const [cwd, setCwd] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<FsListResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    phoneApi.templates().then(setTemplates).catch((e: Error) => setError(e.message));
  }, []);

  // Folders the agents on this board already use, newest first
  const folders = useMemo(() => {
    const seen = new Set<string>();
    return Object.values(consoles)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => c.git?.repoRoot ?? c.cwd)
      .filter((dir) => (seen.has(dir) ? false : (seen.add(dir), true)))
      .slice(0, 8);
  }, [consoles]);

  const browse = (path?: string) => {
    phoneApi.listDir(path).then(setBrowsing).catch((e: Error) => setError(e.message));
  };

  const launch = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    setError(null);
    try {
      const first =
        choice === SINGLE
          ? (await phoneApi.newAgent({ cwd, ...(agent !== 'claude' ? { agent } : {}) })).id
          : (await phoneApi.launchTemplate(choice, { cwd })).consoles[0]?.id;
      // The computer flies to the new agents, so you can watch them there
      if (first) await phoneApi.handoff(first, 'desktop').catch(() => undefined);
      go({ kind: 'fleet' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <Header title="Launch agents" onBack={() => go({ kind: 'fleet' })} />
      <main className="flex-1 space-y-5 px-3 py-3 pb-28">
        <section>
          <h2 className="aa-label mb-2 text-fg-subtle">What</h2>
          <div className="space-y-2">
            <Choice selected={choice === SINGLE} onClick={() => setChoice(SINGLE)} testId="phone-launch-single">
              <Plus size={15} className="text-accent" />
              <span className="flex-1">One agent</span>
            </Choice>
            {choice === SINGLE && (
              <div className="flex flex-wrap gap-1.5 pl-1">
                {AGENTS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setAgent(kind)}
                    className={`rounded-lg border px-2.5 py-1.5 text-[13px] ${agent === kind ? 'border-accent bg-accent/15 text-accent' : 'border-line-strong text-fg-muted'}`}
                  >
                    {AGENT_META[kind].short}
                  </button>
                ))}
              </div>
            )}
            {(templates ?? []).map((t) => (
              <Choice key={t.id} selected={choice === t.id} onClick={() => setChoice(t.id)} testId="phone-launch-template">
                <Users size={15} className="text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.name}</span>
                  <span className="block truncate text-[12px] text-fg-subtle">{t.description}</span>
                </span>
              </Choice>
            ))}
            {!templates && !error && <LoaderCircle size={16} className="animate-spin text-fg-subtle" />}
          </div>
        </section>

        <section>
          <h2 className="aa-label mb-2 text-fg-subtle">Where</h2>
          <div className="space-y-2">
            {folders.map((dir) => (
              <Choice key={dir} selected={cwd === dir} onClick={() => setCwd(dir)} testId="phone-launch-folder">
                <Folder size={15} className="text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{folderName(dir)}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-subtle">{dir}</span>
                </span>
              </Choice>
            ))}
            <button
              type="button"
              onClick={() => browse(cwd ?? undefined)}
              className="flex w-full items-center gap-2 rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-[14px] text-fg-muted"
            >
              <FolderOpen size={15} /> Browse folders on the computer…
            </button>
            {browsing && (
              <div className="rounded-xl border border-line bg-surface p-2" data-testid="phone-browser">
                <p className="truncate px-1 pb-1 font-mono text-[11px] text-fg-subtle">{browsing.path}</p>
                <div className="flex gap-2 pb-2">
                  {browsing.parent && (
                    <button type="button" onClick={() => browse(browsing.parent!)} className="rounded-md border border-line-strong px-2 py-1 text-[12px]">
                      Up
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setCwd(browsing.path);
                      setBrowsing(null);
                    }}
                    className="aa-btn-primary rounded-md px-2 py-1 text-[12px] font-semibold"
                  >
                    Use this folder
                  </button>
                </div>
                <ul className="aa-scroll max-h-56 overflow-y-auto">
                  {browsing.dirs.map((d) => (
                    <li key={d.path}>
                      <button type="button" onClick={() => browse(d.path)} className="flex w-full items-center gap-2 px-1 py-1.5 text-left text-[13px] text-fg active:bg-hover">
                        <Folder size={13} className="text-fg-subtle" /> {d.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {cwd && !folders.includes(cwd) && (
              <p className="truncate px-1 font-mono text-[12px] text-fg-muted">Folder: {cwd}</p>
            )}
          </div>
        </section>
        {error && <p className="text-[13px] text-error">{error}</p>}
      </main>
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),10px)] backdrop-blur">
        <button
          type="button"
          data-testid="phone-launch"
          disabled={!cwd || busy}
          onClick={() => void launch()}
          className="aa-btn-primary flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[15px] font-semibold disabled:opacity-50"
        >
          {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Smartphone size={16} />}
          Launch on my computer
        </button>
      </div>
    </div>
  );
}

function Choice({
  selected,
  onClick,
  children,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[14px] text-fg ${
        selected ? 'border-accent bg-accent/10' : 'border-line bg-surface'
      }`}
    >
      {children}
    </button>
  );
}
