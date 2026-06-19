import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { ServerList } from '@/components/settings/server-list';
import { ServerConfigDialog } from '@/components/settings/server-config-dialog';
import { SubscriptionDialog } from '@/components/settings/subscription-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, RefreshCw, Rss, Server, Network } from 'lucide-react';
import { isEndpointProtocol } from '../../shared/endpoint-routes';
import { groupServersBySubscription } from '../../shared/server-grouping';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { ServerConfig, SubscriptionConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { useServerActions } from './use-server-actions';

type ServerConfigWithId = ServerConfig;

export function ServerPage() {
  const { t, i18n } = useTranslation();
  const config = useAppStore((state) => state.config);

  const {
    updatingSubId,
    deleteServer: handleDeleteServer,
    selectServer: handleSelectServer,
    cloneServer: handleCloneServer,
    importSuccess: handleImportSuccess,
    deleteSubscription: handleDeleteSubscription,
    updateSubscriptionServers: handleUpdateSubscriptionServers,
    saveServer,
    saveSubscription,
  } = useServerActions();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfigWithId | undefined>();

  const [isSubDialogOpen, setIsSubDialogOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<SubscriptionConfig | undefined>();

  const servers = config?.servers || [];
  const subscriptions = config?.subscriptions || [];
  const selectedServerId = config?.selectedServerId;
  const subscriptionIds = new Set(subscriptions.map((s) => s.id));

  // 自建 / 组网 / 各订阅分组**收口到共享单一真值** groupServersBySubscription——与下拉选择器、托盘菜单同一口径，
  // 杜绝「列表页归组网、下拉归自建」漂移。自建 Tab 仅代理节点，组网 Tab = endpoint（WireGuard/WARP/Tailscale）。
  const grouped = groupServersBySubscription(servers, subscriptions);
  // 按组 id 统一取数（manual/mesh/订阅 id）；空组在 grouped 中被省略，回落 []（仍渲染该订阅 tab 供更新）。
  const serversOfGroup = (id: string) => grouped.find((g) => g.id === id)?.servers ?? [];
  const manualProxyServers = serversOfGroup('manual');
  const meshServers = serversOfGroup('mesh');

  // 默认激活 Tab = 当前选中节点所在组（自建 / 组网 / 某订阅）；用户手动切 Tab 后由 override 接管。
  // 用「派生 + override」而非 useState 惰性初值：config 异步到位前挂载不会把激活组锁死在 'manual'。
  const selected = selectedServerId ? servers.find((s) => s.id === selectedServerId) : undefined;
  const selectedGroupKey =
    selected?.subscriptionId && subscriptionIds.has(selected.subscriptionId)
      ? selected.subscriptionId
      : selected && isEndpointProtocol(selected.protocol)
        ? 'mesh'
        : 'manual';
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const activeTab =
    tabOverride &&
    (tabOverride === 'manual' ||
      // 组网 Tab 仅在有组网节点时有效——删光最后一个组网节点后从 mesh 回落，避免停在无 Trigger 的空 Tab。
      (tabOverride === 'mesh' && meshServers.length > 0) ||
      subscriptionIds.has(tabOverride))
      ? tabOverride
      : selectedGroupKey;

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // 如果垂直滚动幅度大于水平滚动幅度，则将其转换为水平滚动
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };

    // 使用 passive: false 以便可以调用 preventDefault 阻止页面垂直滚动
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ================= 服务器操作 =================

  const handleAddServer = () => {
    setEditingServer(undefined);
    setIsDialogOpen(true);
  };

  const handleEditServer = (server: ServerConfigWithId) => {
    setEditingServer(server);
    setIsDialogOpen(true);
  };

  const handleSaveServer = (
    serverData: Omit<ServerConfigWithId, 'id' | 'createdAt' | 'updatedAt'>
  ) => saveServer(serverData, editingServer);

  // ================= 订阅操作 =================

  const handleAddSubscription = () => {
    setEditingSub(undefined);
    setIsSubDialogOpen(true);
  };

  const handleEditSubscription = (sub: SubscriptionConfig) => {
    setEditingSub(sub);
    setIsSubDialogOpen(true);
  };

  const handleSaveSubscription = (subData: Omit<SubscriptionConfig, 'id' | 'createdAt'>) =>
    saveSubscription(subData, editingSub);

  return (
    <div className="space-y-6">
      <PageHeader title={t('servers.pageTitle')} description={t('servers.pageDesc')} />

      <Tabs value={activeTab} onValueChange={setTabOverride}>
        {/* Tab 栏：自建节点 + 组网 + 每个订阅（右侧固定「添加订阅」按钮，不在 TabsList 内） */}
        <div className="flex items-center gap-4">
          {/* 可滚动的 Tab 区域，两侧渐变遮罩提示还有更多内容 */}
          <div className="relative min-w-0 flex-1">
            {/* 左侧渐变遮罩 */}
            <div className="pointer-events-none absolute start-0 top-0 z-10 h-full w-8 bg-gradient-to-r from-background to-transparent" />
            {/* 右侧渐变遮罩 */}
            <div className="pointer-events-none absolute end-0 top-0 z-10 h-full w-8 bg-gradient-to-l from-background to-transparent" />

            <div
              ref={scrollContainerRef}
              className="overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] scroll-smooth"
            >
              <TabsList className="inline-flex w-max justify-start">
                {/* 自建节点 Tab（仅代理节点） */}
                <TabsTrigger value="manual" className="flex items-center gap-1.5 whitespace-nowrap">
                  <Server className="h-3.5 w-3.5" />
                  {t('servers.manualNodes')}
                  {manualProxyServers.length > 0 && (
                    <Badge variant="secondary" className="ms-1 h-4 px-1 text-[10px]">
                      {manualProxyServers.length}
                    </Badge>
                  )}
                </TabsTrigger>

                {/* 组网/Endpoint Tab（WireGuard/WARP/Tailscale）——有节点才显示，避免对不用组网的用户造成噪音 */}
                {meshServers.length > 0 && (
                  <TabsTrigger value="mesh" className="flex items-center gap-1.5 whitespace-nowrap">
                    <Network className="h-3.5 w-3.5" />
                    {t('servers.meshNodes')}
                    <Badge variant="secondary" className="ms-1 h-4 px-1 text-[10px]">
                      {meshServers.length}
                    </Badge>
                  </TabsTrigger>
                )}

                {/* 每个订阅一个 Tab */}
                {subscriptions.map((sub) => {
                  const subServers = serversOfGroup(sub.id);
                  const isUpdating = updatingSubId === sub.id;
                  return (
                    <TabsTrigger
                      key={sub.id}
                      value={sub.id}
                      className="flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Rss className="h-3.5 w-3.5" />
                      {sub.name}
                      {subServers.length > 0 && (
                        <Badge variant="secondary" className="ms-1 h-4 px-1 text-[10px]">
                          {isUpdating ? '…' : subServers.length}
                        </Badge>
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>
          </div>

          {/* 添加订阅按钮固定在右侧，不参与滚动 */}
          <div className="flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddSubscription}
              className="flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              {t('servers.addSubscription')}
            </Button>
          </div>
        </div>

        {/* 自建节点内容（仅代理节点） */}
        <TabsContent value="manual">
          <ServerList
            servers={manualProxyServers}
            selectedServerId={selectedServerId ?? undefined}
            onAddServer={handleAddServer}
            onEditServer={handleEditServer}
            onDeleteServer={handleDeleteServer}
            onCloneServer={handleCloneServer}
            onSelectServer={handleSelectServer}
            onImportSuccess={handleImportSuccess}
          />
        </TabsContent>

        {/* 组网节点内容（WireGuard/WARP/Tailscale） */}
        <TabsContent value="mesh">
          <ServerList
            servers={meshServers}
            selectedServerId={selectedServerId ?? undefined}
            onAddServer={handleAddServer}
            onEditServer={handleEditServer}
            onDeleteServer={handleDeleteServer}
            onCloneServer={handleCloneServer}
            onSelectServer={handleSelectServer}
            onImportSuccess={handleImportSuccess}
          />
        </TabsContent>

        {/* 各订阅节点内容 */}
        {subscriptions.map((sub) => {
          const subServers = serversOfGroup(sub.id);
          const isUpdating = updatingSubId === sub.id;
          return (
            <TabsContent key={sub.id} value={sub.id}>
              <div className="space-y-4">
                {/* 订阅信息栏 */}
                <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{sub.name}</p>
                    <p className="text-xs text-muted-foreground truncate max-w-xs" title={sub.url}>
                      {sub.url}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('servers.lastUpdated')}：
                      {sub.lastUpdated
                        ? new Date(sub.lastUpdated).toLocaleString(i18n.language)
                        : t('servers.never')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ms-4 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEditSubscription(sub)}
                      disabled={isUpdating}
                    >
                      {t('servers.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleUpdateSubscriptionServers(sub.id)}
                      disabled={isUpdating}
                      className="flex items-center gap-1.5"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
                      {isUpdating ? t('servers.updating') : t('servers.updateNodes')}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="destructive" disabled={isUpdating}>
                          {t('servers.deleteSub')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('servers.deleteSubTitle')}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t('servers.deleteSubDesc', {
                              name: sub.name,
                              count: subServers.length,
                            })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteSubscription(sub.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {t('common.delete')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>

                {/* 节点列表 */}
                <ServerList
                  servers={subServers}
                  showAddButton={false}
                  selectedServerId={selectedServerId ?? undefined}
                  onAddServer={() => {}}
                  onEditServer={handleEditServer}
                  onDeleteServer={handleDeleteServer}
                  onCloneServer={handleCloneServer}
                  onSelectServer={handleSelectServer}
                  onImportSuccess={handleImportSuccess}
                />
              </div>
            </TabsContent>
          );
        })}
      </Tabs>

      <ServerConfigDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        server={editingServer}
        servers={servers}
        onSave={handleSaveServer}
      />

      <SubscriptionDialog
        open={isSubDialogOpen}
        onOpenChange={setIsSubDialogOpen}
        subscription={editingSub}
        onSave={handleSaveSubscription}
      />
    </div>
  );
}
