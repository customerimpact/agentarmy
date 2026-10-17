import fs from 'node:fs';
import path from 'node:path';
import { agentArmyHome } from './store.js';

interface LockInfo {
  pid: number;
  port: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Two servers on one state file would each resume the same Claude sessions side by side
export function acquireInstanceLock(port: number): { release: () => void } | { heldBy: LockInfo } {
  const file = path.join(agentArmyHome(), 'server.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
    if (existing.pid !== process.pid && isAlive(existing.pid)) return { heldBy: existing };
  } catch {
    // no lock or unreadable: take it
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port } satisfies LockInfo));
  return {
    release: () => {
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
        if (current.pid === process.pid) fs.rmSync(file, { force: true });
      } catch {
        // already gone
      }
    },
  };
}
