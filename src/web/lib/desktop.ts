import type { AgentArmyDesktopApi, AttentionItem } from '../../shared/desktop-api';
import { flyTo } from './board-actions';
import { attentionCount, openActions, uncoveredNeedsYou } from './fleet';
import { useBoard } from './store';
import { subscribeTheme } from './theme';

// Bridge to the Windows desktop app (src/desktop). In a normal browser tab `desktop` is null and
// nothing here runs.

declare global {
  interface Window {
    agentarmyDesktop?: AgentArmyDesktopApi;
  }
}

export const desktop: AgentArmyDesktopApi | null =
  typeof window !== 'undefined' && window.agentarmyDesktop?.isDesktop ? window.agentarmyDesktop : null;

export const isDesktop = desktop !== null;

function toHex(color: string): string | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color);
  if (!m) return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

// Window buttons (drawn by Windows over our title strip) follow the page theme
function syncTitleBarColors(): void {
  if (!desktop) return;
  const strip = document.querySelector<HTMLElement>('[data-desktop-titlebar]');
  const style = getComputedStyle(strip ?? document.body);
  const color = toHex(style.backgroundColor);
  const symbolColor = toHex(style.color);
  if (color && symbolColor) desktop.setTitleBarColors({ color, symbolColor });
}

export function startDesktopChrome(): void {
  if (!desktop) return;
  document.documentElement.classList.add('aa-desktop');
  // After paint, so the theme tokens are on <html> and the strip exists
  requestAnimationFrame(syncTitleBarColors);
  subscribeTheme(() => requestAnimationFrame(syncTitleBarColors));
}

function attentionItems(): AttentionItem[] {
  const { consoles, actions } = useBoard.getState();
  const items: AttentionItem[] = [];
  const nameOf = (id: string | null | undefined) => (id ? consoles[id]?.name : undefined);
  for (const action of openActions(actions)) {
    const name = nameOf(action.consoleId);
    items.push({ consoleId: action.consoleId ?? null, label: name ? `${name}: ${action.title}` : action.title });
  }
  for (const c of uncoveredNeedsYou(consoles, actions)) {
    items.push({ consoleId: c.id, label: `${c.name} needs you` });
  }
  return items;
}

let lastSent = '';

function sendAttention(): void {
  if (!desktop) return;
  const { consoles, actions } = useBoard.getState();
  const count = attentionCount(consoles, actions);
  const items = attentionItems();
  const key = JSON.stringify([count, items]);
  if (key === lastSent) return;
  lastSent = key;
  desktop.setAttention(count, items);
}

// Main board only: tray menu + taskbar badge, and the tray's "fly to this console"
export function startDesktopBoard(): void {
  if (!desktop) return;
  sendAttention();
  useBoard.subscribe((state, prev) => {
    if (state.consoles !== prev.consoles || state.actions !== prev.actions) sendAttention();
  });
  desktop.onFlyTo((consoleId) => {
    if (consoleId && useBoard.getState().consoles[consoleId]) void flyTo(consoleId);
    else useBoard.getState().setSidebarTab('actions');
  });
}
