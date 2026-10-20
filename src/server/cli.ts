import { DEFAULT_PORT } from '../shared/protocol.js';
import open from 'open';
import { AlreadyRunningError, startAgentArmy } from './app.js';
import { npmUpdateNotice, ownVersion } from './npm-update.js';
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
      console.log('Usage: gridhive [--port <n>] [--no-open] [--resume-all] [--new-token] [--dev]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = await startAgentArmy(args);
  console.log(`GridHive is running: ${handle.url}`);
  const version = ownVersion();
  if (version && !args.dev && process.env.AGENTARMY_DISABLE_UPDATES !== '1') {
    void npmUpdateNotice(version).then((notice) => notice && console.log(notice));
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, saving state and stopping consoles...`);
    void handle.close().finally(() => process.exit(0));
    // Do not hang forever on a stuck socket
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

main().catch(async (err: unknown) => {
  // A second `npx gridhive` should simply open the board that is already running
  if (err instanceof AlreadyRunningError && err.port) {
    const args = parseArgs(process.argv.slice(2));
    const token = process.env.AGENTARMY_TOKEN || loadOrCreateToken({ rotate: false });
    const url = `http://127.0.0.1:${err.port}/?token=${token}`;
    console.log(`GridHive is already running (desktop app or another terminal): ${url}`);
    if (args.open) await open(url).catch(() => undefined);
    process.exit(0);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
