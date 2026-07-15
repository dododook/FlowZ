import { IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ServerConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';
import { ipcEventEmitter } from '../ipc-events';
import { DIRECT_SERVER_ID } from '../../../shared/direct-selection';
import { ProtocolParser } from '../../services/ProtocolParser';
import { ConfigManager } from '../../services/ConfigManager';
import { WarpService, type WarpWireGuardDraft } from '../../services/WarpService';
import { getWarpDeregisterQueue } from '../../services/WarpDeregisterQueue';
import { tailscaleStateDir } from '../../services/tailscale-state';
import type { LogManager } from '../../services/LogManager';

/** @param logManager 可选，供 WARP 设备注销队列记录日志（只打 deviceId 前缀，绝不打 token） */
export function registerServerHandlers(
  protocolParser: ProtocolParser,
  configManager: ConfigManager,
  logManager?: LogManager
): void {
  // WARP 待注销队列（删除带 warpDevice 凭据的节点 → 入队；成功注册后机会式 drain）。
  // 进程内单例：与 startup-tasks 启动 drain 共用同一实例，使串行链（opChain）覆盖全部触发点、杜绝跨实例并发写。
  const warpDeregisterQueue = getWarpDeregisterQueue(logManager);

  // 删除单个服务器后的「非配置副作用」（Tailscale state 清理 + WARP 远端注销入队），单删 / 批删共用。
  // 抽出复用，保证批量删除不丢这两项副作用（否则 CF 端留孤儿设备、Tailscale 登录目录残留）。
  const runServerRemovalSideEffects = async (removed: ServerConfig): Promise<void> => {
    // Tailscale 节点 → 清其持久 state 目录 <userData>/tailscale/<id>（best-effort，不阻断删除）。
    if (removed?.protocol?.toLowerCase() === 'tailscale') {
      await fs.rm(tailscaleStateDir(removed.id), { recursive: true, force: true }).catch(() => {});
    }

    // WARP 节点 → 带自删凭据（warpDevice.token+deviceId）则入待注销队列，后台机会式 drain 远端注销。
    // 判据=token 存在与否（零误判，不靠端点启发式）：本特性前的旧 WARP 节点无 warpDevice → 跳过入队、
    // 仅删本地、不报错（注定孤儿、无凭可注销，已接受的历史债）。
    const warpDevice = removed?.wireguardSettings?.warpDevice;
    if (warpDevice?.token && warpDevice?.deviceId) {
      await warpDeregisterQueue
        .enqueue({
          deviceId: warpDevice.deviceId,
          token: warpDevice.token,
          enqueuedAt: Date.now(),
        })
        .catch(() => {}); // 入队失败不阻断删除（本地已删，凭据丢失=退化为旧节点孤儿，可接受）
    }
  };

  registerIpcHandler<{ server: ServerConfig }, string>(
    IPC_CHANNELS.SERVER_GENERATE_URL,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      return protocolParser.generateUrl(args.server);
    }
  );

  registerIpcHandler<{ server: ServerConfig }, void>(
    IPC_CHANNELS.SERVER_ADD,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      const config = await configManager.loadConfig();
      config.servers.push(args.server);
      await configManager.saveConfig(config);
    }
  );

  // 批量添加自建节点（本地导入）：一次 loadConfig → push 全部 → 一次 saveConfig（避免 N 次原子写 + N 次广播）。
  // 每条强制重新生成 id（杜绝与存量/批内 id 撞）+ 剥离 subscriptionId/providerName（恒为自建，可编辑可删除）。
  // 入参节点已在 parseLocalContent 经 isServerComplete 过滤，validateConfig 不会因协议/字段 throw。
  registerIpcHandler<{ servers: ServerConfig[] }, { added: number }>(
    IPC_CHANNELS.SERVER_ADD_BULK,
    async (_event: IpcMainInvokeEvent, args: { servers: ServerConfig[] }) => {
      const list = Array.isArray(args.servers) ? args.servers : [];
      if (list.length === 0) return { added: 0 };
      const config = await configManager.loadConfig();
      const now = new Date().toISOString();
      for (const s of list) {
        config.servers.push({
          ...s,
          id: randomUUID(),
          subscriptionId: undefined,
          providerName: undefined,
          createdAt: s.createdAt ?? now,
          updatedAt: now,
        });
      }
      await configManager.saveConfig(config);
      return { added: list.length };
    }
  );

  registerIpcHandler<{ server: ServerConfig }, void>(
    IPC_CHANNELS.SERVER_UPDATE,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      const config = await configManager.loadConfig();
      const index = config.servers.findIndex((s) => s.id === args.server.id);

      if (index === -1) {
        throw new Error(`服务器不存在: ${args.server.id}`);
      }

      config.servers[index] = args.server;
      await configManager.saveConfig(config);
    }
  );

  // D4/F-1（flowz-node-change-restart）：删除**恒双播** event:configChanged（renderer 差集刷新）+ MAIN_EVENTS.CONFIG_CHANGED
  //   （主进程 switchMode）。重启与否**单一真值**归 switchMode.canSkipRestartForAddedUnreferenced（refOld∪refNext 含 detour
  //   闭包 + endpoint 保守集）：删被引用节点（含 detour 前置/未选中 endpoint）恒重启、删纯未引用节点 canSkip③ defer 不重启。
  //   原 handler 用 `wasSelected‖ruleTargeted` 残缺复刻判据、漏 detour/endpoint → 删它们不重启、活流量继续经已删节点（缺口）。
  //   删选中时 selectedServerId 置**渲染端传入的兜底节点**（pickFallbackExit），而非 null（避免 0 节点重启 throw）。
  registerIpcHandler<{ serverId: string; fallbackSelectedId?: string | null }, void>(
    IPC_CHANNELS.SERVER_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      args: { serverId: string; fallbackSelectedId?: string | null }
    ) => {
      const config = await configManager.loadConfig();
      const index = config.servers.findIndex((s) => s.id === args.serverId);

      if (index === -1) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      const removed = config.servers[index];
      config.servers.splice(index, 1);

      const wasSelected = config.selectedServerId === args.serverId;

      // 删当前选中 → 兜底出口（渲染端最快剩余节点）；无剩余(null/undefined) → DIRECT_SERVER_ID 哨兵（干净直连，
      // proxy-selector default='direct'）。**不可置 null**：null 非哨兵 → 0 节点时 buildOutbounds `nodeTags.length===0
      // && !isDirect` throw「没有可用节点」→ 重启失败（设计 D4：0 剩余→direct）。
      // 服务端二次校验 fallbackSelectedId：渲染端 store 可能陈旧（并发订阅刷新在批删途中下架了该兜底节点）→ 传入的是
      // 悬空 id。悬空 id 直接赋给 selectedServerId 会被 saveConfig→validateConfig 静默置 null（非哨兵）→ 复现 0 节点
      // 重启 throw / 静默直连。故仅当兜底 id 仍存在于剩余 servers 时采用，否则回退 DIRECT_SERVER_ID 哨兵。
      if (wasSelected) {
        const fb = args.fallbackSelectedId;
        config.selectedServerId =
          fb && config.servers.some((s) => s.id === fb) ? fb : DIRECT_SERVER_ID;
      }

      await configManager.saveConfig(config);
      await runServerRemovalSideEffects(removed);

      // F-1：恒双播（对齐 CONFIG_SAVE）。重启分类归 switchMode canSkip；渲染端差集/store 即时刷新（原删除零 sendToAll →
      // 徽标要等下个无关触发点才冒出、观感随机）。未引用删除仍 defer 不重启（不多重启）。
      ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_CONFIG_CHANGED, { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  // 批量删除服务器：一次 loadConfig → 过滤掉全部 ids → 命中选中清 selectedServerId → 一次 saveConfig，
  // 再逐个跑删除副作用。单次配置写避免「N 个并发单删各读旧配置、末次写覆盖前面」的竞态（净删 1 个）。
  // 不存在的 id 静默跳过（幂等）。返回实际删除数。
  registerIpcHandler<{ serverIds: string[]; fallbackSelectedId?: string | null }, number>(
    IPC_CHANNELS.SERVER_DELETE_BATCH,
    async (
      _event: IpcMainInvokeEvent,
      args: { serverIds: string[]; fallbackSelectedId?: string | null }
    ) => {
      const idSet = new Set(args.serverIds);
      const config = await configManager.loadConfig();
      const removed = config.servers.filter((s) => idSet.has(s.id));
      if (removed.length === 0) return 0;

      config.servers = config.servers.filter((s) => !idSet.has(s.id));

      // F-1：删除集合是否含选中节点 → 决定兜底出口（重启分类归 switchMode canSkip，不再在此复刻规则目标判据）。
      const selectedDeleted = !!config.selectedServerId && idSet.has(config.selectedServerId);

      // 选中节点在删除集合内（'__direct__' 哨兵不是真实 id，不会命中）→ 置兜底节点（渲染端最快剩余节点）；
      // 无剩余 → DIRECT_SERVER_ID（同单删：null 会致 0 节点重启 throw）。
      // 同单删：服务端二次校验 fallbackSelectedId 仍在剩余 servers 内（防渲染端 store 陈旧传入悬空 id → validateConfig
      // 静默置 null → 0 节点重启 throw / 静默直连）；悬空则回退 DIRECT_SERVER_ID 哨兵。
      if (selectedDeleted) {
        const fb = args.fallbackSelectedId;
        config.selectedServerId =
          fb && config.servers.some((s) => s.id === fb) ? fb : DIRECT_SERVER_ID;
      }

      await configManager.saveConfig(config);
      for (const r of removed) {
        await runServerRemovalSideEffects(r);
      }

      // F-1：恒双播（同单删；重启分类归 switchMode canSkip，含 detour 闭包/endpoint 保守集）。
      ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_CONFIG_CHANGED, { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
      return removed.length;
    }
  );

  registerIpcHandler<void, ServerConfig[]>(
    IPC_CHANNELS.SERVER_GET_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return config.servers;
    }
  );

  registerIpcHandler<{ serverId: string }, void>(
    IPC_CHANNELS.SERVER_SWITCH,
    async (_event: IpcMainInvokeEvent, args: { serverId: string }) => {
      const config = await configManager.loadConfig();
      const server = config.servers.find((s) => s.id === args.serverId);

      if (!server) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      config.selectedServerId = args.serverId;
      await configManager.saveConfig(config);
    }
  );

  // Cloudflare WARP：注册匿名设备 → 返回 WireGuard 草稿（渲染端填表、用户确认后按普通 WG 节点保存）。
  // 不落盘、不存 token；网络/TLS 细节见 WarpService。
  registerIpcHandler<{ licenseKey?: string }, WarpWireGuardDraft>(
    IPC_CHANNELS.WARP_REGISTER,
    async (_event: IpcMainInvokeEvent, args: { licenseKey?: string }) => {
      const draft = await new WarpService(logManager).register({ licenseKey: args?.licenseKey });
      // 成功注册后机会式 drain 待注销队列（fire-and-forget，不阻塞返回；网络已通的好时机）。
      warpDeregisterQueue.drainInBackground();
      return draft;
    }
  );

  // 对已注册 WARP 节点原地应用 WARP+ license（升级免重建）。token 一律服务端按 serverId 取，不经渲染端回传；
  // 无 warpDevice 凭据的旧节点返 no-credentials（渲染端置灰 + 提示重建）。
  registerIpcHandler<
    { serverId: string; license: string },
    { ok: boolean; warpPlus?: boolean; error?: string }
  >(
    IPC_CHANNELS.WARP_APPLY_LICENSE,
    async (_event: IpcMainInvokeEvent, args: { serverId: string; license: string }) => {
      const config = await configManager.loadConfig();
      const dev = config.servers.find((s) => s.id === args.serverId)?.wireguardSettings?.warpDevice;
      if (!dev?.deviceId || !dev?.token) return { ok: false, error: 'no-credentials' };
      try {
        const { warpPlus } = await new WarpService(logManager).applyLicense(
          dev.deviceId,
          dev.token,
          args.license
        );
        return { ok: true, warpPlus };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }
  );
}
