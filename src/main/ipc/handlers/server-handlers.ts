/**
 * 服务器管理 IPC 处理器
 * 处理服务器配置相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ServerConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';
import { collectRuleTargetedServerIds } from '../../../shared/endpoint-routes';
import { DIRECT_SERVER_ID } from '../../../shared/direct-selection';
import { ProtocolParser } from '../../services/ProtocolParser';
import { ConfigManager } from '../../services/ConfigManager';
import { WarpService, type WarpWireGuardDraft } from '../../services/WarpService';
import { getWarpDeregisterQueue } from '../../services/WarpDeregisterQueue';
import { tailscaleStateDir } from '../../services/tailscale-state';
import type { LogManager } from '../../services/LogManager';

/**
 * 注册服务器管理相关的 IPC 处理器
 * @param logManager 可选，供 WARP 设备注销队列记录日志（只打 deviceId 前缀，绝不打 token）
 */
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

  // 生成分享 URL
  registerIpcHandler<{ server: ServerConfig }, string>(
    IPC_CHANNELS.SERVER_GENERATE_URL,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      return protocolParser.generateUrl(args.server);
    }
  );

  // 添加服务器
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

  // 更新服务器
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

  // 删除服务器
  // D4（flowz-node-change-restart）：删「当前选中 / 被规则指向」节点 → emit CONFIG_CHANGED 触发一次去抖重启
  //   （servers 变→P2-A 兜底重启，把已删节点彻底移出运行核 selector）；删「纯未引用」节点 → 不 emit（defer，惰性
  //   成员无流量、无害，下次结构性重启清）。删选中时 selectedServerId 置**渲染端传入的兜底节点**（最快剩余节点，
  //   pickFallbackExit，latency 在渲染端），而非 null——避免删当前出口后无选中兜底（原 null → default nodeTags[0]）。
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
      // 被 enabled+proxy 规则显式指向（custom/app）：删它须重启清运行核陈旧引用（口径与 route-builder/UI 同源）。
      const ruleTargeted = collectRuleTargetedServerIds([
        ...(config.customRules ?? []),
        ...(config.appRules ?? []),
      ]).has(args.serverId);

      // 删当前选中 → 兜底出口（渲染端最快剩余节点）；无剩余(null/undefined) → DIRECT_SERVER_ID 哨兵（干净直连，
      // proxy-selector default='direct'）。**不可置 null**：null 非哨兵 → 0 节点时 buildOutbounds `nodeTags.length===0
      // && !isDirect` throw「没有可用节点」→ 重启失败（设计 D4：0 剩余→direct）。
      if (wasSelected) {
        config.selectedServerId = args.fallbackSelectedId ?? DIRECT_SERVER_ID;
      }

      await configManager.saveConfig(config);
      await runServerRemovalSideEffects(removed);

      if (wasSelected || ruleTargeted) {
        mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
      }
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

      // D4：删除集合是否含「当前选中 / 被规则指向」节点 → 决定是否触发重启（同单删语义）。
      const selectedDeleted = !!config.selectedServerId && idSet.has(config.selectedServerId);
      const ruleTargetedIds = collectRuleTargetedServerIds([
        ...(config.customRules ?? []),
        ...(config.appRules ?? []),
      ]);
      const ruleTargetedDeleted = args.serverIds.some((id) => ruleTargetedIds.has(id));

      // 选中节点在删除集合内（'__direct__' 哨兵不是真实 id，不会命中）→ 置兜底节点（渲染端最快剩余节点）；
      // 无剩余 → DIRECT_SERVER_ID（同单删：null 会致 0 节点重启 throw）。
      if (selectedDeleted) {
        config.selectedServerId = args.fallbackSelectedId ?? DIRECT_SERVER_ID;
      }

      await configManager.saveConfig(config);
      for (const r of removed) {
        await runServerRemovalSideEffects(r);
      }

      if (selectedDeleted || ruleTargetedDeleted) {
        mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
      }
      return removed.length;
    }
  );

  // 获取所有服务器
  registerIpcHandler<void, ServerConfig[]>(
    IPC_CHANNELS.SERVER_GET_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return config.servers;
    }
  );

  // 切换服务器
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
