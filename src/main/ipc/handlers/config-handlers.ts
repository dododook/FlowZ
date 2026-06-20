/**
 * 配置管理 IPC 处理器
 * 处理配置相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { UserConfig, ProxyMode } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';
import { ipcEventEmitter } from '../ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';
import { stripRemoteSecrets, mergeRemoteSecrets } from '../../services/remote-instance-secrets';

/**
 * 注册配置管理相关的 IPC 处理器
 */
export function registerConfigHandlers(configManager: ConfigManager): void {
  // 获取配置
  registerIpcHandler<void, UserConfig>(
    IPC_CHANNELS.CONFIG_GET,
    async (_event: IpcMainInvokeEvent) => {
      const cfg = await configManager.loadConfig();
      // F29：绝不向渲染端下发隐私密码（迁移前的残留明文也一并剥除；哈希本就不在 config 内）
      // P5 Phase2：远程实例 secret 同样不下发明文，剥成 hasSecret 占位（渲染端只写不读）。
      return stripRemoteSecrets({ ...cfg, privacyPassword: undefined });
    }
  );

  // 保存配置
  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.CONFIG_SAVE,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      // P5 Phase2：渲染端持有的 config 已被 stripRemoteSecrets 剥过 secret（仅 hasSecret 占位）；保存前按 id 合并回
      // 内存已存的 secret（渲染端未给新值 → 沿用旧值，防被清零），并剔除 hasSecret 占位字段。
      // A-2 安全性：configManager.get 在 currentConfig===null 时返 undefined（不 lazy-load），priorRemote 缺失会致
      // 已存 secret 合不回 → 静默清零。此路径不可达：主进程 whenReady 先 await loadConfig()（恒填 currentConfig，
      // 内部 catch 兜默认配置绝不留 null），再 registerConfigHandlers 注册本 CONFIG_SAVE handler——handler 存在时
      // currentConfig 必已非 null；且渲染端须先 CONFIG_GET 拿到 config 才能构造并保存，不会先于 load 触发保存。
      const priorRemote = configManager.get<UserConfig['remoteInstances']>('remoteInstances');
      config = mergeRemoteSecrets(config, { remoteInstances: priorRemote } as UserConfig);
      await configManager.saveConfig(config);

      // 同步主题到原生系统
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

      // 广播配置变更事件到渲染进程
      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      // 触发主进程内部事件，用于更新托盘菜单等
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  // 更新代理模式
  registerIpcHandler<{ mode: ProxyMode }, void>(
    IPC_CHANNELS.CONFIG_UPDATE_MODE,
    async (_event: IpcMainInvokeEvent, args: { mode: ProxyMode }) => {
      await configManager.set('proxyMode', args.mode);
      const config = await configManager.loadConfig();
      // 广播和触发事件
      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  // 获取配置项
  registerIpcHandler<{ key: keyof UserConfig }, any>(
    IPC_CHANNELS.CONFIG_GET_VALUE,
    async (_event: IpcMainInvokeEvent, args: { key: keyof UserConfig }) => {
      return configManager.get(args.key);
    }
  );

  // 设置配置项
  registerIpcHandler<{ key: keyof UserConfig; value: any }, void>(
    IPC_CHANNELS.CONFIG_SET_VALUE,
    async (_event: IpcMainInvokeEvent, args: { key: keyof UserConfig; value: any }) => {
      await configManager.set(args.key, args.value);
      const config = await configManager.loadConfig();

      // 同步主题到原生系统
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

      // 广播和触发事件
      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  // 获取隐私模式状态
  registerIpcHandler<void, boolean>(
    IPC_CHANNELS.CONFIG_GET_PRIVACY_MODE,
    async (_event: IpcMainInvokeEvent) => {
      const { getPrivacyMode } = require('../../index');
      return getPrivacyMode();
    }
  );

  // 设置隐私模式状态
  registerIpcHandler<boolean, void>(
    IPC_CHANNELS.CONFIG_SET_PRIVACY_MODE,
    async (_event: IpcMainInvokeEvent, value: boolean) => {
      const { setPrivacyMode } = require('../../index');
      setPrivacyMode(value);
    }
  );
}
