import { useSyncExternalStore } from 'react';
import type { ActionItem, ConsoleInfo } from '../../shared/protocol';
import { desktop } from './desktop';
import { openAttention } from './inbox-focus';
import { attentionCount, projectOf } from './fleet';
import { getPrefs } from './prefs';
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

// ---------- sound (short WebAudio chime, toggle stored per browser) ----------

const SOUND_KEY = 'agentarmy.sound';
const soundListeners = new Set<() => void>();
let audio: AudioContext | null = null;
let lastBeep = 0;

export function isSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

// Plays the chime now, for the Settings volume slider preview
export function testSound(): void {
  beep(true);
}

export function setSoundEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked: the toggle just won't persist
  }
  for (const listener of soundListeners) listener();
  if (on) beep(true);
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore((listener) => {
    soundListeners.add(listener);
    return () => soundListeners.delete(listener);
  }, isSoundEnabled);
}

// AudioContext may only start after a user gesture; create it on the first one
function unlockAudioOnGesture(): void {
  const unlock = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    try {
      audio ??= new AudioContext();
      void audio.resume();
    } catch {
      audio = null;
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

function beep(force = false): void {
  if (!force && !isSoundEnabled()) return;
  const now = Date.now();
  if (!force && now - lastBeep < 1500) return;
  lastBeep = now;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const t = audio.currentTime;
    // Settings > Notifications > Volume (exponential ramps cannot reach 0, so skip when muted)
    const peak = 0.12 * getPrefs().soundVolume;
    if (peak <= 0.0002) return;
    // Two soft rising tones
    for (const [offset, freq] of [
      [0, 660],
      [0.12, 880],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + offset);
      gain.gain.exponentialRampToValueAtTime(peak, t + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + offset);
      osc.stop(t + offset + 0.2);
    }
  } catch {
    // no audio device or autoplay blocked
  }
}

// ---------- desktop notifications ----------

// One ping per console per few seconds: the status change and its action item arrive together
const lastPingByConsole = new Map<string, number>();
const PING_DEDUPE_MS = 4000;

function titleFor(c: ConsoleInfo | undefined, suffix: string): string {
  if (!c) return suffix;
  const project = projectOf(c, useBoard.getState().projects);
  return `${project ? `${project.name} · ` : ''}${c.name} ${suffix}`;
}

function ping(consoleId: string | null, title: string, body: string, tag: string): void {
  if (consoleId) {
    const last = lastPingByConsole.get(consoleId) ?? 0;
    if (Date.now() - last < PING_DEDUPE_MS) return;
    lastPingByConsole.set(consoleId, Date.now());
  }
  // Desktop app tray: "Pause notifications 1 h" silences the chime and the toasts
  if (desktop?.notificationsPaused()) return;
  beep();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Looking right at the board already shows the glow; only notify when the user is elsewhere
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const notification = new Notification(title, { body, tag, icon: '/icon.svg' });
    notification.onclick = () => {
      window.focus();
      // The desktop window may be hidden in the tray; window.focus() alone cannot show it
      desktop?.focusWindow();
      notification.close();
      // Answerable dialogs and stuck alerts open their Actions item; the rest fly to the console
      openAttention(consoleId);
    };
  } catch {
    // Some platforms (e.g. Android Chrome) only allow notifications from a service worker
  }
}

function notifyConsole(c: ConsoleInfo): void {
  ping(
    c.id,
    titleFor(c, 'needs you'),
    c.statusDetail || 'Claude Code is waiting for your input.',
    `agentarmy-${c.id}`,
  );
}

function notifyAction(action: ActionItem): void {
  const c = action.consoleId ? useBoard.getState().consoles[action.consoleId] : undefined;
  const suffix =
    action.kind === 'needs_you'
      ? 'needs you'
      : action.kind === 'error'
        ? 'hit an error'
        : action.kind === 'stuck'
          ? 'may be stuck'
          : 'asks for something';
  const title = c ? titleFor(c, suffix) : action.title;
  const body = c
    ? [action.title, action.detail].filter(Boolean).join(' — ')
    : (action.detail ?? '');
  ping(
    action.consoleId,
    title,
    body || 'Open AgentArmy to take a look.',
    `agentarmy-${action.consoleId ?? action.id}`,
  );
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

function updateAttention(): void {
  const { consoles, actions } = useBoard.getState();
  const count = attentionCount(consoles, actions);
  if (count === lastCount) return;
  lastCount = count;
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  setFavicon(count);
}

const seenActions = new Set<string>();

export function startNotifications(): void {
  requestPermissionOnFirstGesture();
  unlockAudioOnGesture();
  // Items that were already open on load don't ping again
  for (const id of Object.keys(useBoard.getState().actions)) seenActions.add(id);
  updateAttention();
  useBoard.subscribe((state, prev) => {
    if (state.consoles === prev.consoles && state.actions === prev.actions) return;
    updateAttention();
    if (state.actions !== prev.actions) {
      for (const action of Object.values(state.actions)) {
        if (seenActions.has(action.id)) continue;
        seenActions.add(action.id);
        if (!action.resolvedAt) notifyAction(action);
      }
    }
    if (state.consoles !== prev.consoles) {
      for (const c of Object.values(state.consoles)) {
        const before = prev.consoles[c.id];
        if (before && before.status !== 'needs_you' && c.status === 'needs_you') notifyConsole(c);
      }
    }
  });
}
