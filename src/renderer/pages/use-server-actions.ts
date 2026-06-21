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
} from '@/bridge/api-wrapper';
import type { ServerConfig, SubscriptionConfig } from '@/bridge/types';
import { buildSavedServers, buildClonedServer, type NewServerData } from './server-mutations';
import { tailscaleSlotTaken } from '../../shared/endpoint-routes';

export function useServerActions() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const deleteServerStore = useAppStore((s) => s.deleteServer);
  const loadConfig = useAppStore((s) => s.loadConfig);
  const [updatingSubId, setUpdatingSubId] = useState<string | null>(null);

  const servers = config?.servers || [];

  const deleteServer = async (serverId: string) => {
    try {
      await deleteServerStore(serverId);
      toast.success(t('servers.deleteSuccess'));
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
      toast.success(t('servers.selectSuccess'));
    } catch (error) {
      toast.error(t('servers.selectFail'), {
        description: error instanceof Error ? error.message : t('servers.selectFailDesc'),
      });
    }
  };

  const saveServer = async (serverData: NewServerData, editingServer: ServerConfig | undefined) => {
    try {
      if (!config) throw new Error(t('errors.configNotLoaded'));
      // Tailscale 单节点硬限：新增（非编辑）一个 TS 节点但已存在另一个 → 拦下不写。
      // editingServer?.id 排除自身，编辑现有 TS 节点放行。
      if (
        serverData.protocol?.toLowerCase() === 'tailscale' &&
        tailscaleSlotTaken(servers, editingServer?.id)
      ) {
        toast.error(t('servers.tailscaleSingleOnly'));
        return;
      }
      const now = new Date().toISOString();
      const updatedServers = buildSavedServers(
        servers,
        serverData,
        editingServer,
        crypto.randomUUID(),
        now
      );
      await saveConfig({ ...config, servers: updatedServers });

      const action = editingServer ? t('servers.actionUpdate') : t('servers.actionAdd');
      toast.success(t('servers.saveSuccess', { action }), {
        description: t('servers.saveSuccessDesc', { name: serverData.name }),
      });
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
    setUpdatingSubId(subId);
    try {
      const res = await apiUpdateSubscriptionServers(subId);
      if (res.success) await loadConfig();
    } finally {
      setUpdatingSubId(null);
    }
  };

  const saveSubscription = async (
    subData: Omit<SubscriptionConfig, 'id' | 'createdAt'>,
    editingSub: SubscriptionConfig | undefined
  ) => {
    if (editingSub) {
      const updatedSub: SubscriptionConfig = {
        ...subData,
        id: editingSub.id,
        createdAt: editingSub.createdAt,
        lastUpdated: editingSub.lastUpdated,
      };
      const res = await updateSubscription(updatedSub);
      if (res.success) await loadConfig();
    } else {
      const res = await addSubscription(subData);
      if (res.success && res.data) {
        await updateSubscriptionServers(res.data.id);
      }
    }
  };

  return {
    updatingSubId,
    deleteServer,
    selectServer,
    saveServer,
    cloneServer,
    importSuccess,
    deleteSubscription,
    updateSubscriptionServers,
    saveSubscription,
  };
}
