import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError, api } from './lib/api';
import { clearToken, getToken } from './lib/auth';
import { startNotifications } from './lib/notify';
import { socket } from './lib/socket';
import { useBoard } from './lib/store';
import { useShortcuts } from './lib/use-shortcuts';
import { Board } from './components/Board';
import { CommandBar } from './components/CommandBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { EmptyState } from './components/EmptyState';
import { MissingToken } from './components/MissingToken';
import { NewAgentDialog } from './components/NewAgentDialog';
import { Sidebar } from './components/Sidebar';
import { ResumeAllToast } from './components/ResumeAllToast';
import { ReconnectBanner, Toasts } from './components/StatusBanners';
import { Toolbar } from './components/Toolbar';

type Phase = 'loading' | 'ready' | 'no-token' | 'bad-token' | 'error';

function Shell() {
  const loaded = useBoard((s) => s.loaded);
  const empty = useBoard((s) => Object.keys(s.consoles).length === 0);
  const newAgentOpen = useBoard((s) => s.newAgentOpen);
  useShortcuts();

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative min-w-0 flex-1">
        {loaded && <Board />}
        <Toolbar />
        <ReconnectBanner />
        {loaded && <ResumeAllToast />}
        {loaded && empty && !newAgentOpen && <EmptyState />}
        {loaded && <CommandBar />}
        <Toasts />
      </main>
      {newAgentOpen && <NewAgentDialog />}
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
        socket.start();
        startNotifications();
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
      <Shell />
    </ReactFlowProvider>
  );
}
