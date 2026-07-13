/**
 * server-page 的服务器/订阅 CRUD 编排 hook —— 从页面内联 handler 下沉（审计 §1/§6 Tier-2）。
 * 收口 store(saveConfig/deleteServer/loadConfig) + 订阅 IPC + toast + 纯变更逻辑(server-mutations)；
 * 页面只保留对话框/Tab 等本地 UI 态。saveServer/saveSubscription 需对话框的 editing 目标，故由调用方传入。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import {
  addSubscription,
  updateSubscription,
  deleteSubscription as apiDeleteSubscription,
  updateSubscriptionServers as apiUpdateSubscriptionServers,
  previewSubscription as apiPreviewSubscription,
} from '@/bridge/api-wrapper';
import type { ServerConfig, SubscriptionConfig } from '@/bridge/types';
import type { SubscriptionErrorKind } from '@shared/subscription-preview';
import { buildSavedServers, buildClonedServer, type NewServerData } from './server-mutations';
import { tailscaleSlotTaken, referencedServerIds } from '../../shared/endpoint-routes';
import { isWarpServer, warpSlotTaken } from '../../shared/warp';

// saveSubscription 的可判定返回：ok=false 让对话框保留不关、留住用户输入（原全吞错致失败仍关窗丢输入）。
// 成功携带 sub，供调用方（server-page）setTabOverride 切到该订阅分组。
// add 路径预检失败携带 errorKind/httpStatus，供对话框按分类展示错误文案（不建任何记录 → 无闪现）。
export interface SaveSubscriptionResult {
  ok: boolean;
  sub?: SubscriptionConfig;
  errorKind?: SubscriptionErrorKind;
  httpStatus?: number;
}

export function useServerActions() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const deleteServerStore = useAppStore((s) => s.deleteServer);
  const deleteServersStore = useAppStore((s) => s.deleteServers);
  const loadConfig = useAppStore((s) => s.loadConfig);
  // 「删了会不会触发整核重启/重新生效」的判定输入：核未运行则无核可重启（下方 restart 谓词据此闸掉「配置已重新生效」谎报）。
  const proxyRunning = useAppStore((s) => !!s.connectionStatus?.proxyCore?.running);
  // 单槽 string|null → 多槽 Set：并发更新多个订阅时后发者会覆盖前者的 subId，导致前者 spinner 提前熄灭。
  // 用 Set 让每个在更新的订阅各自持有独立 spinner；不可变更新（new Set）保证 React 感知引用变化。
  const [updatingSubIds, setUpdatingSubIds] = useState<Set<string>>(new Set());

  const servers = config?.servers || [];

  // 删除成功三态 toast（单删/批删共用）：fallback≠undefined=删了选中节点（null→切直连 / string→切到兜底节点显名，
  // 该切换本身已隐含重启）；否则 restarted=删了「被引用」节点且核在运行（后端整核重启、配置重新生效）；否则普通删除（defer 不重启）。
  const showDeleteToast = (fallback: string | null | undefined, restarted: boolean) => {
    if (fallback !== undefined) {
      if (fallback === null) {
        toast.success(t('servers.deleteSelectedToDirect'));
      } else {
        const name = servers.find((s) => s.id === fallback)?.name ?? fallback;
        toast.success(t('servers.deleteSelectedSwitched', { name }));
      }
    } else if (restarted) {
      toast.success(t('servers.deleteRestarted'));
    } else {
      toast.success(t('servers.deleteSuccess'));
    }
  };

  // 删该节点是否触发后端整核重启：口径与主进程重启真值（ProxyManager.canSkip / getPendingNodeChanges）同源 =
  // referencedServerIds（{选中}∪{启用规则目标}∪detour 前置链闭包∪全部 endpoint 节点）——而非旧的 collectRuleTargetedServerIds
  // （仅 enabled+proxy 规则直接目标，漏 detour 前驱/endpoint/选中 → 会漏报重启）。**须 && proxyRunning**：核未运行时删任何
  // 节点都不重启、无「配置重新生效」可言（旧逻辑不看 proxyRunning → 停核时删被引用节点仍谎报「已重新生效」）。
  const willRestartOnDelete = (ids: string[]): boolean => {
    if (!proxyRunning || !config) return false;
    const ref = referencedServerIds(config);
    return ids.some((id) => ref.has(id));
  };

  const deleteServer = async (serverId: string) => {
    const restarted = willRestartOnDelete([serverId]);
    try {
      const fallback = await deleteServerStore(serverId);
      showDeleteToast(fallback, restarted);
    } catch (error) {
      toast.error(t('servers.deleteFail'), {
        description: error instanceof Error ? error.message : t('servers.deleteFailDesc'),
      });
    }
  };

  // 批量删除（一次后端配置写，避免并发单删竞态致只删 1 个）。订阅节点的过滤在调用方（server-list）完成。
  const deleteServers = async (serverIds: string[]) => {
    if (serverIds.length === 0) return;
    const restarted = willRestartOnDelete(serverIds);
    try {
      const { fallback } = await deleteServersStore(serverIds);
      showDeleteToast(fallback, restarted);
    } catch (error) {
      toast.error(t('servers.deleteFail'), {
        description: error instanceof Error ? error.message : t('servers.deleteFailDesc'),
      });
    }
  };

  const selectServer = async (serverId: string) => {
    if (!config) return;
    try {
      await saveConfig({ ...config, selectedServerId: serverId });
      // 选节点不弹「已选择」成功 toast（用户反馈：卡片即时高亮「当前」ring 即为反馈、无需提醒；同首页选节点/接管方式 toast 移除理由）。
    } catch (error) {
      toast.error(t('servers.selectFail'), {
        description: error instanceof Error ? error.message : t('servers.selectFailDesc'),
      });
    }
  };

  const saveServer = async (
    serverData: NewServerData,
    editingServer: ServerConfig | undefined
  ): Promise<ServerConfig | undefined> => {
    try {
      if (!config) throw new Error(t('errors.configNotLoaded'));
      // Tailscale 单节点硬限：新增（非编辑）一个 TS 节点但已存在另一个 → 拦下不写。
      // editingServer?.id 排除自身，编辑现有 TS 节点放行。
      if (
        serverData.protocol?.toLowerCase() === 'tailscale' &&
        tailscaleSlotTaken(servers, editingServer?.id)
      ) {
        toast.error(t('servers.tailscaleSingleOnly'));
        return undefined;
      }
      // WARP 单例硬闸门：新增（非编辑）一个 WARP 节点但已存在另一个 WARP → 拦下不写。
      // 手输 / 本地导入 / 克隆均经 saveServer 收口，防「接入区 UI 单例」被旁路造出第二个 WARP。
      // editingId 排除自身——编辑现有 WARP 放行。
      if (isWarpServer(serverData) && warpSlotTaken(servers, editingServer?.id)) {
        toast.error(t('servers.warpSingleOnly'));
        return undefined;
      }
      const now = new Date().toISOString();
      const newId = crypto.randomUUID();
      const updatedServers = buildSavedServers(servers, serverData, editingServer, newId, now);
      await saveConfig({ ...config, servers: updatedServers });

      const action = editingServer ? t('servers.actionUpdate') : t('servers.actionAdd');
      toast.success(t('servers.saveSuccess', { action }), {
        description: t('servers.saveSuccessDesc', { name: serverData.name }),
      });
      // 返回保存后的目标节点（新建=带 newId 的新节点 / 编辑=更新后的现有节点），供调用方拿 id 后续操作
      // （如单例卡「连接 Tailscale」无节点时先建节点、再立即用其 id 发起交互登录）。其它调用方忽略返回值即可。
      return updatedServers.find((s) => s.id === (editingServer?.id ?? newId));
    } catch (error) {
      toast.error(t('servers.saveFail'), {
        description: error instanceof Error ? error.message : t('servers.saveFailDesc'),
      });
      throw error;
    }
  };

  // 克隆节点到自建列表：生成脱离订阅的持久副本（订阅节点的本地自定义需用此方式保留）
  const cloneServer = async (server: ServerConfig) => {
    if (!config) return;
    // Tailscale 单节点硬限：克隆恒产出新增第二节点，克隆 TS 必撞限（含克隆源自身）→ 拦下，否则克隆绕过闸门。
    if (server.protocol?.toLowerCase() === 'tailscale' && tailscaleSlotTaken(servers)) {
      toast.error(t('servers.tailscaleSingleOnly'));
      return;
    }
    // WARP 单例硬限：克隆 WARP 恒产出第二个 WARP（含克隆源自身在列表内）→ 拦下，否则克隆绕过单例闸门。
    if (isWarpServer(server) && warpSlotTaken(servers)) {
      toast.error(t('servers.warpSingleOnly'));
      return;
    }
    try {
      const now = new Date().toISOString();
      const cloned = buildClonedServer(
        server,
        t('servers.cloneNameSuffix', { name: server.name }),
        crypto.randomUUID(),
        now
      );
      await saveConfig({ ...config, servers: [...servers, cloned] });
      toast.success(t('servers.cloneSuccess'), { description: cloned.name });
    } catch (error) {
      toast.error(t('servers.cloneFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const importSuccess = async () => {
    await loadConfig();
    toast.success(t('servers.importSuccess'));
  };

  const deleteSubscription = async (subId: string) => {
    const res = await apiDeleteSubscription(subId);
    if (res.success) await loadConfig();
  };

  const updateSubscriptionServers = async (subId: string) => {
    // 进入更新态：把本 subId 加入 Set（不可变更新，避免并发更新互相覆盖 spinner）。
    setUpdatingSubIds((prev) => {
      const next = new Set(prev);
      next.add(subId);
      return next;
    });
    try {
      const res = await apiUpdateSubscriptionServers(subId);
      if (res.success) await loadConfig();
    } finally {
      // 退出更新态：仅移除本 subId，其它并发更新中的订阅 spinner 不受影响。
      setUpdatingSubIds((prev) => {
        const next = new Set(prev);
        next.delete(subId);
        return next;
      });
    }
  };

  const saveSubscription = async (
    subData: Omit<SubscriptionConfig, 'id' | 'createdAt'>,
    editingSub: SubscriptionConfig | undefined
  ): Promise<SaveSubscriptionResult> => {
    if (editingSub) {
      // L-4：编辑保存重建对象须保留非表单字段——userInfo（流量）恒保留；条件 GET validators + hasProviders 仅 URL
      // 未变时保留（URL 变=不同资源，旧 validator 无意义、旧 hasProviders 可能错 → 丢弃走全量拉取）。否则 #92 新字段
      // 连同既有 userInfo 被全量替换抹掉（损失一次 304 优化）。
      const urlUnchanged = subData.url === editingSub.url;
      const updatedSub: SubscriptionConfig = {
        ...subData,
        id: editingSub.id,
        createdAt: editingSub.createdAt,
        lastUpdated: editingSub.lastUpdated,
        ...(editingSub.userInfo ? { userInfo: editingSub.userInfo } : {}),
        ...(urlUnchanged && editingSub.etag ? { etag: editingSub.etag } : {}),
        ...(urlUnchanged && editingSub.lastModified
          ? { lastModified: editingSub.lastModified }
          : {}),
        ...(urlUnchanged && editingSub.hasProviders !== undefined
          ? { hasProviders: editingSub.hasProviders }
          : {}),
      };
      const res = await updateSubscription(updatedSub);
      // 失败（api-wrapper 已 toast）返回 ok:false → 对话框不关、留住用户输入。
      if (!res.success) return { ok: false };
      await loadConfig();
      return { ok: true, sub: updatedSub };
    }
    // 预检先行：add 前用 URL 拉取+解析（**不写 config、不建记录**），成功才建记录，失败留窗 + 分类错误（无先加后删闪现）。
    const pre = await apiPreviewSubscription(subData.url, {
      viaProxy: subData.updateViaProxy,
      userAgent: subData.userAgent,
    });
    if (!pre.ok) {
      // 不建任何记录 → 对话框据 errorKind/httpStatus 展示错误、留窗；无闪现节点。
      return { ok: false, errorKind: pre.errorKind, httpStatus: pre.httpStatus };
    }
    const res = await addSubscription(subData);
    // 新增失败（api-wrapper 已 toast）→ ok:false，对话框不关。
    if (!res.success || !res.data) return { ok: false };
    // tab 修复：先 loadConfig 让新订阅立即进入 config（分组/tab 即时可见），再拉取其节点；
    // 最后返回新 sub 供调用方 setTabOverride 切到该订阅分组。
    await loadConfig();
    await updateSubscriptionServers(res.data.id);
    return { ok: true, sub: res.data };
  };

  return {
    updatingSubIds,
    deleteServer,
    deleteServers,
    selectServer,
    saveServer,
    cloneServer,
    importSuccess,
    deleteSubscription,
    updateSubscriptionServers,
    saveSubscription,
  };
}
