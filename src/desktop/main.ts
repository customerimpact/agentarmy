// AgentArmy desktop app (Electron main process). It runs the same Fastify server as `npx agentarmy`
// in-process (or attaches to a CLI server that is already running) and shows its UI in a window.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import { startAgentArmy, type AgentArmyHandle } from '../server/app';
import { lockFilePath, readLiveInstanceLock } from '../server/instance-lock';
import { packageVersion } from '../server/settings';
import { agentArmyHome } from '../server/store';
import { tokenFilePath } from '../server/token-file';
import { DEFAULT_PORT } from '../shared/protocol';
import {
  DESKTOP_TITLE_BAR_HEIGHT,
  IPC,
  type AttentionItem,
  type TitleBarColors,
} from '../shared/desktop-api';
import { DesktopTray, needsYouText, type UpdateState } from './tray';
import { startUpdater, type Updater } from './updater';
import { DesktopStateFile, restoreBounds } from './window-state';

const APP_ID = 'com.agentarmy.app';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');
// Packaged: resources/icons (extraResources). From the repo: build/icons (npm run desktop:icons).
const ICON_DIR = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.resolve(HERE, '../../build/icons');
const VERSION = packageVersion();
const PAUSE_MS = 60 * 60 * 1000;
const DEFAULT_TITLE_BAR: TitleBarColors = { color: '#141110', symbolColor: '#e9e2da' };

app.setName('AgentArmy');
// A custom AGENTARMY_HOME (tests, second profiles) also gets its own Chromium profile and instance lock
if (process.env.AGENTARMY_HOME) {
  app.setPath('userData', path.join(process.env.AGENTARMY_HOME, 'desktop-profile'));
}

interface Backend {
  url: string; // with ?token= (only used for the first load; the server then sets its cookie)
  origin: string;
  owned: AgentArmyHandle | null; // null: attached to a CLI server we must not stop
}

let backend: Backend | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: DesktopTray | null = null;
let updater: Updater | null = null;
let desktopState: DesktopStateFile | null = null;
let quitting = false;
let pausedUntil = 0;
let pauseTimer: NodeJS.Timeout | null = null;
let attentionCount = 0;
let titleBar: TitleBarColors = DEFAULT_TITLE_BAR;
const startHidden = process.argv.includes('--hidden');
let pendingMaximize = false;

if (!app.requestSingleInstanceLock()) {
  // Another window is already open for this profile; it gets our 'second-instance' and shows itself
  app.exit(0);
} else {
  app.on('second-instance', () => showWindow(mainWindow));
  app.on('window-all-closed', () => {
    // Keep running in the tray: agents live in this process
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit();
  });
  void app.whenReady().then(boot);
}

// ---------- server ----------

function readToken(): string | null {
  try {
    return fs.readFileSync(tokenFilePath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function answers(origin: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/state`, {
      headers: { 'x-agentarmy-token': token },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function connectBackend(): Promise<Backend> {
  // `npx agentarmy` already runs on this data folder: show its board instead of fighting over state.json
  const lock = readLiveInstanceLock();
  if (lock) {
    const origin = `http://127.0.0.1:${lock.port}`;
    const token = readToken();
    if (token && (await answers(origin, token))) {
      console.log(`[agentarmy] attached to the running server (pid ${lock.pid}) at ${origin}`);
      return { url: `${origin}/?token=${token}`, origin, owned: null };
    }
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'AgentArmy',
      message: 'Another AgentArmy server seems to be running, but it does not answer.',
      detail: `Process ${lock.pid} holds ${lockFilePath()}. Start a new server anyway? Only do this if that process is not AgentArmy.`,
      buttons: ['Start a new server', 'Quit'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) throw new Error('cancelled');
    fs.rmSync(lockFilePath(), { force: true });
  }
  const port = Number(process.env.AGENTARMY_PORT) || DEFAULT_PORT;
  const handle = await startAgentArmy({ port, open: false, resumeAll: process.argv.includes('--resume-all') });
  console.log(`AgentArmy is running: ${handle.url}`);
  return { url: handle.url, origin: new URL(handle.url).origin, owned: handle };
}

// ---------- windows ----------

function isAppUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    return !!backend && new URL(url).origin === backend.origin;
  } catch {
    return false;
  }
}

function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url);
  } catch {
    // not a URL
  }
}

