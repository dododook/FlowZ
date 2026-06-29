/**
 * 测速编排单一入口（根治：托盘 + 渲染 IPC 两入口都只调它）。
 *
 * 历史病灶：托盘 onSpeedTest 与渲染 IPC speed-test-handlers 各自手写「testAllServers + 广播 + 回写托盘」，
 * 必然漂移——IPC 入口漏了 `trayManager.updateSpeedTestResults`，导致服务器页测速不同步到托盘列表。
 * 此函数把全部传播副作用（渲染逐节点广播 + 进度广播 + 托盘回写 + 测速态）收敛在唯一一处，
 * 结构上杜绝再次漂移；新增入口只需调它，自动获得一致传播。
 */
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ConfigManager } from './ConfigManager';
import type { SpeedTestService } from './SpeedTestService';
import type { TrayManager } from './TrayManager';
import type { LogManager } from './LogManager';

export interface SpeedTestRunnerDeps {
  configManager: ConfigManager;
  speedTestService: SpeedTestService;
  /** call-time 取当前主窗口（广播逐节点结果/进度到渲染层 latencyMap）。 */
  getMainWindow: () => BrowserWindow | null;
  /** call-time 取托盘管理器（回写测速结果与测速态；可能尚未创建/已销毁）。 */
  getTrayManager: () => TrayManager | null;
  logManager: LogManager;
}

/**
 * 运行一次测速并统一传播结果。
 * @param opts.serverIds 限定测速子集（缺省=全部 servers）；不可测节点由 SpeedTestService 内部按 isSpeedTestable 剔除。
 * @returns 逐节点最终结果 Map（latency=null 表示超时/不可达）。
 */
export async function runSpeedTest(
  deps: SpeedTestRunnerDeps,
  opts: { serverIds?: string[]; notifyTrayToast?: boolean } = {}
): Promise<Map<string, number | null>> {
  const { configManager, speedTestService, getMainWindow, getTrayManager, logManager } = deps;
  const config = await configManager.loadConfig();
  const servers = opts.serverIds
    ? config.servers.filter((s) => opts.serverIds!.includes(s.id))
    : config.servers;

  // 无节点可测：早退。本函数自身不置测速态（避免菜单闪一下「测速中」），但托盘入口 handleSpeedTest 在调用前
  // 已无条件置 isSpeedTesting=true → 必须在此复位，否则 0 节点时托盘永久卡「测速中」。复位幂等：渲染入口未置态时 no-op。
  if (servers.length === 0) {
    logManager.addLog('info', 'Speed test skipped: no servers', 'SpeedTest');
    getTrayManager()?.setSpeedTesting(false);
    return new Map();
  }

  const send = (channel: string, payload: unknown) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // 任意入口触发都让托盘菜单进入「测速中」态（与 UI 一致；幂等，已是该态则 no-op）。
  getTrayManager()?.setSpeedTesting(true);
  try {
    const results = await speedTestService.testAllServers(
      servers,
      (serverId, latency) =>
        send(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT, {
          serverId,
          latency: latency === null ? -1 : latency,
        }),
      (tested, ok, total) => send(IPC_CHANNELS.EVENT_SPEED_TEST_PROGRESS, { tested, ok, total }),
      config.speedTestUrl
    );
    // 唯一回写托盘点：合并入托盘延迟显示（不替换 → 子集/单节点测速不塌缩）+ isSpeedTesting=false + 菜单重建。
    // toast 仅托盘入口（notifyTrayToast=true）触发——渲染入口（服务器页/首页）测速由 use-speed-test 自弹，避免双 toast。
    getTrayManager()?.updateSpeedTestResults(results, config.servers, {
      toast: opts.notifyTrayToast,
    });
    return results;
  } catch (error) {
    logManager.addLog(
      'error',
      `Speed test failed: ${error instanceof Error ? error.message : String(error)}`,
      'SpeedTest'
    );
    getTrayManager()?.setSpeedTesting(false); // 仅复位测速态、保留已有托盘延迟（不清空）
    throw error;
  }
}
