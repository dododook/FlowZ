import { IpcMainInvokeEvent, dialog } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { SubscriptionConfig, ImportParseResult, UserConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { SubscriptionService, SubscriptionUpdateResult } from '../../services/SubscriptionService';
import type { SubscriptionPreviewResult } from '../../../shared/subscription-preview';
import { ConfigManager } from '../../services/ConfigManager';
import { resolveSubscriptionViaProxy } from '../../../shared/subscription-proxy';
import { mt } from '../../i18n';
import { randomUUID } from 'crypto';

/**
 * 注册订阅管理相关的 IPC 处理器。
 * @param applyConfigForcingRestart §16.3.4b：手动订阅更新（节点集变化）→ 强制核去抖重启入池（绕 P2-A）。call-time 取
 *   proxyManager（对齐 scheduler 装配、防循环依赖）；缺省=不重启（如单测/无代理实例）。
 */
export function registerSubscriptionHandlers(
  subscriptionService: SubscriptionService,
  configManager: ConfigManager,
  applyConfigForcingRestart?: (config: UserConfig) => void
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
        // §16.3.4：条件 GET——provider 型订阅豁免（主正文 304 会掩盖 provider 独立变化）；否则带上次 validator。
        const conditional = subscription.hasProviders
          ? undefined
          : { etag: subscription.etag, lastModified: subscription.lastModified };
        const result = await subscriptionService.fetchSubscription(
          subscription.url,
          subscription.id,
          resolveSubscriptionViaProxy(config.subscriptionProxyPolicy, subscription.updateViaProxy),
          subscription.userAgent ?? config.subscriptionUserAgent,
          conditional
        );

        // §16.3.4：304 无变化 → 仅刷元数据（lastUpdated + validators），不 reconcile、不 force-restart（零节点扰动）。
        if (result.notModified) {
          subscription.lastUpdated = new Date().toISOString();
          if (result.etag) subscription.etag = result.etag;
          if (result.lastModified) subscription.lastModified = result.lastModified;
          await configManager.saveConfig(config);
          return {
            success: true,
            addedServers: 0,
            updatedServers: 0,
            deletedServers: 0,
            unchanged: true,
          };
        }

        const fetchedServers = result.servers;

        // 获取原来的该订阅下的节点，按稳定指纹对账（不依赖显示名）
        const oldServers = config.servers.filter((s) => s.subscriptionId === subscription.id);
        const {
          servers: newServersToKeep,
          added,
          updated,
          deleted,
          deletedIds,
          contentChanged,
        } = SubscriptionService.reconcileServers(
          oldServers,
          fetchedServers,
          new Date().toISOString()
        );

        // L-5：200 但节点集内容等价（contentChanged=false，非 partial）→ 仅刷元数据 + validators，不替换 servers
        // （避免顺序 churn）、返回 unchanged（toast 显「订阅无变化」而非「更新 N 个」，与 304 口径一致）。
        if (!contentChanged && !result.partial) {
          subscription.lastUpdated = new Date().toISOString();
          if (result.userInfo) subscription.userInfo = result.userInfo;
          subscription.etag = result.etag;
          subscription.lastModified = result.lastModified;
          subscription.hasProviders = result.hasProviders;
          await configManager.saveConfig(config);
          return {
            success: true,
            addedServers: 0,
            updatedServers: 0,
            deletedServers: 0,
            unchanged: true,
          };
        }

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
        // §16.3.4：回写验证器 + hasProviders（下次条件 GET / provider 豁免）。
        // L-3：200 路径**无条件**写 etag/lastModified（含清除）——服务端撤 validator 后不残留旧值，避免内容回滚伪 304。
        subscription.etag = result.etag;
        subscription.lastModified = result.lastModified;
        subscription.hasProviders = result.hasProviders;

        await configManager.saveConfig(config);

        // §16.3.4b：手动更新 + 节点集真变化 → 强制核去抖重启，把新增/改址节点纳入主核（及测速池）→ 立即可测。
        // applyConfigForcingRestart 内部 guard 代理未运行/换核窗口（不重启）；无变化不调（省一次重启抖动）。
        // M-3：partial（provider 瞬时失败）下 leftoverToKeep 会全量恢复被判「删除」的节点 → 最终 config.servers 可能
        // 与刷新前等价，但 contentChanged（reconcile 在 merge-back 前求值）仍为 true → 会误触整核重启（断连+打断测速）。
        // 保守：partial 时不 force-restart（违反「无变化恒不重启」不划算）；真变化随下次成功刷新/结构性变更纳入。
        if (contentChanged && !result.partial) {
          applyConfigForcingRestart?.(config);
        }

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

  // 订阅预检（新增订阅前先行，不写 config）：拉取+解析 URL 返回节点数或分类错误，成功才建记录（避免先加后删闪现）。
  registerIpcHandler<
    { url: string; viaProxy?: boolean; userAgent?: string },
    SubscriptionPreviewResult
  >(
    IPC_CHANNELS.SUBSCRIPTION_PREVIEW,
    async (
      _event: IpcMainInvokeEvent,
      args: { url: string; viaProxy?: boolean; userAgent?: string }
    ) => {
      return subscriptionService.previewSubscription(args.url, {
        viaProxy: args.viaProxy,
        userAgent: args.userAgent,
      });
    }
  );

  // 本地导入解析（不联网）：文件/文本 → 预览（自建节点 + Clash 订阅条目 + 统计）。不可识别格式 throw → 渲染端门控报错。
  registerIpcHandler<{ text: string }, ImportParseResult>(
    IPC_CHANNELS.LOCAL_IMPORT_PARSE,
    async (_event: IpcMainInvokeEvent, args: { text: string }) => {
      return subscriptionService.parseLocalContent(args?.text ?? '');
    }
  );

  // 本地导入选文件：弹系统原生文件对话框 + 读内容回传。替代渲染端 HTML <input type=file>——避开 Chromium 原生
  // 控件英文文案（"Choose File / No file chosen"，受 Chromium app locale 控、非 i18next），系统对话框天然跟随
  // 系统语言、文件名+按钮走 i18next；10 MB 上限与解析门限（local-import-dialog）一致。取消返 canceled，读失败返 error。
  registerIpcHandler<
    void,
    { canceled: boolean; content?: string; fileName?: string; error?: 'too_large' | 'read_failed' }
  >(IPC_CHANNELS.LOCAL_IMPORT_PICK_FILE, async (_event: IpcMainInvokeEvent) => {
    const result = await dialog.showOpenDialog({
      title: mt('localImportPickTitle'),
      filters: [
        { name: mt('localImportFilterConfig'), extensions: ['json', 'yaml', 'yml', 'txt', 'conf'] },
        { name: mt('localImportFilterAll'), extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = result.filePaths[0];
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 10 * 1024 * 1024) {
        return { canceled: false, error: 'too_large' };
      }
      const content = await fs.readFile(filePath, 'utf-8');
      return { canceled: false, content, fileName: path.basename(filePath) };
    } catch {
      return { canceled: false, error: 'read_failed' };
    }
  });

  // 启动补更/周期更新已由 SubscriptionScheduler 接管（含退避+防丢更新两阶段），此处不再注册 UPDATE_ALL
}
