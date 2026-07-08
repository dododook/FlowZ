import { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
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
import {
  LayoutGrid,
  List,
  Search,
  Filter,
  ArrowUpDown,
  ChevronDown,
  Check,
  Zap,
  CheckSquare,
  Copy,
  Trash2,
  Plus,
  HardDriveDownload,
} from 'lucide-react';
import { generateShareUrl } from '@/bridge/api-wrapper';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import {
  meshShadowedCidrs,
  meshForceRoutedServers,
  collectRuleTargetedServerIds,
} from '../../../shared/endpoint-routes';
import { ServerCard } from './server-card';
import { ServerRow } from './server-row';
import {
  hasShareLink,
  type ServerConfigWithId,
  type ViewMode,
  type SortKey,
  type ServerActionsContext,
} from './server-list-helpers';
import { useSpeedTest } from './use-speed-test';
import { useServerFilter } from './use-server-filter';

interface ServerListProps {
  servers: ServerConfigWithId[];
  selectedServerId?: string;
  showAddButton?: boolean;
  onAddServer: () => void;
  onEditServer: (server: ServerConfigWithId) => void;
  onDeleteServer: (serverId: string) => void;
  onDeleteServers?: (serverIds: string[]) => void;
  onCloneServer?: (server: ServerConfigWithId) => void;
  onSelectServer: (serverId: string) => void;
  onImportClick?: () => void;
}

export function ServerList({
  servers,
  selectedServerId,
  showAddButton = true,
  onAddServer,
  onEditServer,
  onDeleteServer,
  onDeleteServers,
  onCloneServer,
  onSelectServer,
  onImportClick,
}: ServerListProps) {
  const latencyMap = useAppStore((state) => state.latencyMap);
  // 启动前配置校验 gate 剔除的非法节点：列表标灰 + tooltip（不禁用点击，用户仍可选/编辑/删除）。
  const invalidNodes = useAppStore((state) => state.invalidNodes);
  // Tailscale 节点真实登录态（serverId → loggedIn）：驱动「需登录」角标，交互登录成功后角标自动消失。
  const tailscaleLoginStates = useAppStore((state) => state.tailscaleLoginStates);
  const tailscaleAuthUrls = useAppStore((state) => state.tailscaleAuthUrls);
  // shadow 角标的 engaged gate 输入（与 route-builder 同口径）：仅出网且未 engaged 节点不参与「首声明者占段」。
  const customRules = useAppStore((state) => state.config?.customRules);
  const appRules = useAppStore((state) => state.config?.appRules);
  const { t } = useTranslation();

  // 测速态 + handler（hook 下沉，纯逻辑）
  const {
    isTestingSpeed,
    speedProgress,
    testingServerIds,
    handleSpeedTest,
    handleSingleSpeedTest,
  } = useSpeedTest(servers);

  // 搜索 / 过滤 / 排序态 + 派生列表（hook 下沉，纯逻辑）
  const {
    searchQuery,
    setSearchQuery,
    filterProtocol,
    setFilterProtocol,
    sortKey,
    setSortKey,
    sortOrder,
    setSortOrder,
    availableProtocols,
    filteredServers,
  } = useServerFilter(servers, latencyMap);

  // 组网同网段「被覆盖」检测（首声明者占有，与 route-builder 同一不变量）：列表角标提醒用，零布局破坏。
  // 基准与 route-builder 块 0c 同 gate：仅「本轮实际发射 force-route」的节点参与占段，否则仅出网且未 engaged 的
  // 节点会先占段、把真正生效的 ON 节点误标「被覆盖」（方向相反的误报）。
  const shadowedCidrs = useMemo(
    () =>
      meshShadowedCidrs(
        meshForceRoutedServers(
          servers,
          selectedServerId,
          collectRuleTargetedServerIds([...(customRules ?? []), ...(appRules ?? [])])
        )
      ),
    [servers, selectedServerId, customRules, appRules]
  );

  // 记住用户的视图偏好
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('flowz_server_view_mode');
    return saved === 'card' || saved === 'list' ? saved : 'card';
  });

  useEffect(() => {
    localStorage.setItem('flowz_server_view_mode', viewMode);
  }, [viewMode]);

  // 批量选择
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);

  // 选中项里「可删除」的（排除订阅节点——删了下次同步会回来，维持不可批删）。
  // 批量删除按钮的计数 / disabled / 实际删除集合统一以它为准（计数==实际删除）。
  const deletableSelected = Array.from(selectedIds).filter(
    (id) => !servers.find((s) => s.id === id)?.subscriptionId
  );

  const handleDelete = (serverId: string) => {
    onDeleteServer(serverId);
    setSelectedIds((prev) => {
      const s = new Set(prev);
      s.delete(serverId);
      return s;
    });
  };

  const handleBatchDelete = () => {
    // 只删可删项；优先走一次性批量回调（onDeleteServers），避免逐个 onDeleteServer 并发竞态致只删 1 个。
    if (deletableSelected.length === 0) return;
    if (onDeleteServers) {
      onDeleteServers(deletableSelected);
    } else {
      deletableSelected.forEach((id) => onDeleteServer(id));
    }
    setSelectedIds(new Set());
    setIsSelecting(false);
  };

  const handleCopyShareUrl = async (server: ServerConfigWithId, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await generateShareUrl(server);
      if (response.success && response.data) {
        await navigator.clipboard.writeText(response.data);
        toast.success(t('servers.shareUrlCopied'));
      } else {
        toast.error(response.error || t('servers.shareUrlFail'));
      }
    } catch {
      toast.error(t('common.copyFail'));
    }
  };

  const handleBatchCopy = async () => {
    try {
      // 无分享链接的协议（ssh/wireguard/tailscale）批量复制时排除（避免 per-server 抛错刷屏 toast）
      const selectedServersList = servers.filter(
        (s) => selectedIds.has(s.id) && hasShareLink(s.protocol)
      );
      const urls: string[] = [];
      let successCount = 0;

      for (const server of selectedServersList) {
        const response = await generateShareUrl(server);
        if (response.success && response.data) {
          urls.push(response.data);
          successCount++;
        }
      }

      if (urls.length > 0) {
        await navigator.clipboard.writeText(urls.join('\n'));
        toast.success(t('servers.batchCopySuccess', { count: successCount }));
      } else {
        toast.error(t('servers.shareUrlFail'));
      }
    } catch (error) {
      toast.error(
        t('servers.batchCopyFail', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      setIsSelecting(false);
      setSelectedIds(new Set());
    }
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) {
        s.delete(id);
      } else {
        s.add(id);
      }
      return s;
    });
  };

  // 列表视图行选择（与 toggleSelect 同一 toggle 语义；行 onClick 自身不需 stopPropagation）
  const toggleSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) {
        s.delete(id);
      } else {
        s.add(id);
      }
      return s;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredServers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredServers.map((s) => s.id)));
    }
  };

  // 操作按钮组（ServerCard/ServerRow 透传给 ServerActions）的运行期上下文
  const actions: ServerActionsContext = {
    testingServerIds,
    isTestingSpeed,
    latencyMap,
    onSingleSpeedTest: handleSingleSpeedTest,
    onCopyShareUrl: handleCopyShareUrl,
    onCloneServer,
    onEditServer,
    onDelete: handleDelete,
  };

  // 协议过滤 / 排序下拉的展示辅助（纯派生，无状态）
  const protoCount = (value: string) =>
    servers.filter((s) => s.protocol.toLowerCase() === value).length;
  const sortLabel: Record<SortKey, string> = {
    name: t('servers.sortName'),
    protocol: t('servers.sortProtocol'),
    latency: t('servers.sortLatency'),
    address: t('servers.sortAddress'),
  };
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortOrder('asc');
    }
  };
  const allSelected = selectedIds.size === filteredServers.length && filteredServers.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏：双视图切换 + 搜索 + 协议过滤 + 排序 + 本组测速 + 多选 */}
      <div className="nd-toolbar">
        <div className="seg2 nd-view">
          <button
            type="button"
            className={viewMode === 'card' ? 'on' : ''}
            title={t('servers.viewCard')}
            onClick={() => setViewMode('card')}
          >
            <LayoutGrid />
          </button>
          <button
            type="button"
            className={viewMode === 'list' ? 'on' : ''}
            title={t('servers.viewList')}
            onClick={() => setViewMode('list')}
          >
            <List />
          </button>
        </div>

        <label className="nd-search">
          <Search />
          <input
            type="text"
            placeholder={t('servers.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>

        {/* 协议过滤（CSS-only :focus-within 弹出） */}
        <div className="nd-dd">
          <button type="button" className="btn ghost sm nd-dd-btn">
            <Filter />
            {t('servers.protocol')}
            <ChevronDown className="nd-chev" />
          </button>
          <div className="nd-menu">
            <button
              type="button"
              className={`nd-mi${filterProtocol === 'all' ? ' on' : ''}`}
              onClick={() => setFilterProtocol('all')}
            >
              {t('servers.allProtocols')}
              {filterProtocol === 'all' && <Check className="nd-mi-ck" />}
            </button>
            {availableProtocols.map((p) => (
              <button
                type="button"
                key={p.value}
                className={`nd-mi${filterProtocol === p.value ? ' on' : ''}`}
                onClick={() => setFilterProtocol(p.value)}
              >
                {p.label}
                {filterProtocol === p.value ? (
                  <Check className="nd-mi-ck" />
                ) : (
                  <span className="nd-mi-r tnum">{protoCount(p.value)}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* 排序（CSS-only :focus-within 弹出） */}
        <div className="nd-dd">
          {/* 非默认排序（名称升序以外）→ .on 激活态（复用 .btn.ghost.on 边框亮起）；方向角标常显，合上也可辨识。 */}
          <button
            type="button"
            className={`btn ghost sm nd-dd-btn${sortKey !== 'name' || sortOrder !== 'asc' ? ' on' : ''}`}
          >
            <ArrowUpDown />
            {sortLabel[sortKey]}
            <span className="nd-dd-dir">{sortOrder === 'asc' ? '↑' : '↓'}</span>
            <ChevronDown className="nd-chev" />
          </button>
          <div className="nd-menu">
            {(['name', 'protocol', 'latency', 'address'] as SortKey[]).map((key) => (
              <button
                type="button"
                key={key}
                className={`nd-mi${sortKey === key ? ' on' : ''}`}
                onClick={() => toggleSort(key)}
              >
                {sortLabel[key]}
                {sortKey === key && (
                  <span className="nd-mi-r">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="nd-mi"
              onClick={() => {
                setSortKey('name');
                setSortOrder('asc');
              }}
            >
              {t('servers.resetSort')}
            </button>
          </div>
        </div>

        {/* 本组测速 */}
        <button
          type="button"
          className="btn ghost sm"
          onClick={handleSpeedTest}
          disabled={isTestingSpeed}
        >
          <Zap className={isTestingSpeed ? 'animate-pulse fill-current/20' : ''} />
          {isTestingSpeed
            ? speedProgress
              ? `${t('servers.speedTesting')} ${speedProgress.tested}/${speedProgress.total}`
              : t('servers.speedTesting')
            : t('servers.speedTestGroup')}
        </button>

        {/* 多选 */}
        {showAddButton && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setIsSelecting(!isSelecting);
              setSelectedIds(new Set());
            }}
          >
            <CheckSquare />
            {isSelecting ? t('common.cancel') : t('servers.multiSelect')}
          </button>
        )}
      </div>

      {/* 批量操作栏 */}
      {isSelecting && (
        <div className="nd-batch">
          <label className={`nd-chk${allSelected ? ' on' : ''}`} onClick={toggleSelectAll} />
          <span className="nd-batch-n">
            {t('servers.selectedCount', {
              count: selectedIds.size,
              total: filteredServers.length,
            })}
          </span>
          <div className="nd-batch-acts">
            <button type="button" className="btn ghost sm" onClick={toggleSelectAll}>
              {t('servers.selectAll')}
            </button>
            {selectedIds.size > 0 && (
              <button type="button" className="btn ghost sm" onClick={handleBatchCopy}>
                <Copy />
                {t('servers.batchCopyCount', { count: selectedIds.size })}
              </button>
            )}
            {selectedIds.size > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className="btn danger sm"
                    disabled={deletableSelected.length === 0}
                  >
                    <Trash2 />
                    {t('servers.deleteCount', { count: deletableSelected.length })}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('servers.batchDelete')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('servers.batchDeleteDesc', { count: deletableSelected.length })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleBatchDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t('servers.confirmDelete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setIsSelecting(false);
                setSelectedIds(new Set());
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* 节点列表 */}
      {filteredServers.length === 0 ? (
        <div className="stub">
          <b>
            {servers.length === 0
              ? showAddButton
                ? t('servers.noServers')
                : t('servers.noNodes')
              : t('servers.noMatchingNodes')}
          </b>
          {servers.length === 0
            ? showAddButton
              ? t('servers.noServersDesc')
              : t('servers.noSubNodesDesc')
            : t('servers.noMatchingDesc')}
          {servers.length === 0 && showAddButton && (
            <div className="nd-stub-cta flex justify-center gap-2">
              <button type="button" className="btn flow sm" onClick={onAddServer}>
                <Plus />
                {t('servers.manualAdd')}
              </button>
              <button type="button" className="btn ghost sm" onClick={onImportClick}>
                <HardDriveDownload />
                {t('servers.importFromLocal')}
              </button>
            </div>
          )}
        </div>
      ) : viewMode === 'card' ? (
        /* ========= 卡片视图 ========= */
        <div className="nd-grid">
          {filteredServers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              selectedServerId={selectedServerId}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              invalidNodes={invalidNodes}
              tailscaleLoginStates={tailscaleLoginStates}
              tailscaleAuthUrls={tailscaleAuthUrls}
              shadowedCidrs={shadowedCidrs}
              onSelectServer={onSelectServer}
              onToggleSelect={toggleSelect}
              actions={actions}
            />
          ))}
        </div>
      ) : (
        /* ========= 列表视图 ========= */
        <div className="nd-rows">
          {filteredServers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              selectedServerId={selectedServerId}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              invalidNodes={invalidNodes}
              tailscaleLoginStates={tailscaleLoginStates}
              tailscaleAuthUrls={tailscaleAuthUrls}
              shadowedCidrs={shadowedCidrs}
              onSelectServer={onSelectServer}
              onToggleSelectId={toggleSelectId}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
