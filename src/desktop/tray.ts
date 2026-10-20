import path from 'node:path';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { trayMenuTemplate, trayTooltip, type TrayActions, type TrayState } from './tray-menu';

export { needsYouText, type UpdateState } from './tray-menu';

export class DesktopTray {
  private tray: Tray;
  private normal: NativeImage;
  private attention: NativeImage;
  private state: TrayState;

  constructor(iconDir: string, initial: TrayState, private readonly actions: TrayActions) {
    // tray.png + tray@2x.png: Electron picks the @2x variant on HiDPI screens
    this.normal = nativeImage.createFromPath(path.join(iconDir, 'tray.png'));
    this.attention = nativeImage.createFromPath(path.join(iconDir, 'tray-attention.png'));
    this.state = initial;
    this.tray = new Tray(this.normal);
    this.tray.on('click', () => actions.open());
    this.tray.on('double-click', () => actions.open());
    this.render();
  }

  update(patch: Partial<TrayState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  get current(): TrayState {
    return this.state;
  }

  private render(): void {
    if (this.tray.isDestroyed()) return;
    this.tray.setImage(this.state.count > 0 && !this.attention.isEmpty() ? this.attention : this.normal);
    this.tray.setToolTip(trayTooltip(this.state.count));
    this.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(this.state, this.actions, Date.now(), process.platform)));
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
