import fs from 'node:fs';
import path from 'node:path';
import { agentArmyHome } from './store.js';

export interface LockInfo {
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

export function lockFilePath(): string {
  return path.join(agentArmyHome(), 'server.lock');
}

// The server that currently owns the state file, if its process is still alive (desktop app attaches to it)
export function readLiveInstanceLock(): LockInfo | null {
  try {
    const existing = JSON.parse(fs.readFileSync(lockFilePath(), 'utf8')) as LockInfo;
    if (Number.isInteger(existing.pid) && Number.isInteger(existing.port) && existing.pid !== process.pid && isAlive(existing.pid)) {
      return existing;
    }
  } catch {
    // no lock or unreadable
  }
  return null;
}

// Two servers on one state file would each resume the same Claude sessions side by side
export function acquireInstanceLock(port: number): { release: () => void } | { heldBy: LockInfo } {
  const file = lockFilePath();
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
