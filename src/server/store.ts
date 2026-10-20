import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WORKSPACE_ID, STATE_VERSION, type BoardState, type Workspace } from '../shared/protocol.js';

const SAVE_DEBOUNCE_MS = 300;

export function agentArmyHome(): string {
  return process.env.AGENTARMY_HOME ?? path.join(os.homedir(), '.agentarmy');
}

export function emptyState(): BoardState {
  return { version: STATE_VERSION, consoles: [], jobs: [], actions: [], projects: [], browsers: [], items: [], loops: [], workspaces: [defaultWorkspace()] };
}

export function defaultWorkspace(): Workspace {
  return { id: DEFAULT_WORKSPACE_ID, name: 'Main', createdAt: 0, order: 0 };
}

export class StateStore {
  private timer: NodeJS.Timeout | null = null;
  private getState: (() => BoardState) | null = null;

  constructor(readonly filePath: string = path.join(agentArmyHome(), 'state.json')) {}

  load(): BoardState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Omit<BoardState, 'version'>> & { version?: number };
      // v1 had only consoles + viewport; v2 adds jobs, actions, projects and browser tiles; v3 items + workspaces
      if (![1, 2, STATE_VERSION].includes(parsed.version ?? 0) || !Array.isArray(parsed.consoles)) {
        throw new Error(`unsupported state version ${String(parsed.version)}`);
      }
      const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
      return {
        version: STATE_VERSION,
        consoles: parsed.consoles,
        jobs: list(parsed.jobs),
        actions: list(parsed.actions),
        projects: list(parsed.projects),
        browsers: list(parsed.browsers),
        items: list(parsed.items),
        drawings: list(parsed.drawings),
        loops: list(parsed.loops), // missing before loops existed
        workspaces: list(parsed.workspaces).length ? list(parsed.workspaces) : [defaultWorkspace()],
        ...(typeof parsed.activeWorkspaceId === 'string' ? { activeWorkspaceId: parsed.activeWorkspaceId } : {}),
        viewport: parsed.viewport,
      };
    } catch (err) {
      // Keep the unreadable file for the user instead of silently overwriting it
      const backup = `${this.filePath}.${Date.now()}.bad`;
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        // ignore: worst case it gets overwritten on the next save
      }
      console.warn(
        `[gridhive] Could not read ${this.filePath} (${String(err)}); saved as ${backup}`,
      );
      return emptyState();
    }
  }

  scheduleSave(getState: () => BoardState): void {
    this.getState = getState;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.getState) return;
    this.saveSync(this.getState());
  }

  saveSync(state: BoardState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmp, json);
    try {
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Windows can refuse the rename while a scanner holds the target open; fall back to a direct write
      fs.writeFileSync(this.filePath, json);
      fs.rmSync(tmp, { force: true });
    }
  }
}
