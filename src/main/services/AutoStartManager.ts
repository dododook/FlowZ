import { app } from 'electron';
import type { LogLevel } from '../../shared/types';
import type { LogManager } from './LogManager';

export interface IAutoStartManager {
  setAutoStart(enabled: boolean): Promise<boolean>;
  isAutoStartEnabled(): Promise<boolean>;
  setLogManager(lm: LogManager): void;
}

/**
 * 两个实现共用的日志混入：注入 LogManager（由主流程在 index.ts 统一注入）；
 * 注入前走 console fallback。Source 固定 'AutoStart'。
 */
abstract class AutoStartLogBase {
  protected logManager?: LogManager;

  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  protected log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'AutoStart');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }
}

class ElectronAutoStart extends AutoStartLogBase implements IAutoStartManager {
  async setAutoStart(enabled: boolean): Promise<boolean> {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe'),
    });
    this.log('info', `Set openAtLogin: ${enabled}`);
    return true;
  }

  async isAutoStartEnabled(): Promise<boolean> {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  }
}

class LinuxAutoStart extends AutoStartLogBase implements IAutoStartManager {
  private get autostartDir(): string {
    const home = process.env.HOME || '';
    return require('path').join(home, '.config', 'autostart');
  }

  private get desktopFilePath(): string {
    return require('path').join(this.autostartDir, 'flowz.desktop');
  }

  async setAutoStart(enabled: boolean): Promise<boolean> {
    const fs = require('fs/promises');

    try {
      if (enabled) {
        await fs.mkdir(this.autostartDir, { recursive: true });

        const desktopContent = `[Desktop Entry]
Type=Application
Version=1.0
Name=FlowZ
Comment=FlowZ Proxy Client
Exec="${app.getPath('exe')}" --hidden
Icon=${require('./ResourceManager').resourceManager.getAppIconPath()}
Terminal=false
Categories=Network;Proxy;
X-GNOME-Autostart-enabled=true
`;
        await fs.writeFile(this.desktopFilePath, desktopContent, 'utf-8');
      } else {
        await fs.unlink(this.desktopFilePath).catch(() => {});
      }
      return true;
    } catch (error) {
      this.log('error', `Failed to set Linux autostart: ${error}`);
      return false;
    }
  }

  async isAutoStartEnabled(): Promise<boolean> {
    const fs = require('fs/promises');
    try {
      await fs.access(this.desktopFilePath);
      return true;
    } catch {
      return false;
    }
  }
}

export function createAutoStartManager(): IAutoStartManager {
  if (process.platform === 'linux') {
    return new LinuxAutoStart();
  }
  return new ElectronAutoStart();
}
