import type { MenuItemConstructorOptions } from 'electron';
import type { AttentionItem } from '../shared/desktop-api';

// Tray menu content, kept free of Electron runtime imports so it is unit-testable

export const MAX_TRAY_ITEMS = 8;

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'available'; version: string } // macOS: a newer build to download from the website
  | { kind: 'disabled' };

export interface TrayState {
  count: number;
  items: AttentionItem[];
  pausedUntil: number;
  openAtLogin: boolean | null; // null: not offered (dev / unpacked runs)
  update: UpdateState;
}

export interface TrayActions {
  open(): void;
  flyTo(consoleId: string | null): void;
  togglePause(): void;
  toggleOpenAtLogin(): void;
  checkForUpdates(): void;
  restartToUpdate(): void;
  quit(): void;
}

export function needsYouText(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}

export function trayTooltip(count: number): string {
  return count > 0 ? `GridHive — ${needsYouText(count)}` : 'GridHive';
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Pure, so the menu layout is unit-testable without Electron
export function trayMenuTemplate(
  state: TrayState,
  actions: TrayActions,
  now = Date.now(),
  platform: NodeJS.Platform = 'win32',
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [{ label: 'Open GridHive', click: () => actions.open() }];

  if (state.count > 0) {
    template.push({ type: 'separator' }, { label: needsYouText(state.count), enabled: false });
    for (const item of state.items.slice(0, MAX_TRAY_ITEMS)) {
      template.push({ label: item.label, click: () => actions.flyTo(item.consoleId) });
    }
    if (state.items.length > MAX_TRAY_ITEMS) {
      template.push({ label: `${state.items.length - MAX_TRAY_ITEMS} more…`, click: () => actions.flyTo(null) });
    }
  }

  template.push({ type: 'separator' });
  const paused = state.pausedUntil > now;
  template.push({
    label: paused ? `Notifications paused until ${clock(state.pausedUntil)}` : 'Pause notifications 1 h',
    type: 'checkbox',
    checked: paused,
    click: () => actions.togglePause(),
  });
  if (state.openAtLogin !== null) {
    template.push({
      label: platform === 'darwin' ? 'Open at login' : 'Start with Windows',
      type: 'checkbox',
      checked: state.openAtLogin,
      click: () => actions.toggleOpenAtLogin(),
    });
  }

  template.push({ type: 'separator' });
  const update = state.update;
  if (update.kind === 'available') {
    template.push({ label: `Download v${update.version}…`, click: () => actions.restartToUpdate() });
  } else if (update.kind === 'ready') {
    template.push({ label: `Restart to update (v${update.version})`, click: () => actions.restartToUpdate() });
  } else if (update.kind === 'downloading') {
    template.push({ label: `Downloading v${update.version}…`, enabled: false });
  } else {
    template.push({
      label: update.kind === 'checking' ? 'Checking for updates…' : 'Check for updates',
      enabled: update.kind === 'idle',
      click: () => actions.checkForUpdates(),
    });
  }
  template.push({ type: 'separator' }, { label: 'Quit GridHive', click: () => actions.quit() });
  return template;
}
