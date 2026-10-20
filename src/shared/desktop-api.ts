// window.agentarmyDesktop: the tiny API the desktop app's preload exposes to the web UI.
// Absent in a normal browser tab, so every call site checks for it first.

export interface AttentionItem {
  consoleId: string | null; // null: an inbox item without a console
  label: string; // "Ada needs you", shown in the tray menu
}

export interface TitleBarColors {
  color: string; // title bar background (behind the window buttons)
  symbolColor: string; // minimize / maximize / close glyphs
}

export interface AgentArmyDesktopApi {
  isDesktop: true;
  version: string;
  platform: string;
  setTitleBarColors(colors: TitleBarColors): void;
  // Drives the tray tooltip/menu, the taskbar badge and the taskbar flash
  setAttention(count: number, items: AttentionItem[]): void;
  // Bring this window to the front (notification clicks while it hides in the tray)
  focusWindow(): void;
  // Tray "needs you" item clicked: fly to that console (null: open the inbox)
  onFlyTo(listener: (consoleId: string | null) => void): () => void;
  // Tray "Pause notifications 1 h"
  notificationsPaused(): boolean;
  // gridhive://recipe links: the one the app was opened with (asked once at startup), then live ones
  takeRecipe(): Promise<string | null>;
  onRecipe(listener: (code: string) => void): () => void;
}

export const DESKTOP_TITLE_BAR_HEIGHT = 32;

// IPC channel names shared by main and preload
export const IPC = {
  titleBarColors: 'agentarmy:title-bar-colors',
  attention: 'agentarmy:attention',
  focusWindow: 'agentarmy:focus-window',
  flyTo: 'agentarmy:flyto',
  notificationsPaused: 'agentarmy:notifications-paused',
  takeRecipe: 'agentarmy:take-recipe',
  recipe: 'agentarmy:recipe',
} as const;
