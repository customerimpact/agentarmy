import net from 'node:net';
import path from 'node:path';
import open from 'open';
import { DEFAULT_PORT } from '../shared/protocol.js';
import { ConsoleManager } from './consoles.js';
import { DEV_UI_PORT } from './security.js';
import { acquireInstanceLock } from './instance-lock.js';
import { buildServer } from './server.js';
import { agentArmyHome, StateStore } from './store.js';
import { setActiveSettings, SettingsStore } from './settings.js';
import { loadOrCreateToken } from './token-file.js';

export interface StartOptions {
  port?: number; // preferred port; a random free one is used when it is busy
  open?: boolean; // open the UI in the default browser
  resumeAll?: boolean;
  newToken?: boolean;
  dev?: boolean; // UI served by Vite on DEV_UI_PORT
  home?: string; // data folder (defaults to AGENTARMY_HOME or ~/.agentarmy)
  log?: (message: string) => void;
}

export interface AgentArmyHandle {
  url: string; // UI address including ?token=
  port: number;
  token: string;
  // Consoles with a live claude process (not exited or suspended)
  runningCount(): number;
  // Saves state, suspends consoles (resumable next time), releases the lock and stops the server
  close(): Promise<void>;
}

function tryPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(null));
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address();
      const actual = typeof address === 'object' && address ? address.port : null;
      probe.close(() => resolve(actual));
    });
  });
}

async function pickPort(preferred: number): Promise<number> {
  const port = (await tryPort(preferred)) ?? (await tryPort(0));
  if (!port) throw new Error('Could not find a free port');
  return port;
}

// Shared by the CLI (`npx agentarmy`) and the desktop app's main process
export async function startAgentArmy(options: StartOptions = {}): Promise<AgentArmyHandle> {
  const log = options.log ?? ((message: string) => console.log(message));
  // Every store reads agentArmyHome(), so the home override has to be in place before they are built
  if (options.home) process.env.AGENTARMY_HOME = options.home;
  const preferred = options.port ?? DEFAULT_PORT;
  const dev = options.dev ?? false;

  const port = await pickPort(preferred);
  const lock = acquireInstanceLock(port);
  if ('heldBy' in lock) {
    throw new Error(
      `AgentArmy is already running (pid ${lock.heldBy.pid}, port ${lock.heldBy.port}). ` +
        `Stop it first, or delete ${path.join(agentArmyHome(), 'server.lock')} if it is stale.`,
    );
  }
  try {
    if (port !== preferred) log(`Port ${preferred} is busy, using ${port} instead.`);
    if (dev && port !== DEFAULT_PORT) {
      console.warn(`Warning: the Vite dev proxy expects port ${DEFAULT_PORT}.`);
    }
    const token = process.env.AGENTARMY_TOKEN || loadOrCreateToken({ rotate: options.newToken });

    const store = new StateStore();
    const settings = new SettingsStore();
    setActiveSettings(settings);
    const manager: ConsoleManager = new ConsoleManager({
      port,
      token,
      dev,
      settings: () => settings.get(),
      onChange: () => store.scheduleSave(() => manager.getState()),
    });
    const app = await buildServer({ port, token, dev, manager, settings });
    await app.listen({ port, host: '127.0.0.1' });

    // resumeAll wins; otherwise the "On startup" setting decides ('ask' leaves it to the UI prompt)
    const resumeAll = options.resumeAll || settings.get().startupResume === 'always';
    manager.restore(store.load(), { resumeAll });

    const uiPort = dev ? DEV_UI_PORT : port;
    const host = dev ? 'localhost' : '127.0.0.1';
    const url = `http://${host}:${uiPort}/?token=${token}`;
    if (options.open) {
      open(url).catch((err: unknown) => console.warn(`Could not open the browser: ${String(err)}`));
    }

    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closing) return closing;
      // The synchronous part runs right away, so a caller that cannot wait still saves state
      try {
        store.saveSync(manager.getState());
      } catch (err) {
        console.error(`Could not save state: ${String(err)}`);
      }
      manager.shutdown();
      lock.release();
      closing = app.close().then(
        () => undefined,
        () => undefined,
      );
      return closing;
    };

    return {
      url,
      port,
      token,
      runningCount: () =>
        manager.getState().consoles.filter((c) => c.status !== 'exited' && c.status !== 'suspended').length,
      close,
    };
  } catch (err) {
    lock.release();
    throw err;
  }
}
