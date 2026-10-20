import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { DESKTOP_TAG_PREFIX, DOWNLOAD_PAGE, isNewerVersion, pickDesktopRelease, UPDATE_REPO, type GitHubRelease } from './release-feed';
import type { UpdateState } from './tray-menu';

// Auto-update from GitHub Releases (customerimpact/gridhive, public, no token).
// The repo also has npm releases tagged v*, so the stock GitHub provider (which takes the newest
// release) could land on one without latest.yml. We pick the newest desktop-v* release ourselves
// and hand its download folder to the generic provider.

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;

function updatesEnabled(): boolean {
  return app.isPackaged && process.env.AGENTARMY_DISABLE_UPDATES !== '1';
}

// Only an NSIS install can update itself; dev runs and the unpacked folder cannot. The Mac app is not
// signed by Apple, so macOS would refuse to swap it: it only tells the user about a new download.
export function canSelfUpdate(): boolean {
  if (!updatesEnabled() || process.platform === 'darwin') return false;
  if (process.platform !== 'win32') return true;
  const dir = path.dirname(process.execPath);
  return fs.existsSync(path.join(dir, `Uninstall ${app.getName()}.exe`)) || fs.existsSync(path.join(dir, 'Uninstall AgentArmy.exe'));
}

export interface Updater {
  check(manual: boolean): Promise<void>;
  install(): void;
  stop(): void;
}

interface UpdaterOptions {
  onState: (state: UpdateState) => void;
  onMessage: (title: string, message: string) => void; // only for manual checks
  beforeInstall: () => Promise<void>; // stop the server cleanly before the installer runs
}

// Newest published desktop-v* release that has a build for this platform
async function latestDesktopTag(): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `GridHive/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return pickDesktopRelease((await res.json()) as GitHubRelease[], process.platform);
}

function every(check: (manual: boolean) => Promise<void>): () => void {
  const first = setTimeout(() => void check(false), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void check(false), CHECK_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// macOS: show "Download vX" in the menu bar menu, which opens the website's download section
function startDownloadNotifier(options: UpdaterOptions): Updater {
  let state: UpdateState = { kind: 'idle' };
  const set = (next: UpdateState): void => {
    state = next;
    options.onState(next);
  };
  const check = async (manual: boolean): Promise<void> => {
    if (state.kind === 'checking') return;
    const before = state;
    set({ kind: 'checking' });
    try {
      const tag = await latestDesktopTag();
      const version = tag?.slice(DESKTOP_TAG_PREFIX.length);
      if (version && isNewerVersion(version, app.getVersion())) {
        set({ kind: 'available', version });
        if (manual) void shell.openExternal(DOWNLOAD_PAGE);
        return;
      }
      set({ kind: 'idle' });
      if (manual) options.onMessage('Updates', `GridHive ${app.getVersion()} is the latest version.`);
    } catch (err) {
      console.warn(`[gridhive] update check failed: ${String(err)}`);
      set(before.kind === 'available' ? before : { kind: 'idle' });
      if (manual) options.onMessage('Updates', `Could not check for updates: ${(err as Error).message}`);
    }
  };
  const stop = every(check);
  return {
    check,
    install() {
      void shell.openExternal(DOWNLOAD_PAGE);
    },
    stop,
  };
}

export function startUpdater(options: UpdaterOptions): Updater {
  if (process.platform === 'darwin' && updatesEnabled()) return startDownloadNotifier(options);
  if (!canSelfUpdate()) {
    options.onState({ kind: 'idle' });
    return {
      async check(manual) {
        if (manual) {
          options.onMessage(
            'Updates',
            app.isPackaged
              ? 'This copy was not installed with the GridHive installer, so it cannot update itself.'
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
    if (manualCheck) options.onMessage('Updates', `GridHive ${app.getVersion()} is the latest version.`);
  });
  autoUpdater.on('update-downloaded', (info) => set({ kind: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    console.warn(`[gridhive] update check failed: ${String(err)}`);
    if (state.kind !== 'ready') set({ kind: 'idle' });
    if (manualCheck) options.onMessage('Updates', `Could not check for updates: ${err.message}`);
  });

  const check = async (manual: boolean): Promise<void> => {
    if (state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'ready') return;
    manualCheck = manual;
    set({ kind: 'checking' });
    try {
      const tag = await latestDesktopTag();
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
      console.warn(`[gridhive] update check failed: ${String(err)}`);
      set({ kind: 'idle' });
      if (manual) options.onMessage('Updates', `Could not check for updates: ${(err as Error).message}`);
    }
  };

  const stop = every(check);

  return {
    check,
    install() {
      if (state.kind !== 'ready') return;
      void options.beforeInstall().finally(() => autoUpdater.quitAndInstall(true, true));
    },
    stop,
  };
}
