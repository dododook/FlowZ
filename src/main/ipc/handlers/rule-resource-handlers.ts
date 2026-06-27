/**
 * 规则资源 IPC 处理器：列表 / 下载 / 重下 / 删除 / 设加速 / 资源库 catalog（取+刷新）。
 * 下载进度推送走 EVENT_RULE_RESOURCE_PROGRESS（由 RuleResourceManager.emitProgress 广播）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  RuleResourceCatalogResult,
  RuleResourceDownloadItem,
  RuleResourceDeleteResult,
  RuleResourceDownloadResult,
  RuleResourceListItem,
} from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import type { RuleResourceManager } from '../../services/RuleResourceManager';

export function registerRuleResourceHandlers(manager: RuleResourceManager): void {
  registerIpcHandler<void, RuleResourceListItem[]>(IPC_CHANNELS.RULE_RESOURCES_LIST, async () =>
    manager.list()
  );

  registerIpcHandler<{ items: RuleResourceDownloadItem[] }, RuleResourceDownloadResult[]>(
    IPC_CHANNELS.RULE_RESOURCES_DOWNLOAD,
    async (_e: IpcMainInvokeEvent, args: { items: RuleResourceDownloadItem[] }) =>
      manager.download(args?.items || [])
  );

  registerIpcHandler<{ id: string }, RuleResourceDownloadResult>(
    IPC_CHANNELS.RULE_RESOURCES_REDOWNLOAD,
    async (_e: IpcMainInvokeEvent, args: { id: string }) => manager.redownload(args.id)
  );

  registerIpcHandler<{ id: string; force?: boolean }, RuleResourceDeleteResult>(
    IPC_CHANNELS.RULE_RESOURCES_DELETE,
    async (_e: IpcMainInvokeEvent, args: { id: string; force?: boolean }) =>
      manager.delete(args.id, args.force === true)
  );

  registerIpcHandler<{ prefix: string }, { ok: boolean; value?: string; error?: string }>(
    IPC_CHANNELS.RULE_RESOURCES_SET_GH_PROXY,
    async (_e: IpcMainInvokeEvent, args: { prefix: string }) =>
      manager.setGhProxy(args?.prefix ?? '')
  );

  registerIpcHandler<void, RuleResourceCatalogResult>(
    IPC_CHANNELS.RULE_RESOURCES_GET_CATALOG,
    async () => manager.getCatalog()
  );

  registerIpcHandler<void, RuleResourceCatalogResult>(
    IPC_CHANNELS.RULE_RESOURCES_REFRESH_CATALOG,
    async () => manager.refreshCatalog()
  );

  registerIpcHandler<{ enabled: boolean; intervalHours?: number }, { ok: boolean }>(
    IPC_CHANNELS.RULE_RESOURCES_SET_AUTO_UPDATE,
    async (_e: IpcMainInvokeEvent, args: { enabled: boolean; intervalHours?: number }) =>
      manager.setAutoUpdate(args)
  );

  // 「全部更新」：强制全量重下载（非 silent，复用页面进度行）。内置项经 updateMany 分流到 updateBuiltin。
  registerIpcHandler<void, RuleResourceDownloadResult[]>(
    IPC_CHANNELS.RULE_RESOURCES_UPDATE_ALL,
    async () => {
      const list = await manager.list();
      return manager.updateMany(
        list.map((r) => r.id),
        { silent: false }
      );
    }
  );

  // 重置内置 geo 规则集为出厂版（误更新坏数据退路）
  registerIpcHandler<{ tag: string }, RuleResourceDownloadResult>(
    IPC_CHANNELS.RULE_RESOURCES_RESET_BUILTIN,
    async (_e: IpcMainInvokeEvent, args: { tag: string }) => manager.resetBuiltin(args.tag)
  );

  // 图标库拉取（自定义规则图标选择器）：经 update-in 统一会话，取代 renderer 直接 fetch（Phase 1b）
  registerIpcHandler<void, Array<{ name: string; url: string }>>(
    IPC_CHANNELS.RULE_RESOURCES_ICON_GALLERIES,
    async () => manager.fetchIconGalleries()
  );
}
