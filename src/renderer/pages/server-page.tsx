import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { ServerList } from '@/components/settings/server-list';
import { TailscaleConnectionCard } from '@/components/settings/tailscale-connection-card';
import { MeshAccessEntry } from '@/components/settings/mesh-access-entry';
import { ServerConfigDialog } from '@/components/settings/server-config-dialog';
import { SubscriptionDialog } from '@/components/settings/subscription-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Plus,
  RefreshCw,
  Rss,
  Server,
  Network,
  ChevronDown,
  Zap,
  HardDriveDownload,
} from 'lucide-react';
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
import { LocalImportDialog } from '@/components/settings/local-import-dialog';
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
  const serverPageAction = useAppStore((s) => s.serverPageAction);
  const setServerPageAction = useAppStore((s) => s.setServerPageAction);
  // 「代理关时也显真实 Tailscale 登录态」：代理关时无常驻核 STATUS，用持久缓存 + state 文件兜底（不起核），
  // 真实态由代理开启时主核 STATUS 流校正。取代旧「进页面 spawn 瞬态核探针 + 13s 检测中」过度主动设计。
  const proxyRunning = useAppStore((state) => state.connectionStatus?.proxyCore.running ?? false);
  const setTailscaleLoginState = useAppStore((state) => state.setTailscaleLoginState);

  const {
    updatingSubId,
    deleteServer: handleDeleteServer,
    deleteServers: handleDeleteServers,
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
  const [isLocalImportOpen, setIsLocalImportOpen] = useState(false);

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
  // 组网组全量（含 Tailscale）：供 tab 是否显示、state 兜底 effect 取 TS id、单例卡取 tsNode。
  const meshServersAll = serversOfGroup('mesh');
  // 组网列表只渲染节点制协议（WireGuard/WARP）——Tailscale 抽离为顶部单例卡（批3），不再进列表（设计文档④）。
  const meshServers = meshServersAll.filter((s) => s.protocol?.toLowerCase() !== 'tailscale');
  // 单例卡承载的唯一 Tailscale 节点（单例硬限保证至多一个）；无则卡片渲染「连接」入口态。
  const tailscaleNode = meshServersAll.find((s) => isAccountBasedProtocol(s.protocol));

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
      // 组网 Tab 常显（承载接入入口）→ override 到 mesh 恒有效，不再要求有组网节点。
      tabOverride === 'mesh' ||
      subscriptionIds.has(tabOverride))
      ? tabOverride
      : selectedGroupKey;

  // 组网 Tab 的 Tailscale 节点 id 指纹（稳定 string；避免数组引用每渲染变导致 effect 反复跑）。
  // 取自 meshServersAll（含 TS）——批3 把 TS 抽离列表后仍需对 TS 节点跑 state 兜底，故不能用已剔除 TS 的 meshServers。
  const tsNodeIdsKey = meshServersAll
    .filter((s) => isAccountBasedProtocol(s.protocol))
    .map((s) => s.id)
    .sort()
    .join(',');

  // 代理关时用 state 文件存在性兜底登录态（不起核、毫秒级文件检查），仅补缓存未覆盖的 TS 节点。
  // 取代旧「进 mesh tab spawn 瞬态核探针 + 13s 检测中」——后者切 Tab/重渲染反复拉核、反复闪「检测中」，过度主动。
  // 缓存（STATUS 流真值，由 app-store 启动初值 + 双写持有）优先；缓存未命中且 state 目录存在 → 乐观显「已登录」，
  // 真实态由代理开启时主核 STATUS 流校正（key 失效在那时暴露，无须代理关时着急确认）。
  useEffect(() => {
    if (proxyRunning || !tsNodeIdsKey) return;
    const tsIds = tsNodeIdsKey.split(',');
    let cancelled = false;
    void api.server
      .tailscaleStateExists(tsIds)
      .then((existsMap) => {
        if (cancelled) return;
        const known = useAppStore.getState().tailscaleLoginStates;
        for (const id of tsIds) {
          // 仅对缓存无记录的节点兜底（缓存=STATUS 流真值优先，不被 state 乐观值覆盖）。
          // skipCache：这是纯文件存在性推断的乐观值，不持久化进缓存（缓存只存 STATUS 真值）——
          // 否则 revoked/过期 key 的 state 残留会让乐观 true 固化、长期误显已连接（review #3/#10/#15）。
          if (known[id] === undefined && existsMap[id]) {
            setTailscaleLoginState(id, true, { skipCache: true });
          }
        }
      })
      .catch(() => {
        /* state 检查失败（极少见）不阻断；登录态留待代理开启时 STATUS 校正 */
      });
    return () => {
      cancelled = true;
    };
  }, [proxyRunning, tsNodeIdsKey, setTailscaleLoginState]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // 「接入组网」入口的 Tailscale 按钮（无 TS 节点时）滚动定位到上方单例连接卡。
  const tailscaleCardRef = useRef<HTMLDivElement>(null);

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

  // §H：首页「选择出口设备」导航进来 → 落组网 tab + 一次性指令组网卡自动打开设置弹窗（选出口设备）。
  const [tsAutoOpenSettings, setTsAutoOpenSettings] = useState(false);

  // 消费首页空状态跳服务器页时的意图：自动唤起对应对话框
  useEffect(() => {
    if (serverPageAction === 'add-server') {
      setEditingServer(undefined);
      setIsDialogOpen(true);
      setServerPageAction(null);
    } else if (serverPageAction === 'add-sub') {
      setEditingSub(undefined);
      setIsSubDialogOpen(true);
      setServerPageAction(null);
    } else if (serverPageAction === 'ts-settings') {
      setTabOverride('mesh'); // 兜底落组网 tab（TS=选中出口时 selectedGroupKey 本就 mesh，此处防未选态）
      setTsAutoOpenSettings(true);
      setServerPageAction(null);
    }
  }, [serverPageAction, setServerPageAction]);

  const handleEditServer = (server: ServerConfigWithId) => {
    setEditingServer(server);
    setIsDialogOpen(true);
  };

  const handleSaveServer = async (
    serverData: Omit<ServerConfigWithId, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<void> => {
    // saveServer 现返回保存后的节点（供单例卡连接流程拿 id）；dialog 的 onSave 期望 void，显式丢弃返回值。
    await saveServer(serverData, editingServer);
  };

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
                <DropdownMenuItem onClick={() => setIsLocalImportOpen(true)}>
                  <HardDriveDownload className="h-4 w-4 me-2" />
                  {t('servers.importFromLocal')}
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

                {/* 组网 Tab 常显：批3 起它承载 TS/WG/WARP「接入组网」入口，新用户（无组网节点）也须可达——
                    否则 protocol-options 已移除 tailscale，首个 Tailscale 将无处接入。无节点时不显数量 Badge。 */}
                <TabsTrigger value="mesh" className="flex items-center gap-1.5 whitespace-nowrap">
                  <Network className="h-3.5 w-3.5" />
                  {t('servers.meshNodes')}
                  {meshServersAll.length > 0 && (
                    <Badge variant="secondary" className="ms-1 h-4 px-1 text-[10px]">
                      {meshServersAll.length}
                    </Badge>
                  )}
                </TabsTrigger>

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
            onDeleteServers={handleDeleteServers}
            onCloneServer={handleCloneServer}
            onSelectServer={handleSelectServer}
            onImportClick={() => setIsLocalImportOpen(true)}
          />
        </TabsContent>

        {/* 组网节点内容：顶部 Tailscale 单例连接卡 + 接入组网入口区（批3），下面 WireGuard/WARP 列表 */}
        <TabsContent value="mesh">
          <div className="space-y-4">
            <div ref={tailscaleCardRef}>
              <TailscaleConnectionCard
                tsNode={tailscaleNode}
                proxyRunning={proxyRunning}
                autoOpenSettings={tsAutoOpenSettings}
                onAutoOpenConsumed={() => setTsAutoOpenSettings(false)}
              />
            </div>
            <MeshAccessEntry
              hasTailscale={!!tailscaleNode}
              onTailscaleClick={() =>
                tailscaleCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            />
            <ServerList
              servers={meshServers}
              selectedServerId={selectedServerId ?? undefined}
              onAddServer={handleAddServer}
              onEditServer={handleEditServer}
              onDeleteServer={handleDeleteServer}
              onDeleteServers={handleDeleteServers}
              onCloneServer={handleCloneServer}
              onSelectServer={handleSelectServer}
              onImportClick={() => setIsLocalImportOpen(true)}
            />
          </div>
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
                  onDeleteServers={handleDeleteServers}
                  onCloneServer={handleCloneServer}
                  onSelectServer={handleSelectServer}
                  onImportClick={() => setIsLocalImportOpen(true)}
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
        subscriptionProxyPolicy={config?.subscriptionProxyPolicy}
      />

      <LocalImportDialog
        open={isLocalImportOpen}
        onOpenChange={setIsLocalImportOpen}
        onImportSuccess={handleImportSuccess}
      />
    </div>
  );
}
