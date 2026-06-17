/**
 * 代理管理 IPC 处理器
 * 处理代理相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  UserConfig,
  ProxyStatus,
  TrafficStats,
  ConnectionsSnapshot,
} from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ProxyManager } from '../../services/ProxyManager';
import type { StatsService } from '../../services/StatsService';

/**
 * 托盘状态更新回调
 */
export type TrayStateUpdateCallback = (isRunning: boolean, hasError?: boolean) => void;

let trayStateCallback: TrayStateUpdateCallback | null = null;

/**
 * 设置托盘状态更新回调
 */
export function setTrayStateCallback(callback: TrayStateUpdateCallback): void {
  trayStateCallback = callback;
}

/**
 * 注册代理管理相关的 IPC 处理器
 */
export function registerProxyHandlers(
  proxyManager: ProxyManager,
  statsService?: StatsService | null
): void {
  // 注：系统代理 enable/clear 已收口于 ProxyManager（start reconcile + ensureSystemProxyCleared），
  // 本 handler 不再直接持有 systemProxyManager（拆双轨，修 C1/M4）。
  // 流量统计快照（窗口重建/挂载时回填初值）
  registerIpcHandler<void, TrafficStats>(IPC_CHANNELS.STATS_GET, async () =>
    statsService
      ? statsService.getSnapshot()
      : { uploadSpeed: 0, downloadSpeed: 0, totalUpload: 0, totalDownload: 0, activeConnections: 0 }
  );

  // 自定义协议兼容性 probe：当前内核能否识别该 outbound/endpoint type（sing-box check 最小 config）。
  // 主进程子进程 + ProxyManager 内缓存 → 渲染端异步调用、UI 不阻塞。
  registerIpcHandler<
    { outbound: unknown; isEndpoint?: boolean },
    { ok: boolean; indeterminate?: boolean; error?: string }
  >(IPC_CHANNELS.KERNEL_PROBE_OUTBOUND, async (_event, args) =>
    proxyManager.probeOutbound(args?.outbound, args?.isEndpoint)
  );

  // 连接快照（topology 统一供数；窗口重建/挂载回填）
  registerIpcHandler<void, ConnectionsSnapshot>(IPC_CHANNELS.CONNECTIONS_GET, async () =>
    statsService ? statsService.getConnectionsSnapshot() : { connections: [], at: Date.now() }
  );

  // 关单条连接：经 ProxyManager（9090 keep-alive agent + Bearer secret 内部封装）发 DELETE /connections/{id}，
  // 渲染端不持 secret。返回 ok 布尔（核未运行/鉴权未就绪 → ok:false，渲染端按布尔决策）。
  registerIpcHandler<{ id: string }, { ok: boolean }>(
    IPC_CHANNELS.CONNECTIONS_CLOSE,
    async (_event: IpcMainInvokeEvent, args) => {
      const id = args?.id;
      if (!id) throw new Error('connection id required');
      const res = await proxyManager.closeConnection(id);
      return { ok: res.ok };
    }
  );

  // 关全部连接：DELETE /connections（CloseAllConnections + ResetNetwork，影响面比 mihomo 大，UI 须确认弹窗）。
  registerIpcHandler<void, { ok: boolean }>(IPC_CHANNELS.CONNECTIONS_CLOSE_ALL, async () => {
    const res = await proxyManager.closeConnection();
    return { ok: res.ok };
  });

  // 用户主动关闭系统代理（TUN 残留提示的一键动作）：经 ProxyManager 收口 systemProxyManager.disableProxy。
  registerIpcHandler<void, { ok: boolean }>(IPC_CHANNELS.SYSTEM_PROXY_DISABLE, async () => {
    await proxyManager.clearSystemProxyManually();
    return { ok: true };
  });

  // 连接页订阅/退订（P1 watcher 引用计数）：仅连接页打开时主进程才裁剪+推送连接快照，
  // 「代理连着但没盯连接页」稳态下省掉全量裁剪与大包广播。fire-and-forget（渲染端不关心返回值）。
  registerIpcHandler<void, void>(IPC_CHANNELS.CONNECTIONS_WATCH, async () => {
    statsService?.addConnectionsWatcher();
  });
  registerIpcHandler<void, void>(IPC_CHANNELS.CONNECTIONS_UNWATCH, async () => {
    statsService?.removeConnectionsWatcher();
  });

  // 启动代理
  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.PROXY_START,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      if (!config) {
        throw new Error('配置参数未传递');
      }

      // 启动 sing-box 进程。helper 引导统一收敛到 ProxyManager.start() 的 native gate（无窗口依赖、单点）。
      // 系统代理拆双轨：enable/clear 已收口于 ProxyManager.start()（按新模式 reconcile），此处不再重复设置，
      // 避免双写者污染 originalSettings（曾致 disable 把死端口代理设回 → 断网）。
      await proxyManager.start(config);

      // 更新托盘状态
      if (trayStateCallback) {
        trayStateCallback(true);
      }
    }
  );

  // 停止代理
  registerIpcHandler<void, void>(IPC_CHANNELS.PROXY_STOP, async (_event: IpcMainInvokeEvent) => {
    // 用户主动停止：先清系统代理（在 stop() 之前调，stopping 仍为 false → 会真正清）。
    // 经 ProxyManager.ensureSystemProxyCleared 而非裸 disableProxy → marker + 指向门控：
    // 仅清 FlowZ 自己设置的系统代理，TUN/manual 模式或用户自配的企业代理无 marker → 不动（修 M4 stomp）。
    await proxyManager.ensureSystemProxyCleared().catch(() => {});

    // 停止 sing-box 进程
    await proxyManager.stop();

    // 更新托盘状态
    if (trayStateCallback) {
      trayStateCallback(false);
    }
  });

  // 获取代理状态
  registerIpcHandler<void, ProxyStatus>(
    IPC_CHANNELS.PROXY_GET_STATUS,
    async (_event: IpcMainInvokeEvent) => {
      return proxyManager.getStatus();
    }
  );

  // 重启代理
  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.PROXY_RESTART,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      await proxyManager.restart(config);
    }
  );
}
