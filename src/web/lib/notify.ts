import type { ConsoleInfo } from '../../shared/protocol';
import { flyTo } from './board-actions';
import { useBoard } from './store';

const BASE_TITLE = 'AgentArmy';

// Browsers only show the permission prompt reliably from a user gesture, and asking on load is rude
function requestPermissionOnFirstGesture(): void {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const ask = () => {
    window.removeEventListener('pointerdown', ask, true);
    window.removeEventListener('keydown', ask, true);
    if (Notification.permission === 'default') void Notification.requestPermission();
  };
  window.addEventListener('pointerdown', ask, true);
  window.addEventListener('keydown', ask, true);
}

function showNotification(console: ConsoleInfo): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Looking right at the board already shows the glow; only ping when the user is elsewhere
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const notification = new Notification(`${console.name} needs you`, {
      body: console.statusDetail || 'Claude Code is waiting for your input.',
      tag: `agentarmy-${console.id}`,
      icon: '/icon.svg',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      void flyTo(console.id);
    };
  } catch {
    // Some platforms (e.g. Android Chrome) only allow notifications from a service worker
  }
}

// ---------- favicon badge ----------

let baseFaviconHref: string | null = null;

function drawBadgedFavicon(count: number): string {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseFaviconHref ?? '';

  const tile = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, 18, 18, 4);
    ctx.fill();
  };
  ctx.fillStyle = '#0f1116';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, 14);
  ctx.fill();
  tile(12, 12, '#4c8dff');
  tile(34, 12, '#2fbf71');
  tile(12, 34, '#f5a524');
  tile(34, 34, '#3a3f4b');

  ctx.fillStyle = '#f5a524';
  ctx.strokeStyle = '#0f1116';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(44, 44, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), 44, 46);
  return canvas.toDataURL('image/png');
}

function setFavicon(count: number): void {
  const link = document.getElementById('aa-favicon') as HTMLLinkElement | null;
  if (!link) return;
  if (baseFaviconHref === null) baseFaviconHref = link.href;
  if (count > 0) {
    link.type = 'image/png';
    link.href = drawBadgedFavicon(count);
  } else {
    link.type = 'image/svg+xml';
    link.href = baseFaviconHref;
  }
}

let lastCount = -1;

function updateAttention(consoles: Record<string, ConsoleInfo>): void {
  const count = Object.values(consoles).filter((c) => c.status === 'needs_you').length;
  if (count === lastCount) return;
  lastCount = count;
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  setFavicon(count);
}

export function startNotifications(): void {
  requestPermissionOnFirstGesture();
  updateAttention(useBoard.getState().consoles);
  useBoard.subscribe((state, prev) => {
    if (state.consoles === prev.consoles) return;
    updateAttention(state.consoles);
    for (const c of Object.values(state.consoles)) {
      const before = prev.consoles[c.id];
      if (before && before.status !== 'needs_you' && c.status === 'needs_you') showNotification(c);
    }
  });
}
