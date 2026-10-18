import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { pickDesktopRelease, UPDATE_REPO, type GitHubRelease } from './release-feed';
import type { UpdateState } from './tray-menu';

// Auto-update from GitHub Releases (customerimpact/agentarmy, public, no token).
// The repo also has npm releases tagged v*, so the stock GitHub provider (which takes the newest
// release) could land on one without latest.yml. We pick the newest desktop-v* release ourselves
// and hand its download folder to the generic provider.

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;

// Only an NSIS install can update itself; dev runs and the unpacked folder cannot
export function canSelfUpdate(): boolean {
  if (!app.isPackaged || process.env.AGENTARMY_DISABLE_UPDATES === '1') return false;
  if (process.platform !== 'win32') return true;
  const dir = path.dirname(process.execPath);
  return fs.existsSync(path.join(dir, `Uninstall ${app.getName()}.exe`)) || fs.existsSync(path.join(dir, 'Uninstall AgentArmy.exe'));
}

export interface Updater {
  check(manual: boolean): Promise<void>;
  install(): void;
  stop(): void;
}

export function startUpdater(options: {
  onState: (state: UpdateState) => void;
  onMessage: (title: string, message: string) => void; // only for manual checks
  beforeInstall: () => Promise<void>; // stop the server cleanly before the installer runs
}): Updater {
  if (!canSelfUpdate()) {
    options.onState({ kind: 'idle' });
    return {
      async check(manual) {
        if (manual) {
          options.onMessage(
            'Updates',
            app.isPackaged
              ? 'This copy was not installed with the AgentArmy installer, so it cannot update itself.'
              : 'Updates are disabled in development runs.',
          );
        }
      },
      install() {},
      stop() {},
    };
  }

  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  let state: UpdateState = { kind: 'idle' };
  let manualCheck = false;
  const set = (next: UpdateState): void => {
    state = next;
    options.onState(next);
  };

  autoUpdater.on('update-available', (info) => set({ kind: 'downloading', version: info.version }));
  autoUpdater.on('update-not-available', () => {
    set({ kind: 'idle' });
    if (manualCheck) options.onMessage('Updates', `AgentArmy ${app.getVersion()} is the latest version.`);
  });
  autoUpdater.on('update-downloaded', (info) => set({ kind: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    console.warn(`[agentarmy] update check failed: ${String(err)}`);
    if (state.kind !== 'ready') set({ kind: 'idle' });
    if (manualCheck) options.onMessage('Updates', `Could not check for updates: ${err.message}`);
  });

  const check = async (manual: boolean): Promise<void> => {
    if (state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'ready') return;
    manualCheck = manual;
    set({ kind: 'checking' });
    try {
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `AgentArmy/${app.getVersion()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const tag = pickDesktopRelease((await res.json()) as GitHubRelease[]);
      if (!tag) {
        set({ kind: 'idle' });
        if (manual) options.onMessage('Updates', 'No desktop release has been published yet.');
        return;
      }
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: `https://github.com/${UPDATE_REPO}/releases/download/${tag}`,
      });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.warn(`[agentarmy] update check failed: ${String(err)}`);
      set({ kind: 'idle' });
      if (manual) options.onMessage('Updates', `Could not check for updates: ${(err as Error).message}`);
    }
  };

  const first = setTimeout(() => void check(false), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void check(false), CHECK_EVERY_MS);

  return {
    check,
    install() {
      if (state.kind !== 'ready') return;
      void options.beforeInstall().finally(() => autoUpdater.quitAndInstall(true, true));
    },
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
