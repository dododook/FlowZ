/**
 * 配置变更监听器 —— 从 index.ts whenReady 抽出（index.ts 拆分 Phase 3 step D）。
 *
 * 监听 MAIN_EVENTS.CONFIG_CHANGED：logLevel 热同步 / 托盘刷新 / 运行中切配置(switchMode 热切换) /
 * 自动换节点开关同步 / 「更新检查走代理」应用 / 内核自动更新 kick。经 deps 注入主进程服务与可变引用
 * （proxyManager/autoSwitchService/coreUpdateScheduler 用 getter 取 call-time 当前值）+ index.ts 内闭包
 * （applyMainSessionProxy）+ index.ts 函数（getPrivacyMode/updateTrayMenuState，注入避免重建 TrayManager 已断的
 * 服务→入口循环依赖）。处理体逐字保留——可变引用经「同名 local const 捕获」保持原文不变。
 * 无 config 快照网（app 生命周期域）；真机冒烟验证（设置页改 logLevel/自动换节点开关/更新走代理 等热生效）。
 */

import type { LogLevel } from '../shared/types';
import type { LogManager } from './services/LogManager';
import type { ConfigManager } from './services/ConfigManager';
import type { ProxyManager } from './services/ProxyManager';
import type { AutoSwitchService } from './services/AutoSwitchService';
import type { CoreUpdateScheduler } from './services/CoreUpdateScheduler';
import { mainEventEmitter, MAIN_EVENTS } from './ipc/main-events';
import { effectiveLogLevel } from '../shared/log-level';
import { setDesktopNotificationsEnabled } from './notify-user';

/** 注入依赖：服务单例/可变引用 getter（call-time 取值）+ index.ts 闭包/函数（注入防循环依赖）。 */
export interface ConfigChangeDeps {
  configManager: ConfigManager;
  logManager: LogManager;
  getProxyManager: () => ProxyManager | null;
  getAutoSwitchService: () => AutoSwitchService | null;
  getCoreUpdateScheduler: () => CoreUpdateScheduler | null;
  updateTrayMenuState: (isProxyRunning: boolean, hasError?: boolean) => void;
  applyMainSessionProxy: () => Promise<void>;
  getPrivacyMode: () => boolean;
}

/**
 * 注册 CONFIG_CHANGED 监听器（与 whenReady 内原内联 mainEventEmitter.on 逐字等价）。
 */
export function registerConfigChangeListener(deps: ConfigChangeDeps): void {
  const {
    configManager,
    logManager,
    getProxyManager,
    getAutoSwitchService,
    getCoreUpdateScheduler,
    updateTrayMenuState,
    applyMainSessionProxy,
    getPrivacyMode,
  } = deps;

  mainEventEmitter.on(
    MAIN_EVENTS.CONFIG_CHANGED,
    async (changedConfig?: { logLevel?: LogLevel }) => {
      const proxyManager = getProxyManager();
      const autoSwitchService = getAutoSwitchService();
      const coreUpdateScheduler = getCoreUpdateScheduler();
      // 0. logLevel 热同步到 LogManager（设置页改日志级别即时生效，无需重启 app；与启动期 setLogLevel 对齐）
      const lvl =
        changedConfig?.logLevel ?? (await configManager.loadConfig().catch(() => null))?.logLevel;
      logManager.setLogLevel(effectiveLogLevel(lvl || 'info', getPrivacyMode()));

      // 0b. 桌面通知总开关热同步（changedConfig 即最新整份配置；缺省视为开）。
      setDesktopNotificationsEnabled(
        (changedConfig as { desktopNotifications?: boolean } | undefined)?.desktopNotifications
      );

      // 1. 更新托盘菜单
      const isRunning = proxyManager?.getStatus().running ?? false;
      updateTrayMenuState(isRunning);

      // 2. 如果代理正在运行，应用新配置：仅切节点走 clash_api 热切换（不断流），其余重启（见 switchMode）
      if (isRunning && proxyManager) {
        try {
          // 重新加载配置以确保使用最新值
          const latestConfig = await configManager.loadConfig();
          await proxyManager.switchMode(latestConfig);
          logManager.addLog('info', 'Applied configuration change', 'Main');

          // 应用后再次更新托盘（以防状态有变）
          updateTrayMenuState(proxyManager.getStatus().running);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to apply config change: ${errorMessage}`, 'Main');
          // 应用失败，更新托盘状态为停止
          updateTrayMenuState(false, true);
        }
      }

      // 3. 同步自动换节点服务状态
      if (autoSwitchService) {
        const latestCfg = await configManager.loadConfig().catch(() => null);
        if (latestCfg?.autoSwitchNode) {
          autoSwitchService.enable();
        } else {
          autoSwitchService.disable();
        }
      }

      // 4. 应用「更新检查走代理」总开关（mainSessionViaProxy 切换时热生效；幂等）
      await applyMainSessionProxy();

      // 5. 内核自动更新开关刚开 → kick 一次即时检查（无需等 6h tick）；未开/未 due 自然跳过，幂等
      coreUpdateScheduler?.kick();
    }
  );
}
