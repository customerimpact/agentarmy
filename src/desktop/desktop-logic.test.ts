import { describe, expect, it, vi } from 'vitest';
import { pickDesktopRelease } from './release-feed';
import { MAX_TRAY_ITEMS, trayMenuTemplate, trayTooltip, type TrayActions, type TrayState } from './tray-menu';
import { DEFAULT_BOUNDS, restoreBounds } from './window-state';

const actions = (): TrayActions => ({
  open: vi.fn(),
  flyTo: vi.fn(),
  togglePause: vi.fn(),
  toggleOpenAtLogin: vi.fn(),
  checkForUpdates: vi.fn(),
  restartToUpdate: vi.fn(),
  quit: vi.fn(),
});

const base: TrayState = { count: 0, items: [], pausedUntil: 0, openAtLogin: false, update: { kind: 'idle' } };

describe('tray', () => {
  it('tooltip counts who needs you', () => {
    expect(trayTooltip(0)).toBe('AgentArmy');
    expect(trayTooltip(1)).toBe('AgentArmy — 1 needs you');
    expect(trayTooltip(3)).toBe('AgentArmy — 3 need you');
  });

  it('lists up to 8 consoles that need you and flies to the clicked one', () => {
    const a = actions();
    const items = Array.from({ length: 10 }, (_, i) => ({ consoleId: `c${i}`, label: `Agent ${i} needs you` }));
    const menu = trayMenuTemplate({ ...base, count: 10, items }, a);
    const labels = menu.map((m) => m.label);
    expect(labels).toContain('Agent 0 needs you');
    expect(labels).toContain(`Agent ${MAX_TRAY_ITEMS - 1} needs you`);
    expect(labels).not.toContain(`Agent ${MAX_TRAY_ITEMS} needs you`);
    expect(labels).toContain('2 more…');
    menu.find((m) => m.label === 'Agent 3 needs you')!.click!({} as never, undefined, {} as never);
    expect(a.flyTo).toHaveBeenCalledWith('c3');
  });

  it('shows pause, start-with-Windows, updates and quit', () => {
    const now = new Date(2026, 9, 18, 12, 0).getTime();
    const paused = trayMenuTemplate({ ...base, pausedUntil: now + 60_000 }, actions(), now);
    expect(paused.find((m) => m.type === 'checkbox' && m.label?.startsWith('Notifications paused'))?.checked).toBe(true);
    const idle = trayMenuTemplate(base, actions(), now);
    expect(idle.find((m) => m.label === 'Pause notifications 1 h')?.checked).toBe(false);
    expect(idle.map((m) => m.label)).toContain('Start with Windows');
    expect(trayMenuTemplate({ ...base, openAtLogin: null }, actions()).map((m) => m.label)).not.toContain('Start with Windows');
    expect(idle.map((m) => m.label)).toContain('Check for updates');
    expect(trayMenuTemplate({ ...base, update: { kind: 'ready', version: '1.2.3' } }, actions()).map((m) => m.label)).toContain(
      'Restart to update (v1.2.3)',
    );
    expect(idle.at(-1)?.label).toBe('Quit AgentArmy');
  });
});

describe('restoreBounds', () => {
  const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it('falls back to defaults for missing or broken state', () => {
    expect(restoreBounds(undefined, screen)).toEqual(DEFAULT_BOUNDS);
    expect(restoreBounds({ width: 10, height: 10, maximized: false }, screen)).toEqual(DEFAULT_BOUNDS);
  });

  it('keeps an on-screen position and the maximized flag', () => {
    expect(restoreBounds({ x: 100, y: 50, width: 1200, height: 800, maximized: true }, screen)).toEqual({
      x: 100,
      y: 50,
      width: 1200,
      height: 800,
      maximized: true,
    });
  });

  it('drops a position on a monitor that is gone', () => {
    const bounds = restoreBounds({ x: 3000, y: 100, width: 1200, height: 800, maximized: false }, screen);
    expect(bounds.x).toBeUndefined();
    expect(bounds.width).toBe(1200);
  });
});

describe('pickDesktopRelease', () => {
  it('takes the newest published desktop-v* release that has latest.yml', () => {
    const tag = pickDesktopRelease([
      { tag_name: 'desktop-v0.3.0', draft: true, prerelease: false, assets: [{ name: 'latest.yml' }] },
      { tag_name: 'v0.2.5', draft: false, prerelease: false, assets: [] },
      { tag_name: 'desktop-v0.2.1', draft: false, prerelease: false, assets: [{ name: 'latest.yml' }] },
      { tag_name: 'desktop-v0.2.0', draft: false, prerelease: false, assets: [{ name: 'latest.yml' }] },
    ]);
    expect(tag).toBe('desktop-v0.2.1');
    expect(pickDesktopRelease([{ tag_name: 'v1.0.0', draft: false, prerelease: false }])).toBeNull();
  });
});
