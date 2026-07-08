/**
 * 启动期任务调度 —— 从 index.ts whenReady 抽出（index.ts 拆分 Phase 3 step C）。
 *
 * 两个延迟任务：① 2s 后自动连接（先落位上轮 staged 内核再 autoConnect）② 5s 后自动检查更新。
 * 经 deps 注入主进程服务；proxyManager 用 getter 取 call-time 当前值（setTimeout 触发时已初始化）。
 * 回调体逐字保留——proxyManager 经「同名 local const 捕获」保持原文不变。
 * 无 config 快照网（app 生命周期域）；真机冒烟验证（冷启动自动连接 / 自动检查更新）。
 */

import type { LogManager } from './services/LogManager';
import type { ConfigManager } from './services/ConfigManager';
import type { ProxyManager } from './services/ProxyManager';
import type { UpdateService } from './services/UpdateService';
import type { CoreUpdateService } from './services/CoreUpdateService';
import { getWarpDeregisterQueue } from './services/WarpDeregisterQueue';

/** 注入依赖：服务单例 + proxyManager getter（call-time 取值）+ 托盘状态刷新。 */
export interface StartupTaskDeps {
  configManager: ConfigManager;
  coreUpdateService: CoreUpdateService;
  updateService: UpdateService;
  logManager: LogManager;
  getProxyManager: () => ProxyManager | null;
  updateTrayMenuState: (isProxyRunning: boolean, hasError?: boolean) => void;
}

/**
 * 调度启动期延迟任务（自动连接 + 自动检查更新），与 whenReady 内原内联两 setTimeout 逐字等价。
 */
export function scheduleStartupTasks(deps: StartupTaskDeps): void {
  const {
    configManager,
    coreUpdateService,
    updateService,
    logManager,
    getProxyManager,
    updateTrayMenuState,
  } = deps;

  // 启动时自动连接（延迟 2 秒，等待窗口和服务初始化完成）
  setTimeout(async () => {
    const proxyManager = getProxyManager();
    try {
      const config = await configManager.loadConfig();

      // 内核自动更新：App 启动序列的安全窗口（代理尚未 autoConnect）→ 先尝试落位上轮暂存的 staged 内核，
      // 再做版本变更检测+autoConnect。落位仅在代理未运行时发生（此刻必然未连），不断流硬不变量。
      try {
        await coreUpdateService.tryApplyStaged('startup');
      } catch (stagedErr) {
        logManager.addLog('warn', `启动期落位 staged 内核异常: ${stagedErr}`, 'Main');
      }

      // 启动期随包核对齐（用户反馈：部署/自更新新随包核后运行时受保护核不自愈、须连接才刷新）：helper 在位=静默 reseed；
      // 无 helper 孤儿态 = 一次性 osascript 授权兜底（首启弹一次，防每启弹）。安全窗口 = 代理未连（此刻必然未连）。
      try {
        const r = await proxyManager?.reseedBundledCoreOnStartup();
        if (r?.needsMacElevatedReseed) {
          await coreUpdateService.tryElevatedReseedProtectedCoreOnStartup(r.bundledVersion);
        }
      } catch (reseedErr) {
        logManager.addLog('warn', `启动期随包核对齐异常: ${reseedErr}`, 'Main');
      }

      // 启动期「内核版本变更」横幅已移除：基线对齐缺收口 → 每次启动重复弹扰民（基线 core-version.json 与实际核不一致
      // 时反复触发）。更新当下已有一次性反馈（applyStagedNow 的 EVENT_CORE_VERSION_CHANGED），回滚入口常驻内核管理设置，
      // 故启动期不再主动弹。

      // 检查是否启用了启动时自动连接
      if (config.autoConnect && config.selectedServerId) {
        logManager.addLog('info', '启动时自动连接已启用，正在连接...', 'Main');

        if (proxyManager) {
          // 系统代理 enable/clear 已收口于 start()（拆双轨），自动连接不再重复设置。
          await proxyManager.start(config);

          logManager.addLog('info', '启动时自动连接成功', 'Main');
          // 更新托盘菜单状态
          updateTrayMenuState(true);
        }
      } else if (config.autoConnect && !config.selectedServerId) {
        logManager.addLog('warn', '启动时自动连接已启用，但未选择服务器', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('error', `启动时自动连接失败: ${errorMessage}`, 'Main');
      // 连接失败时更新托盘状态
      updateTrayMenuState(false, true);
    }
  }, 2000);

  // 启动后自动检查更新（延迟 5 秒，避免影响启动体验）
  setTimeout(async () => {
    try {
      const config = await configManager.loadConfig();
      // 检查是否启用了自动检查更新
      if (config.autoCheckUpdate !== false) {
        logManager.addLog('info', '正在自动检查更新...', 'Main');
        const result = await updateService.checkForUpdate();
        if (result.hasUpdate && result.updateInfo) {
          logManager.addLog('info', `发现新版本: ${result.updateInfo.version}`, 'Main');
          // 显示更新对话框
          const action = await updateService.showUpdateDialog(result.updateInfo);
          if (action === 'update') {
            // 使用带进度窗口的下载方法
            const filePath = await updateService.downloadUpdateWithProgress(result.updateInfo);
            if (filePath) {
              await updateService.installUpdate(filePath);
            }
          } else if (action === 'skip') {
            updateService.skipVersion(result.updateInfo.version);
          }
        } else if (result.error) {
          logManager.addLog('warn', `自动检查更新失败: ${result.error}`, 'Main');
        } else {
          logManager.addLog('info', '当前已经是最新版本', 'Main');
        }
      }
    } catch (error) {
      logManager.addLog('error', `自动检查更新异常: ${error}`, 'Main');
    }
  }, 5000);

  // 启动后机会式 drain WARP 待注销队列（延迟 8 秒，让网络/服务先就绪；fire-and-forget 不阻塞、绝不抛）。
  // 与「成功注册 WARP 后」并为两个触发点；无常驻定时器——不重开 app 者既不 drain 也不产生新孤儿（副作用自洽）。
  // 复用进程内单例（与 server-handlers 同实例）：串行链覆盖启动 drain 与删除入队，杜绝跨实例并发写同一队列文件。
  setTimeout(() => {
    getWarpDeregisterQueue(logManager).drainInBackground();
  }, 8000);
}
