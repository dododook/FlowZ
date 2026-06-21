import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { ServerList } from '@/components/settings/server-list';
import { ServerConfigDialog } from '@/components/settings/server-config-dialog';
import { SubscriptionDialog } from '@/components/settings/subscription-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, RefreshCw, Rss, Server, Network, ChevronDown, Link, Zap } from 'lucide-react';
import { isAccountBasedProtocol, isEndpointProtocol } from '../../shared/endpoint-routes';
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
import { useSpeedTest } from '@/components/settings/use-speed-test';
import { ImportUrlDialog } from '@/components/settings/import-url-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type ServerConfigWithId = ServerConfig;

export function ServerPage() {
  const { t, i18n } = useTranslation();
  const config = useAppStore((state) => state.config);
  // 「代理关时也显真实 Tailscale 登录态」触发输入：代理关 + 有组网节点 → 拉 status-only 探针读各 TS 节点登录态。
  const proxyRunning = useAppStore((state) => state.connectionStatus?.proxyCore.running ?? false);
  const setTailscaleStatusProbing = useAppStore((state) => state.setTailscaleStatusProbing);

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
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);

  const servers = config?.servers || [];
  // 页级「全部测速」：跨所有分组测全量（与托盘 testAllServers 同口径）；hook 内部 filter 不可测节点、全不可测则 toast。
  const allSpeed = useSpeedTest(servers);
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

  // 组网 Tab 是否有 Tailscale 节点（探针只对 TS 节点有意义；WG/WARP 不参与登录态）。
  const hasTailscaleMeshNode = meshServers.some((s) => isAccountBasedProtocol(s.protocol));

  // 「代理关时也显真实登录态」：组网 Tab 激活 + 代理关 + 有 TS 节点 → 拉 status-only 探针读各节点真实登录态
  // （驱动「检测中→已登录/需登录」角标，修「代理关 → 无 STATUS → 已登录节点误显需登录」）。代理在跑时主核 STATUS
  // 本就有，不触发。ref 节流：同一「代理态 × 是否有 TS 节点」条件只触发一次，避免切 Tab/重渲染反复拉核（主进程
  // 亦单飞兜底）。代理态翻转（关→开→关）会让指纹变化、允许下次代理关时重新探测。
  // 探针指纹：含组网成员标识（排序后的 server id 拼接），而非仅数量——否则「删一节点同时增一节点」数量不变会漏探。
  const meshFingerprint = useMemo(
    () =>
      meshServers
        .map((s) => s.id)
        .sort()
        .join(','),
    [meshServers]
  );
  const probeFingerprintRef = useRef<string>('');
  const probeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const clearProbeTimeout = (): void => {
      if (probeTimeoutRef.current) {
        clearTimeout(probeTimeoutRef.current);
        probeTimeoutRef.current = null;
      }
    };
    if (activeTab !== 'mesh' || proxyRunning || !hasTailscaleMeshNode) {
      // 代理开/无 TS 节点/非组网 Tab → 不在探测，复位指纹使下次满足条件时可重新触发；并清「检测中」+ 超时兜底。
      probeFingerprintRef.current = '';
      clearProbeTimeout();
      setTailscaleStatusProbing(false);
      return;
    }
    const fingerprint = `mesh:${meshFingerprint}`;
    if (probeFingerprintRef.current === fingerprint) return;
    probeFingerprintRef.current = fingerprint;
    setTailscaleStatusProbing(true);
    // 兜底超时：「invoke resolve 但零 STATUS」路径下（gRPC 无帧/核起即自退），handleTailscaleStatus 永不触发、
    // probing 永卡 true → 角标永久「检测中」（review 中级：渲染端 probing 与主进程探针生命周期脱钩）。主进程探针
    // 12s 拆核，此处 13s 后无条件退出「检测中」。STATUS 已到则该 set 被去重短路、无副作用。
    clearProbeTimeout();
    probeTimeoutRef.current = setTimeout(() => {
      setTailscaleStatusProbing(false);
      probeTimeoutRef.current = null;
    }, 13000);
    void api.server.probeTailscaleStatuses().catch(() => {
      // 探针拉核失败（极少见）→ 退出「检测中」态，角标回落真实/保守显示，不阻断页面。
      clearProbeTimeout();
      setTailscaleStatusProbing(false);
    });
    // 卸载/依赖变更时清未 fire 的 13s 兜底 timeout（否则组件已卸载，timer 仍 fire setTailscaleStatusProbing → 对已卸载组件 set）。
    return () => clearProbeTimeout();
  }, [activeTab, proxyRunning, hasTailscaleMeshNode, meshFingerprint, setTailscaleStatusProbing]);

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
      <PageHeader
        title={t('servers.pageTitle')}
        description={t('servers.pageDesc')}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={allSpeed.handleSpeedTest}
              disabled={allSpeed.isTestingSpeed}
              className="flex items-center gap-1.5"
            >
              <Zap
                className={`h-4 w-4 ${allSpeed.isTestingSpeed ? 'animate-pulse fill-current/20' : ''}`}
              />
              {allSpeed.isTestingSpeed
                ? allSpeed.speedProgress
                  ? `${t('servers.speedTesting')} ${allSpeed.speedProgress.tested}/${allSpeed.speedProgress.total}`
                  : t('servers.speedTesting')
                : t('servers.speedTestAll')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="flex items-center gap-1.5">
                  <Plus className="h-4 w-4" />
                  {t('servers.add')}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleAddServer}>
                  <Plus className="h-4 w-4 me-2" />
                  {t('servers.manualAdd')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsImportDialogOpen(true)}>
                  <Link className="h-4 w-4 me-2" />
                  {t('servers.importFromUrl')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleAddSubscription}>
                  <Rss className="h-4 w-4 me-2" />
                  {t('servers.addSubscription')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <Tabs value={activeTab} onValueChange={setTabOverride}>
        {/* Tab 栏：自建节点 + 组网 + 每个订阅（可横向滚动；添加/导入/添加订阅已上移页头全局动作） */}
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
            onImportClick={() => setIsImportDialogOpen(true)}
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
            onImportClick={() => setIsImportDialogOpen(true)}
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
                  onImportClick={() => setIsImportDialogOpen(true)}
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

      <ImportUrlDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onImportSuccess={handleImportSuccess}
      />
    </div>
  );
}
