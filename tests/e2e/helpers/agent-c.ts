import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentArmyServer } from './server';

// Items / workspaces specs: a fixed port and data dir that never touch the user's live board
export const ITEMS_PORT = 4442;
export const ITEMS_DATA_DIR = path.join(os.tmpdir(), 'aa-v03-C');

export async function startItemsServer(label: string): Promise<{ server: AgentArmyServer; home: string; project: string }> {
  fs.rmSync(ITEMS_DATA_DIR, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(ITEMS_DATA_DIR, { recursive: true });
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `agentarmy-e2e-${label}-`)));
  const project = path.join(home, 'proj');
  fs.mkdirSync(project);
  const server = await AgentArmyServer.start({
    home,
    port: Number(process.env.AA_ITEMS_PORT ?? ITEMS_PORT),
    env: { AGENTARMY_HOME: ITEMS_DATA_DIR },
  });
  return { server, home, project };
}
