import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { ServerList } from '@/components/settings/server-list';
import { MeshAccessEntry } from '@/components/settings/mesh-access-entry';
import { ServerConfigDialog } from '@/components/settings/server-config-dialog';
import { SubscriptionDialog } from '@/components/settings/subscription-dialog';
import {
  Plus,
  RefreshCw,
  Rss,
  ChevronDown,
  Zap,
  HardDriveDownload,
  Edit,
  Trash2,
} from 'lucide-react';
import { formatBytes } from '@/lib/format';
import { isAccountBasedProtocol, isEndpointProtocol } from '../../shared/endpoint-routes';
import { findWarpNode } from '../../shared/warp';
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
import { useServerActions } from './use-server-actions';
import { useSpeedTest } from '@/components/settings/use-speed-test';
import { LocalImportDialog } from '@/components/settings/local-import-dialog';

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
    updatingSubIds,
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
  // 组网组全量（含 Tailscale）：供 tab 是否显示、state 兜底 effect 取 TS id、接入区取 tsNode/warpNode。
  const meshServersAll = serversOfGroup('mesh');
  // 批3b：TS 融入统一节点模型 → 组网列表纳入全部组网节点（含 Tailscale），点卡=选为出口（复用全局 selectedServerId）。
  // 单例硬限保证至多一个 Tailscale；无则接入区渲染「连接」入口态。
  const tailscaleNode = meshServersAll.find((s) => isAccountBasedProtocol(s.protocol));
  // 已注册的 WARP 节点（单例，行为变更用户签核）；有则接入区「已接入·管理」，无则「接入」。
  const warpNode = findWarpNode(meshServersAll);

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

  // 组网 Tab 的 Tailscale 节点 id 指纹（稳定 string；避免数组引用每渲染变导致 effect 反复跑），供代理关时 state 兜底。
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

  const handleSaveSubscription = async (subData: Omit<SubscriptionConfig, 'id' | 'createdAt'>) => {
    const res = await saveSubscription(subData, editingSub);
    // 新增成功：把激活 tab 切到新订阅分组；ok 透传给对话框（失败不关窗、留住用户输入）。
    if (!editingSub && res.ok && res.sub) setTabOverride(res.sub.id);
    return res;
  };

  // 页头摘要计数：共 / 自建 / 组网 / 订阅（订阅=各订阅组节点数之和）。
  const subTotal = subscriptions.reduce((n, sub) => n + serversOfGroup(sub.id).length, 0);

  return (
    <section className="flex flex-col gap-4" data-page="nodes">
      {/* 页头：标题 + 摘要计数 + 全部测速 + 添加下拉 */}
      <div className="page-h">
        <h1>{t('sidebar.server')}</h1>
        <span className="nd-count">
          {t('servers.nodeCountSummary', {
            defaultValue: '共 {{total}} · 自建 {{manual}} · 组网 {{mesh}} · 订阅 {{sub}}',
            total: servers.length,
            manual: manualProxyServers.length,
            mesh: meshServersAll.length,
            sub: subTotal,
          })}
        </span>
        <div className="nd-topbar">
          <button
            type="button"
            className="btn ghost sm"
            onClick={allSpeed.handleSpeedTest}
            disabled={allSpeed.isTestingSpeed}
          >
            <Zap className={allSpeed.isTestingSpeed ? 'animate-pulse fill-current/20' : ''} />
            {allSpeed.isTestingSpeed
              ? allSpeed.speedProgress
                ? `${t('servers.speedTesting')} ${allSpeed.speedProgress.tested}/${allSpeed.speedProgress.total}`
                : t('servers.speedTesting')
              : t('servers.speedTestAll')}
          </button>
          {/* 添加下拉（CSS-only :focus-within 弹出，与工具栏协议/排序下拉同范式） */}
          <div className="nd-dd">
            <button type="button" className="btn flow sm nd-dd-btn">
              <Plus />
              {t('servers.add')}
              <ChevronDown className="nd-chev" />
            </button>
            <div className="nd-menu">
              <button type="button" className="nd-mi" onClick={handleAddServer}>
                <Edit />
                {t('servers.manualAdd')}
              </button>
              <button type="button" className="nd-mi" onClick={() => setIsLocalImportOpen(true)}>
                <HardDriveDownload />
                {t('servers.importFromLocal')}
              </button>
              <button type="button" className="nd-mi" onClick={handleAddSubscription}>
                <Rss />
                {t('servers.addSubscription')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 分组 Tab：自建 / 组网 / 每订阅一 Tab，横向滚动（wheel 竖转横仍生效）。
          添加/导入/添加订阅已上移页头全局动作。 */}
      <div className="nd-tabs-scroll" ref={scrollContainerRef}>
        <div className="tabs">
          {/* 自建节点 Tab（仅代理节点） */}
          <button
            type="button"
            className={activeTab === 'manual' ? 'on' : ''}
            onClick={() => setTabOverride('manual')}
          >
            {t('servers.manualNodes')}
            {manualProxyServers.length > 0 && ` · ${manualProxyServers.length}`}
          </button>

          {/* 组网 Tab 常显：批3 起它承载 TS/WG/WARP「接入组网」入口，新用户（无组网节点）也须可达。 */}
          <button
            type="button"
            className={activeTab === 'mesh' ? 'on' : ''}
            onClick={() => setTabOverride('mesh')}
          >
            {t('servers.meshNodes')}
            {meshServersAll.length > 0 && ` · ${meshServersAll.length}`}
          </button>

          {/* 每个订阅一个 Tab */}
          {subscriptions.map((sub) => {
            const n = serversOfGroup(sub.id).length;
            const isUpdating = updatingSubIds.has(sub.id);
            return (
              <button
                type="button"
                key={sub.id}
                className={activeTab === sub.id ? 'on' : ''}
                onClick={() => setTabOverride(sub.id)}
              >
                {sub.name}
                {n > 0 && ` · ${isUpdating ? '…' : n}`}
              </button>
            );
          })}
        </div>
      </div>

      {/* 自建节点内容（仅代理节点） */}
      {activeTab === 'manual' && (
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
      )}

      {/* 组网节点内容：接入组网入口区（批3b：含 TS 完整登录状态机 + WARP 单例）+ 统一节点列表（含 Tailscale） */}
      {activeTab === 'mesh' && (
        <div className="flex flex-col gap-4">
          <MeshAccessEntry
            tsNode={tailscaleNode}
            warpNode={warpNode}
            proxyRunning={proxyRunning}
            autoOpenSettings={tsAutoOpenSettings}
            onAutoOpenConsumed={() => setTsAutoOpenSettings(false)}
          />
          <ServerList
            servers={meshServersAll}
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
      )}

      {/* 各订阅节点内容 */}
      {subscriptions.map((sub) => {
        if (activeTab !== sub.id) return null;
        const subServers = serversOfGroup(sub.id);
        const isUpdating = updatingSubIds.has(sub.id);
        const ui = sub.userInfo;
        const used = ui ? (ui.upload ?? 0) + (ui.download ?? 0) : 0;
        const total = ui?.total;
        const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
        return (
          <div key={sub.id} className="flex flex-col gap-4">
            {/* 订阅信息栏 */}
            <div className="nd-subbar">
              <div className="nd-subbar-main">
                <div className="nd-subbar-nm">
                  {sub.name}
                  {sub.autoUpdate && <span className="nd-badge ok">{t('sub.autoUpdate')}</span>}
                </div>
                <div className="nd-subbar-meta">
                  <span className="nd-subbar-url mono" title={sub.url}>
                    {sub.url}
                  </span>
                  <span className="sb-sep">·</span>
                  <span>
                    {t('servers.lastUpdated')}{' '}
                    {sub.lastUpdated
                      ? new Date(sub.lastUpdated).toLocaleString(i18n.language)
                      : t('servers.never')}
                  </span>
                  {ui && total !== undefined && (
                    <>
                      <span className="sb-sep">·</span>
                      <span className="nd-subbar-usage">
                        <span className={`nd-usage${pct >= 85 ? ' warn' : ''}`}>
                          <i style={{ width: `${pct}%` }} />
                        </span>
                        <span className="mono tnum">
                          {formatBytes(used)} / {formatBytes(total)}
                        </span>
                      </span>
                    </>
                  )}
                  {ui?.expire && (
                    <>
                      <span className="sb-sep">·</span>
                      <span>
                        {t('servers.expireAt', {
                          defaultValue: '到期 {{date}}',
                          date: new Date(ui.expire * 1000).toLocaleDateString(i18n.language),
                        })}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="nd-subbar-acts">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => handleUpdateSubscriptionServers(sub.id)}
                  disabled={isUpdating}
                >
                  <RefreshCw className={isUpdating ? 'animate-spin' : ''} />
                  {isUpdating ? t('servers.updating') : t('servers.updateNodes')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => handleEditSubscription(sub)}
                  disabled={isUpdating}
                >
                  <Edit />
                  {t('servers.edit')}
                </button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      className="btn ghost sm icon"
                      title={t('servers.deleteSub')}
                      disabled={isUpdating}
                    >
                      <Trash2 />
                    </button>
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
        );
      })}

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
    </section>
  );
}
