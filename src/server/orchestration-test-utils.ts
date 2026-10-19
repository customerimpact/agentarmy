import { vi } from 'vitest';
import { STATE_VERSION, type ConsoleInfo, type ConsoleStatus } from '../shared/protocol.js';
import { ConsoleManager } from './consoles.js';

// Test helpers: a ConsoleManager with fake consoles (no PTYs) and a recorded sendText.

export function fakeConsole(
  id: string,
  status: ConsoleStatus = 'idle',
  layout = { x: 0, y: 0, width: 100, height: 100 },
): ConsoleInfo {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    cwd: process.cwd(),
    sessionId: `${id}-session`,
    status,
    statusChangedAt: 1,
    layout,
    createdAt: 1,
  };
}

export function fakeManager(consoles: ConsoleInfo[]): {
  manager: ConsoleManager;
  typed: Array<{ id: string; text: string }>;
  setStatus: (id: string, status: ConsoleStatus, detail?: string) => void;
} {
  const manager = new ConsoleManager({ port: 1, token: 't', onChange: () => {} });
  // restore() registers them as suspended; then set the wanted status back
  manager.restore(
    { version: STATE_VERSION, consoles: consoles.map((c) => ({ ...c })), jobs: [], actions: [], projects: [], browsers: [], items: [], workspaces: [] },
    { resumeAll: false },
  );
  for (const c of consoles) manager.get(c.id)!.status = c.status;
  const typed: Array<{ id: string; text: string }> = [];
  manager.sendText = vi.fn((id: string, text: string) => {
    const info = manager.get(id);
    if (!info || info.status === 'exited' || info.status === 'suspended') return false;
    typed.push({ id, text });
    return true;
  });
  const setStatus = (id: string, status: ConsoleStatus, detail?: string): void => {
    const info = manager.get(id)!;
    info.status = status;
    info.statusDetail = detail;
    manager.touch(id);
  };
  return { manager, typed, setStatus };
}
