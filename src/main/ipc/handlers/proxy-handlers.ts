import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  UserConfig,
  ServerConfig,
  ProxyStatus,
  PendingNodeChanges,
} from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ProxyManager } from '../../services/ProxyManager';
import type { ConfigManager } from '../../services/ConfigManager';
import { tailscaleStateExists } from '../../services/tailscale-state';
import type { TailscaleStatusSnapshot } from '../../../shared/tailscale-status';

export type TrayStateUpdateCallback = (isRunning: boolean, hasError?: boolean) => void;

let trayStateCallback: TrayStateUpdateCallback | null = null;

export function setTrayStateCallback(callback: TrayStateUpdateCallback): void {
  trayStateCallback = callback;
}

export function registerProxyHandlers(
  proxyManager: ProxyManager,
  configManager: ConfigManager
): void {
  // 注：系统代理 enable/clear 已收口于 ProxyManager（start reconcile + ensureSystemProxyCleared），
  // 本 handler 不再直接持有 systemProxyManager（拆双轨，修 C1/M4）。
  // 自定义协议兼容性 probe：当前内核能否识别该 outbound/endpoint type（sing-box check 最小 config）。
  // 主进程子进程 + ProxyManager 内缓存 → 渲染端异步调用、UI 不阻塞。
  registerIpcHandler<
    { outbound: unknown; isEndpoint?: boolean },
    { ok: boolean; indeterminate?: boolean; error?: string }
  >(IPC_CHANNELS.KERNEL_PROBE_OUTBOUND, async (_event, args) =>
    proxyManager.probeOutbound(args?.outbound, args?.isEndpoint)
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

      if (trayStateCallback) {
        trayStateCallback(true);
      }
    }
  );

  registerIpcHandler<void, void>(IPC_CHANNELS.PROXY_STOP, async (_event: IpcMainInvokeEvent) => {
    // 用户主动停止：先清系统代理（在 stop() 之前调，stopping 仍为 false → 会真正清）。
    // 经 ProxyManager.ensureSystemProxyCleared 而非裸 disableProxy → marker + 指向门控：
    // 仅清 FlowZ 自己设置的系统代理，TUN/manual 模式或用户自配的企业代理无 marker → 不动（修 M4 stomp）。
    await proxyManager.ensureSystemProxyCleared().catch(() => {});

    await proxyManager.stop();

    if (trayStateCallback) {
      trayStateCallback(false);
    }
  });

  registerIpcHandler<void, ProxyStatus>(
    IPC_CHANNELS.PROXY_GET_STATUS,
    async (_event: IpcMainInvokeEvent) => {
      return proxyManager.getStatus();
    }
  );

  registerIpcHandler<UserConfig, void>(
    IPC_CHANNELS.PROXY_RESTART,
    async (_event: IpcMainInvokeEvent, config: UserConfig) => {
      await proxyManager.restart(config);
    }
  );

  // §2 待应用差集（pull）：差集基准取 ConfigManager 最新 config（用户意图 SoT，非 currentConfig——后者被 defer/no-op
  // 推进会陈旧 F8），对比 ProxyManager 运行核启动快照。核未运行（无快照）→ 空差集。无入参、纯读、幂等。
  registerIpcHandler<void, PendingNodeChanges>(IPC_CHANNELS.PROXY_GET_PENDING_CHANGES, async () => {
    const config = await configManager.loadConfig();
    return proxyManager.getPendingNodeChanges(config);
  });

  // §2 动作条「立即应用」：把 ConfigManager 最新 config force-restart 入核（applyConfigForcingRestart 内部 guard 代理未
  // 运行/换核窗口、单飞去抖）。落盘语义不变（config 已在各 CRUD 处即时 saveConfig），此处仅触发核应用。
  // 回传应用结果状态，避免「无论是否真重启一律 ok:true」的死信息（用户点「立即应用」但内部 no-op → 徽标不清、无反馈）：
  //   'applied'  去抖重启已排程（核运行、非换核窗口）→ 差集将随 EVENT_PROXY_STARTED 自动清、徽标消失。
  //   'deferred' 换核窗口 / lifecycle 在飞 → 缓存已更、随下次重启生效（无 STARTED 回清，渲染端应保留徽标并提示稍后生效）。
  //   'skipped'  代理未运行 → 下次 start 从磁盘纳入（徽标本不应出现，属核在点击间隙停止的竞态兜底）。
  // 渲染端（pending-changes-bar）据 status 分流 toast——本处把 ProxyManager 精确三态铺到 wire。
  registerIpcHandler<void, { ok: boolean; status: 'applied' | 'deferred' | 'skipped' }>(
    IPC_CHANNELS.PROXY_APPLY_PENDING_CHANGES,
    async () => {
      const config = await configManager.loadConfig();
      const status = proxyManager.applyConfigForcingRestart(config);
      return { ok: status !== 'skipped', status };
    }
  );

  // Phase 2 按需登录：拉起瞬态登录核（无 TUN/clash_api/监听端口，零提权）抓登录 URL → 自动开浏览器 +
  // 系统通知 + 推渲染端可关闭 toast → 轮询 state 成功后杀核。双写防护：endpoint 已在主核则不起。
  // 入参传整个 server（渲染端从 store 持有，含 id/tailscaleSettings）→ 主进程无需再 loadConfig。
  registerIpcHandler<
    { server: ServerConfig },
    {
      started: boolean;
      reason?: 'alreadyLoggedIn' | 'inMainCore' | 'alreadyRunning';
      authUrl?: string;
    }
  >(IPC_CHANNELS.TAILSCALE_LOGIN, async (_event: IpcMainInvokeEvent, args) => {
    if (!args?.server) throw new Error('server required');
    return proxyManager.startTailscaleLogin(args.server);
  });

  // 取消某节点在飞的瞬态登录核（用户手动取消）。无在飞核为 no-op。
  registerIpcHandler<{ serverId: string }, void>(
    IPC_CHANNELS.TAILSCALE_LOGIN_CANCEL,
    async (_event: IpcMainInvokeEvent, args) => {
      if (!args?.serverId) throw new Error('serverId required');
      proxyManager.cancelTailscaleLogin(args.serverId);
    }
  );

  // 退出登录：清该节点 Tailscale state 目录（持久会话）；保留节点配置。回传是否需重启代理生效。
  registerIpcHandler<{ serverId: string }, { runningNeedsRestart: boolean }>(
    IPC_CHANNELS.TAILSCALE_LOGOUT,
    async (_event: IpcMainInvokeEvent, args) => {
      if (!args?.serverId) throw new Error('serverId required');
      return proxyManager.tailscaleLogout(args.serverId);
    }
  );

  // 批量查 TS 节点 state 目录存在性（不起核）：代理关时登录态缓存未命中的兜底，判「登录过没」。
  // 纯文件存在性判定（tailscaleStateExists 失败安全返 false），零进程、零网络。
  registerIpcHandler<{ serverIds: string[] }, Record<string, boolean>>(
    IPC_CHANNELS.TAILSCALE_STATE_EXISTS,
    async (_event: IpcMainInvokeEvent, args) => {
      const out: Record<string, boolean> = {};
      // IPC 边界防御：非数组入参（畸形调用）一律视作空，逐项再过滤非字符串 id（防 for...of 对字符串逐字符迭代）。
      const ids = Array.isArray(args?.serverIds) ? args.serverIds : [];
      for (const id of ids) {
        if (typeof id === 'string') out[id] = tailscaleStateExists(id);
      }
      return out;
    }
  );

  // L2：主动拉各 TS 节点状态末帧 + 新鲜度。治本「状态流 push-only-on-change、无心跳、无 pull、渲染端错过推送即
  // 永久陈旧」（内网IP「尚未分配」/peers 拿不到）：渲染端挂载/出口表单打开即拉缓存末帧，不干等下一帧推送。无入参。
  registerIpcHandler<void, TailscaleStatusSnapshot>(IPC_CHANNELS.TAILSCALE_GET_STATUS, async () =>
    proxyManager.getTailscaleStatusSnapshot()
  );
}
