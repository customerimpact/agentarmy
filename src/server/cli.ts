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

interface CliArgs {
  port: number;
  dev: boolean;
  open: boolean;
  resumeAll: boolean;
  newToken: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: DEFAULT_PORT,
    dev: false,
    open: true,
    resumeAll: false,
    newToken: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev') args.dev = true;
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--resume-all') args.resumeAll = true;
    else if (arg === '--new-token') args.newToken = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port value: ${value}`);
      }
      args.port = port;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: agentarmy [--port <n>] [--no-open] [--resume-all] [--new-token] [--dev]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = await pickPort(args.port);
  const lock = acquireInstanceLock(port);
  if ('heldBy' in lock) {
    throw new Error(
      `AgentArmy is already running (pid ${lock.heldBy.pid}, port ${lock.heldBy.port}). ` +
        `Stop it first, or delete ${path.join(agentArmyHome(), 'server.lock')} if it is stale.`,
    );
  }
  if (port !== args.port) console.log(`Port ${args.port} is busy, using ${port} instead.`);
  if (args.dev && port !== DEFAULT_PORT) {
    console.warn(`Warning: the Vite dev proxy expects port ${DEFAULT_PORT}.`);
  }
  const token = process.env.AGENTARMY_TOKEN || loadOrCreateToken({ rotate: args.newToken });

  const store = new StateStore();
  const settings = new SettingsStore();
  setActiveSettings(settings);
  const manager: ConsoleManager = new ConsoleManager({
    port,
    token,
    dev: args.dev,
    settings: () => settings.get(),
    onChange: () => store.scheduleSave(() => manager.getState()),
  });
  const app = await buildServer({ port, token, dev: args.dev, manager, settings });
  await app.listen({ port, host: '127.0.0.1' });

  // --resume-all wins; otherwise the "On startup" setting decides ('ask' leaves it to the UI prompt)
  const resumeAll = args.resumeAll || settings.get().startupResume === 'always';
  manager.restore(store.load(), { resumeAll });

  const uiPort = args.dev ? DEV_UI_PORT : port;
  const host = args.dev ? 'localhost' : '127.0.0.1';
  const url = `http://${host}:${uiPort}/?token=${token}`;
  console.log(`AgentArmy is running: ${url}`);
  if (args.open) {
    open(url).catch((err: unknown) => console.warn(`Could not open the browser: ${String(err)}`));
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, saving state and stopping consoles...`);
    try {
      store.saveSync(manager.getState());
    } catch (err) {
      console.error(`Could not save state: ${String(err)}`);
    }
    manager.shutdown();
    lock.release();
    void app.close().finally(() => process.exit(0));
    // Do not hang forever on a stuck socket
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
