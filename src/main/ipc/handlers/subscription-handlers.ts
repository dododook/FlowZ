import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { SubscriptionConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { SubscriptionService, SubscriptionUpdateResult } from '../../services/SubscriptionService';
import { ConfigManager } from '../../services/ConfigManager';
import { resolveSubscriptionViaProxy } from '../../../shared/subscription-proxy';
import { randomUUID } from 'crypto';

/**
 * 注册订阅管理相关的 IPC 处理器
 */
export function registerSubscriptionHandlers(
  subscriptionService: SubscriptionService,
  configManager: ConfigManager
): void {
  // 添加订阅
  registerIpcHandler<
    { subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'> },
    SubscriptionConfig
  >(
    IPC_CHANNELS.SUBSCRIPTION_ADD,
    async (
      _event: IpcMainInvokeEvent,
      args: { subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'> }
    ) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) {
        config.subscriptions = [];
      }

      const now = new Date().toISOString();
      const newSubscription: SubscriptionConfig = {
        ...args.subscription,
        id: randomUUID(),
        createdAt: now,
      };

      config.subscriptions.push(newSubscription);
      await configManager.saveConfig(config);

      return newSubscription;
    }
  );

  // 更新订阅配置
  registerIpcHandler<{ subscription: SubscriptionConfig }, void>(
    IPC_CHANNELS.SUBSCRIPTION_UPDATE,
    async (_event: IpcMainInvokeEvent, args: { subscription: SubscriptionConfig }) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) return;

      const index = config.subscriptions.findIndex((s) => s.id === args.subscription.id);
      if (index === -1) {
        throw new Error(`订阅不存在: ${args.subscription.id}`);
      }

      config.subscriptions[index] = args.subscription;
      await configManager.saveConfig(config);
    }
  );

  // 删除订阅
  registerIpcHandler<{ subscriptionId: string }, void>(
    IPC_CHANNELS.SUBSCRIPTION_DELETE,
    async (_event: IpcMainInvokeEvent, args: { subscriptionId: string }) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) return;

      const index = config.subscriptions.findIndex((s) => s.id === args.subscriptionId);
      if (index === -1) {
        throw new Error(`订阅不存在: ${args.subscriptionId}`);
      }

      // 删除订阅
      config.subscriptions.splice(index, 1);

      // 删除该订阅下的所有节点
      config.servers = config.servers.filter((s) => s.subscriptionId !== args.subscriptionId);

      // 如果当前选中的节点被删除了，清除选中状态
      if (config.selectedServerId) {
        const stillExists = config.servers.some((s) => s.id === config.selectedServerId);
        if (!stillExists) {
          config.selectedServerId = null;
        }
      }

      await configManager.saveConfig(config);
    }
  );

  // 更新订阅节点
  registerIpcHandler<{ subscriptionId: string }, SubscriptionUpdateResult>(
    IPC_CHANNELS.SUBSCRIPTION_UPDATE_SERVERS,
    async (_event: IpcMainInvokeEvent, args: { subscriptionId: string }) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) throw new Error('没有订阅配置');

      const subscription = config.subscriptions.find((s) => s.id === args.subscriptionId);
      if (!subscription) {
        throw new Error(`订阅不存在: ${args.subscriptionId}`);
      }

      try {
        const result = await subscriptionService.fetchSubscription(
          subscription.url,
          subscription.id,
          resolveSubscriptionViaProxy(config.subscriptionProxyPolicy, subscription.updateViaProxy),
          subscription.userAgent ?? config.subscriptionUserAgent
        );
        const fetchedServers = result.servers;

        // 获取原来的该订阅下的节点，按稳定指纹对账（不依赖显示名）
        const oldServers = config.servers.filter((s) => s.subscriptionId === subscription.id);
        const {
          servers: newServersToKeep,
          added,
          updated,
          deleted,
          deletedIds,
        } = SubscriptionService.reconcileServers(
          oldServers,
          fetchedServers,
          new Date().toISOString()
        );

        // partial（Clash provider 部分失败）→ merge-only 防穿仓：M1 改为 provider 级精确——只保留「失败 provider
        // 名下」的下架节点（防某 provider 临时 503 误删其托管存量，FlowZ 无本地 path 缓存兜底），成功 provider
        // 的真下架正常删除。
        let finalKeep = newServersToKeep;
        let finalDeleted = deleted;
        if (result.partial && deletedIds.size > 0) {
          const leftover = SubscriptionService.leftoverToKeep(
            oldServers,
            deletedIds,
            result.failedProviders
          );
          finalKeep = [...newServersToKeep, ...leftover];
          finalDeleted = deleted - leftover.length;
        }
        // selectedServerId 被删且未被 leftover 保留 → 清空（partial 精确删除后也可能删掉选中节点）
        if (
          config.selectedServerId &&
          deletedIds.has(config.selectedServerId) &&
          !finalKeep.some((s) => s.id === config.selectedServerId)
        ) {
          config.selectedServerId = null;
        }

        const otherServers = config.servers.filter((s) => s.subscriptionId !== subscription.id);
        config.servers = [...otherServers, ...finalKeep];

        // 更新订阅的最后更新时间和流量信息
        subscription.lastUpdated = new Date().toISOString();
        if (result.userInfo) {
          subscription.userInfo = result.userInfo;
        }

        await configManager.saveConfig(config);

        return {
          success: true,
          addedServers: added,
          updatedServers: updated,
          deletedServers: finalDeleted,
          userInfo: result.userInfo,
        };
      } catch (error: any) {
        return {
          success: false,
          addedServers: 0,
          updatedServers: 0,
          deletedServers: 0,
          error: error.message,
        };
      }
    }
  );

  // 启动补更/周期更新已由 SubscriptionScheduler 接管（含退避+防丢更新两阶段），此处不再注册 UPDATE_ALL
}
