// Sandboxed preload (CommonJS, only 'electron' is requireable). Exposes window.agentarmyDesktop.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AgentArmyDesktopApi, type AttentionItem, type TitleBarColors } from '../shared/desktop-api';

const versionArg = process.argv.find((arg) => arg.startsWith('--agentarmy-version='));
const version = versionArg ? versionArg.slice('--agentarmy-version='.length) : 'unknown';

let pausedUntil = 0;
ipcRenderer.on(IPC.notificationsPaused, (_event, until: number) => {
  pausedUntil = typeof until === 'number' ? until : 0;
});

// Taskbar overlay badge: main has no canvas, the page does. 32 px, drawn at 2x for crisp HiDPI.
function drawBadge(count: number): string | null {
  if (count <= 0) return null;
  try {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#f5a524';
    ctx.strokeStyle = '#140f0c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#140f0c';
    const text = count > 9 ? '9+' : String(count);
    ctx.font = `bold ${text.length > 1 ? 15 : 19}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 1);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function cleanItems(items: AttentionItem[]): AttentionItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.label === 'string')
    .slice(0, 20)
    .map((item) => ({
      consoleId: typeof item.consoleId === 'string' ? item.consoleId : null,
      label: item.label.slice(0, 120),
    }));
}

const api: AgentArmyDesktopApi = {
  isDesktop: true,
  version,
  platform: process.platform,
  setTitleBarColors(colors: TitleBarColors) {
    if (!colors || typeof colors.color !== 'string' || typeof colors.symbolColor !== 'string') return;
    ipcRenderer.send(IPC.titleBarColors, { color: colors.color, symbolColor: colors.symbolColor });
  },
  setAttention(count: number, items: AttentionItem[]) {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    ipcRenderer.send(IPC.attention, { count: n, items: cleanItems(items), badge: drawBadge(n) });
  },
  focusWindow() {
    ipcRenderer.send(IPC.focusWindow);
  },
  onFlyTo(listener) {
    const handler = (_event: unknown, consoleId: unknown) =>
      listener(typeof consoleId === 'string' ? consoleId : null);
    ipcRenderer.on(IPC.flyTo, handler);
    return () => {
      ipcRenderer.removeListener(IPC.flyTo, handler);
    };
  },
  notificationsPaused() {
    return Date.now() < pausedUntil;
  },
  async takeRecipe() {
    const code: unknown = await ipcRenderer.invoke(IPC.takeRecipe);
    return typeof code === 'string' ? code : null;
  },
  onRecipe(listener) {
    const handler = (_event: unknown, code: unknown) => {
      if (typeof code === 'string') listener(code);
    };
    ipcRenderer.on(IPC.recipe, handler);
    return () => {
      ipcRenderer.removeListener(IPC.recipe, handler);
    };
  },
};

contextBridge.exposeInMainWorld('agentarmyDesktop', api);
