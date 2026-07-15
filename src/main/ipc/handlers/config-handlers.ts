import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { UserConfig, ProxyMode } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';
import { ipcEventEmitter } from '../ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';
import { clearSingboxDashboardCache } from './helper-handlers';

export function registerConfigHandlers(configManager: ConfigManager): void {
  registerIpcHandler<void, UserConfig>(
    IPC_CHANNELS.CONFIG_GET,
    async (_event: IpcMainInvokeEvent) => {
      const cfg = await configManager.loadConfig();
      // F29：绝不向渲染端下发隐私密码（迁移前的残留明文也一并剥除；哈希本就不在 config 内）
      return { ...cfg, privacyPassword: undefined };
    }
  );

  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.CONFIG_SAVE,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      // 检测面板 download_url 覆盖变更：改了 → 删本地缓存目录，使核下次启动（CONFIG_CHANGED→switchMode 重启）
      // 因目录为空从新 URL 重拉资源。空白归一为 undefined 再比，避免 ''↔undefined 误判变更。在 saveConfig 前取旧值。
      const priorDashUrl = configManager.get<string>('singboxDashboardUrl')?.trim() || undefined;
      const nextDashUrl = config.singboxDashboardUrl?.trim() || undefined;
      if (priorDashUrl !== nextDashUrl) {
        clearSingboxDashboardCache();
      }

      await configManager.saveConfig(config);

      if (config.uiTheme) {
        const { nativeTheme, BrowserWindow } = require('electron');
        nativeTheme.themeSource = config.uiTheme;
        // 同步原生窗口背景色，防止 GPU 待机后圆角处黑色伪影
        const isDark = nativeTheme.shouldUseDarkColors;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.setBackgroundColor(
              process.platform === 'darwin' ? '#00000000' : isDark ? '#121217' : '#f1f5f9'
            );
          }
        }
      }

      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      // 触发主进程内部事件，用于更新托盘菜单等
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  registerIpcHandler<{ mode: ProxyMode }, void>(
    IPC_CHANNELS.CONFIG_UPDATE_MODE,
    async (_event: IpcMainInvokeEvent, args: { mode: ProxyMode }) => {
      await configManager.set('proxyMode', args.mode);
      const config = await configManager.loadConfig();
      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  registerIpcHandler<{ key: keyof UserConfig }, any>(
    IPC_CHANNELS.CONFIG_GET_VALUE,
    async (_event: IpcMainInvokeEvent, args: { key: keyof UserConfig }) => {
      return configManager.get(args.key);
    }
  );

  registerIpcHandler<{ key: keyof UserConfig; value: any }, void>(
    IPC_CHANNELS.CONFIG_SET_VALUE,
    async (_event: IpcMainInvokeEvent, args: { key: keyof UserConfig; value: any }) => {
      await configManager.set(args.key, args.value);
      const config = await configManager.loadConfig();

      if (args.key === 'uiTheme') {
        const { nativeTheme, BrowserWindow } = require('electron');
        nativeTheme.themeSource = args.value;
        // 同步原生窗口背景色，防止 GPU 待机后圆角处黑色伪影
        const isDark = nativeTheme.shouldUseDarkColors;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.setBackgroundColor(
              process.platform === 'darwin' ? '#00000000' : isDark ? '#121217' : '#f1f5f9'
            );
          }
        }
      }

      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  registerIpcHandler<void, boolean>(
    IPC_CHANNELS.CONFIG_GET_PRIVACY_MODE,
    async (_event: IpcMainInvokeEvent) => {
      const { getPrivacyMode } = require('../../index');
      return getPrivacyMode();
    }
  );

  registerIpcHandler<boolean, void>(
    IPC_CHANNELS.CONFIG_SET_PRIVACY_MODE,
    async (_event: IpcMainInvokeEvent, value: boolean) => {
      const { setPrivacyMode } = require('../../index');
      setPrivacyMode(value);
    }
  );
}