function windowOptions(): BrowserWindowConstructorOptions {
  return {
    backgroundColor: titleBar.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBar, height: DESKTOP_TITLE_BAR_HEIGHT },
    icon: path.join(ICON_DIR, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--agentarmy-version=${VERSION}`],
    },
  };
}

// Applied to the main window and every pop-out it opens
function wireContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    // Same-origin pop-outs (console / project / settings windows) become real child windows.
    // The frame name from window.open(url, name) is kept, so popout.ts can find and focus them.
    if (isAppUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: windowOptions() };
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('did-create-window', (child) => {
    wireContents(child.webContents);
  });
  contents.on('did-finish-load', () => contents.send(IPC.notificationsPaused, pausedUntil));
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      contents.toggleDevTools();
      event.preventDefault();
    } else if (input.control && input.shift && key === 'r') {
      contents.reloadIgnoringCache();
      event.preventDefault();
    }
  });
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(`[agentarmy] renderer gone (${details.reason}), reloading`);
    setTimeout(() => {
      if (!contents.isDestroyed()) contents.reload();
    }, 1000);
  });
}

function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (win === mainWindow && pendingMaximize) {
    pendingMaximize = false;
    win.maximize();
  }
  win.show();
  win.focus();
}

function toggleMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow(mainWindow);
}

function rememberBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const b = win.getNormalBounds();
  desktopState?.update({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } });
}

function createMainWindow(url: string): BrowserWindow {
  const saved = restoreBounds(
    desktopState?.get().window,
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    ...windowOptions(),
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'AgentArmy',
  });
  wireContents(win.webContents);
  win.once('ready-to-show', () => {
    // maximize() also shows the window, so a --hidden start (Start with Windows) defers it
    if (startHidden) pendingMaximize = saved.maximized;
    else {
      if (saved.maximized) win.maximize();
      win.show();
    }
  });
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    win.on(event as 'resize', () => rememberBounds(win));
  }
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (event) => {
    rememberBounds(win);
    desktopState?.flush();
    if (quitting) return;
    // The window hides; the agents (and this process) keep running in the tray
    event.preventDefault();
    win.hide();
    showCloseNoticeOnce();
  });
  // Windows log-off / shutdown: save the board synchronously, there is no time for dialogs
  win.on('session-end', () => {
    quitting = true;
    void backend?.owned?.close();
  });
  void win.loadURL(url);
  return win;
}

function showCloseNoticeOnce(): void {
  if (!desktopState || desktopState.get().closeNoticeShown) return;
  desktopState.update({ closeNoticeShown: true }, { now: true });
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'AgentArmy is still running',
    body: 'Your agents keep working in the background. Open AgentArmy from the tray icon or press Ctrl+Alt+A.',
    icon: path.join(ICON_DIR, 'icon.png'),
  }).show();
}

// ---------- attention, tray, notifications ----------

function broadcastPause(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.notificationsPaused, pausedUntil);
  }
}

function togglePause(): void {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  pausedUntil = pausedUntil > Date.now() ? 0 : Date.now() + PAUSE_MS;
  if (pausedUntil) {
    pauseTimer = setTimeout(() => {
      pausedUntil = 0;
      broadcastPause();
      tray?.update({ pausedUntil: 0 });
    }, PAUSE_MS);
  }
  broadcastPause();
  tray?.update({ pausedUntil });
}

function flyTo(consoleId: string | null): void {
  showWindow(mainWindow);
  mainWindow?.webContents.send(IPC.flyTo, consoleId);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function registerIpc(): void {
  ipcMain.on(IPC.titleBarColors, (event, colors: TitleBarColors) => {
    if (!colors || !HEX_COLOR.test(colors.color) || !HEX_COLOR.test(colors.symbolColor)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: DESKTOP_TITLE_BAR_HEIGHT });
    win.setBackgroundColor(colors.color);
    if (win === mainWindow && (colors.color !== titleBar.color || colors.symbolColor !== titleBar.symbolColor)) {
      titleBar = { color: colors.color, symbolColor: colors.symbolColor };
      desktopState?.update({ titleBar });
    }
  });

  ipcMain.on(IPC.attention, (event, payload: { count: number; items: AttentionItem[]; badge: string | null }) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !payload) return;
    const count = Number.isInteger(payload.count) && payload.count > 0 ? payload.count : 0;
    const items = Array.isArray(payload.items) ? payload.items : [];
    const previous = attentionCount;
    attentionCount = count;
    tray?.update({ count, items });
    if (process.platform === 'win32') {
      const badge =
        count > 0 && typeof payload.badge === 'string' && payload.badge.startsWith('data:image/png;base64,')
          ? nativeImage.createFromDataURL(payload.badge)
          : null;
      mainWindow.setOverlayIcon(badge, count > 0 ? needsYouText(count) : '');
    }
    if (count > previous && !mainWindow.isFocused() && Date.now() >= pausedUntil) mainWindow.flashFrame(true);
    if (count === 0) mainWindow.flashFrame(false);
  });

  ipcMain.on(IPC.focusWindow, (event) => showWindow(BrowserWindow.fromWebContents(event.sender)));
}

function loginItemState(): boolean | null {
  if (!app.isPackaged || process.platform === 'linux') return null;
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function createTray(): void {
  tray = new DesktopTray(
    ICON_DIR,
    { count: 0, items: [], pausedUntil: 0, openAtLogin: loginItemState(), update: { kind: 'idle' } },
    {
      open: () => showWindow(mainWindow),
      flyTo,
      togglePause,
      toggleOpenAtLogin: () => {
        const next = !loginItemState();
        app.setLoginItemSettings({ openAtLogin: next, args: ['--hidden'] });
        tray?.update({ openAtLogin: loginItemState() });
      },
      checkForUpdates: () => void updater?.check(true),
      restartToUpdate: () => updater?.install(),
      quit: () => void requestQuit(),
    },
  );
}

function setUpdateState(update: UpdateState): void {
  tray?.update({ update });
  if (update.kind === 'ready' && Notification.isSupported()) {
    new Notification({
      title: `AgentArmy ${update.version} is ready`,
      body: 'Choose "Restart to update" in the tray menu, or it installs when you quit.',
      icon: path.join(ICON_DIR, 'icon.png'),
    }).show();
  }
}

// ---------- quit ----------

async function stopEverything(): Promise<void> {
  quitting = true;
  updater?.stop();
  globalShortcut.unregisterAll();
  desktopState?.flush();
  const closing = backend?.owned?.close() ?? Promise.resolve();
  // Never hang on a stuck socket
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 3000))]);
  tray?.destroy();
  tray = null;
}

async function requestQuit(): Promise<void> {
  if (quitting) return;
  const running = backend?.owned?.runningCount() ?? 0;
  if (running > 0) {
    if (mainWindow && !mainWindow.isVisible()) showWindow(mainWindow);
    const options = {
      type: 'question' as const,
      title: 'Quit AgentArmy',
      message: `Quit AgentArmy? ${running} ${running === 1 ? 'agent is' : 'agents are'} running.`,
      detail: 'Agents stop and can be resumed next time.',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return;
  }
  await stopEverything();
  app.quit();
}

// ---------- start ----------

function lockDownPermissions(): void {
  // Only our own pages get notifications / clipboard / the microphone (voice dictation, audio only);
  // nothing else is ever granted
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media'];
    const audioOnly = permission !== 'media' || ((details as { mediaTypes?: string[] }).mediaTypes ?? []).every((t) => t === 'audio');
    callback(isAppUrl(contents.getURL()) && allowed.includes(permission) && audioOnly);
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
    const allowed = ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media'];
    const audioOnly = permission !== 'media' || (details as { mediaType?: string }).mediaType !== 'video';
    return isAppUrl(origin) && allowed.includes(permission) && audioOnly;
  });
}

async function boot(): Promise<void> {
  // Native toasts (web Notifications too) are grouped under this id; the installer's shortcuts carry it
  app.setAppUserModelId(APP_ID);
  // No menu bar: frees Alt+<key>, Ctrl+R, Ctrl+W... for the board's own shortcuts
  Menu.setApplicationMenu(null);
  desktopState = new DesktopStateFile(path.join(app.getPath('userData'), 'desktop-state.json'));
  titleBar = desktopState.get().titleBar ?? DEFAULT_TITLE_BAR;

  try {
    backend = await connectBackend();
  } catch (err) {
    if ((err as Error).message !== 'cancelled') {
      dialog.showErrorBox('AgentArmy could not start', `${(err as Error).message}\n\nData folder: ${agentArmyHome()}`);
    }
    quitting = true;
    app.exit(1);
    return;
  }

  lockDownPermissions();
  registerIpc();
  mainWindow = createMainWindow(backend.url);
  createTray();
  if (!globalShortcut.register('CommandOrControl+Alt+A', toggleMainWindow)) {
    console.warn('[agentarmy] Ctrl+Alt+A is taken by another app; the show/hide shortcut is off');
  }
  updater = startUpdater({
    onState: setUpdateState,
    onMessage: (title, message) => {
      void dialog.showMessageBox({ type: 'info', title, message, buttons: ['OK'] });
    },
    beforeInstall: stopEverything,
  });
}

process.on('uncaughtException', (err) => console.error('[agentarmy] uncaught exception', err));

// Read-only peek for the Playwright smoke test (tests/desktop): tray state and the tray's fly-to action
(globalThis as { __agentarmyDesktop?: unknown }).__agentarmyDesktop = {
  tray: () => tray?.current ?? null,
  flyTo: (consoleId: string | null) => flyTo(consoleId),
  ownsServer: () => !!backend?.owned,
};
