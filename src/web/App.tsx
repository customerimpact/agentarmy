import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError, api } from './lib/api';
import { clearToken, getToken } from './lib/auth';
import { startNotifications } from './lib/notify';
import { startDesktopBoard } from './lib/desktop';
import { useServerSettings } from './lib/settings';
import { socket } from './lib/socket';
import { useBoard } from './lib/store';
import { useItems } from './lib/items';
import { useShortcuts } from './lib/use-shortcuts';
import { startPopoutPresence, startPopoutTracking, syncPrefsAcrossWindows } from './lib/popout';
import { parseView } from './lib/views';
import { PopoutShell } from './components/PopoutViews';
import { Board } from './components/Board';
import { CommandBar } from './components/CommandBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { EmptyState } from './components/EmptyState';
import { MissingToken } from './components/MissingToken';
import { MissionMap } from './components/MissionMap';
import { NewAgentDialog } from './components/NewAgentDialog';
import { Sidebar } from './components/Sidebar';
import { SettingsHost, SettingsPage } from './components/SettingsWindow';
import { ResumeAllToast } from './components/ResumeAllToast';
import { PreviewOfferToasts } from './components/PreviewOfferToast';
import { ReviewHost } from './components/ReviewPanel';
import { GitPanelHost } from './components/GitPanel';
import { CodeViewerHost } from './components/CodeViewer';
import './components/items/FileItem'; // registers the 'file' board item (pinned code card)
import { HandoffMemoryHost } from './components/HandoffMemoryHost';
import { ReconnectBanner, Toasts } from './components/StatusBanners';
import { JobsPausedBanner } from './components/UsageSection';
import { TemplatesDialog } from './components/TemplatesDialog';
import { LoopsHost } from './components/LoopsDialog';
import { Toolbar } from './components/Toolbar';

// ?view=console|project|focus opens a pop-out window instead of the full board (see lib/views.ts)
const VIEW = parseView(window.location.search);
// ?view=settings: the Settings window as a full page (its own window or tab)
const SETTINGS_PAGE = new URLSearchParams(window.location.search).get('view') === 'settings';

type Phase = 'loading' | 'ready' | 'no-token' | 'bad-token' | 'error';

function Shell() {
  const loaded = useBoard((s) => s.loaded);
  const empty = useBoard((s) => Object.keys(s.consoles).length === 0);
  const newAgentOpen = useBoard((s) => s.newAgentOpen);
  const missionMapOpen = useBoard((s) => s.missionMapOpen);
  const templatesOpen = useBoard((s) => s.templatesOpen);
  useShortcuts();

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative min-w-0 flex-1">
        {loaded && <Board />}
        <Toolbar />
        <ReconnectBanner />
        <JobsPausedBanner />
        {loaded && <ResumeAllToast />}
        {loaded && <PreviewOfferToasts />}
        {loaded && empty && !newAgentOpen && <EmptyState />}
        {loaded && <CommandBar />}
        <Toasts />
      </main>
      {newAgentOpen && <NewAgentDialog />}
      {loaded && missionMapOpen && <MissionMap />}
      {templatesOpen && <TemplatesDialog />}
      {loaded && <LoopsHost />}
      {loaded && <ReviewHost />}
      {loaded && <GitPanelHost />}
      {loaded && <CodeViewerHost />}
      {loaded && <HandoffMemoryHost />}
      <SettingsHost />
      <ConfirmDialog />
    </div>
  );
}

export function App() {
  // Always try the API: without a URL/session token the server may still accept its HttpOnly cookie
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (phase !== 'loading') return;
    let cancelled = false;
    const load = async () => {
      try {
        const state = await api.getState();
        if (cancelled) return;
        useBoard.getState().loadState(state);
        useItems.getState().load(state);
        socket.start();
        void useServerSettings.getState().load();
        syncPrefsAcrossWindows();
        if (SETTINGS_PAGE) {
          // Settings page: no chimes, no pop-out bookkeeping
        } else if (VIEW.kind === 'board') {
          // Only the main board pings; pop-outs would otherwise chime once per window
          startNotifications();
          startPopoutTracking();
          startDesktopBoard();
        } else {
          startPopoutPresence(VIEW);
        }
        setPhase('ready');
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          const hadToken = getToken() !== null;
          clearToken();
          setPhase(hadToken ? 'bad-token' : 'no-token');
        } else {
          setError((e as Error).message);
          setPhase('error');
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (phase === 'no-token') return <MissingToken />;
  if (phase === 'bad-token') return <MissingToken invalid />;
  if (phase === 'error') {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-[15px] font-semibold text-fg">Could not reach the AgentArmy server</p>
          <p className="mt-1 text-fg-muted">{error}</p>
          <button
            type="button"
            onClick={() => setPhase('loading')}
            className="mt-4 rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg
                       hover:brightness-110"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (phase === 'loading') return <div className="h-full bg-canvas" />;

  return (
    <ReactFlowProvider>
      {SETTINGS_PAGE ? (
        <div className="relative h-full">
          <SettingsPage />
          <Toasts />
          <ConfirmDialog />
        </div>
      ) : VIEW.kind === 'board' ? (
        <Shell />
      ) : (
        <PopoutShell view={VIEW} />
      )}
    </ReactFlowProvider>
  );
}
