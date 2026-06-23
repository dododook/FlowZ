import { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Trash2,
  Server,
  LayoutGrid,
  List,
  Search,
  ArrowUpDown,
  CheckSquare,
  Square,
  Copy,
  Zap,
  Link,
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
  // 「检测中」中性态输入：代理关 + status-only 探针在飞 + 该节点 loggedIn 尚未知 → 显「检测中」（不误报需登录）。
  const tailscaleStatusProbing = useAppStore((state) => state.tailscaleStatusProbing);
  const proxyRunning = useAppStore((state) => state.connectionStatus?.proxyCore.running ?? false);
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

  return (
    <div className="space-y-4">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">{t('servers.serverList')}</h3>
          <p className="text-sm text-muted-foreground">{t('servers.serverListDesc')}</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* 视图切换 */}
          <div className="flex rounded-md border overflow-hidden">
            <Button
              variant={viewMode === 'card' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 rounded-none border-0"
              title={t('servers.viewCard')}
              onClick={() => setViewMode('card')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 rounded-none border-0 border-l"
              title={t('servers.viewList')}
              onClick={() => setViewMode('list')}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>

          <Button
            variant="outline"
            className="flex items-center gap-2"
            onClick={handleSpeedTest}
            disabled={isTestingSpeed}
          >
            <Zap className={`h-4 w-4 ${isTestingSpeed ? 'animate-pulse fill-current/20' : ''}`} />
            {isTestingSpeed
              ? speedProgress
                ? `${t('servers.speedTesting')} ${speedProgress.tested}/${speedProgress.total}`
                : t('servers.speedTesting')
              : t('servers.speedTestGroup')}
          </Button>

          {/* 批量选择按钮 */}
          {showAddButton && (
            <Button
              variant={isSelecting ? 'secondary' : 'outline'}
              size="sm"
              className="flex items-center gap-1"
              onClick={() => {
                setIsSelecting(!isSelecting);
                setSelectedIds(new Set());
              }}
            >
              <CheckSquare className="h-4 w-4" />
              {isSelecting ? t('common.cancel') : t('servers.multiSelect')}
            </Button>
          )}
        </div>
      </div>

      {/* 搜索 + 过滤 + 排序栏 */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            className="ps-8 h-9"
            placeholder={t('servers.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <Select value={filterProtocol} onValueChange={setFilterProtocol}>
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue placeholder={t('servers.protocol')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('servers.allProtocols')}</SelectItem>
            {availableProtocols.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 flex items-center gap-1">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {t('servers.sort')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(
              [
                ['name', t('servers.sortName')],
                ['protocol', t('servers.sortProtocol')],
                ['latency', t('servers.sortLatency')],
                ['address', t('servers.sortAddress')],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <DropdownMenuItem
                key={key}
                onClick={() => {
                  if (sortKey === key) {
                    setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
                  } else {
                    setSortKey(key);
                    setSortOrder('asc');
                  }
                }}
              >
                {label} {sortKey === key ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setSortKey('name');
                setSortOrder('asc');
              }}
            >
              {t('servers.resetSort')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 批量操作栏 */}
      {isSelecting && (
        <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/60 border">
          <div className="flex items-center gap-3">
            <button
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={toggleSelectAll}
            >
              {selectedIds.size === filteredServers.length && filteredServers.length > 0 ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              {t('servers.selectAll')}
            </button>
            <span className="text-sm text-muted-foreground">
              {t('servers.selectedCount', {
                count: selectedIds.size,
                total: filteredServers.length,
              })}
            </span>
          </div>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex items-center gap-1"
                onClick={handleBatchCopy}
              >
                <Copy className="h-3.5 w-3.5" />
                {t('servers.batchCopyCount', { count: selectedIds.size })}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex items-center gap-1"
                    disabled={deletableSelected.length === 0}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('servers.deleteCount', { count: deletableSelected.length })}
                  </Button>
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
            </div>
          )}
        </div>
      )}

      {/* 节点列表 */}
      {filteredServers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {servers.length === 0
                ? showAddButton
                  ? t('servers.noServers')
                  : t('servers.noNodes')
                : t('servers.noMatchingNodes')}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 text-center">
              {servers.length === 0
                ? showAddButton
                  ? t('servers.noServersDesc')
                  : t('servers.noSubNodesDesc')
                : t('servers.noMatchingDesc')}
            </p>
            {servers.length === 0 && showAddButton && (
              <div className="flex gap-2">
                <Button onClick={onAddServer} className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t('servers.manualAdd')}
                </Button>
                <Button
                  variant="outline"
                  onClick={onImportClick}
                  className="flex items-center gap-2"
                >
                  <Link className="h-4 w-4" />
                  {t('servers.importFromUrl')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : viewMode === 'card' ? (
        /* ========= 卡片视图 ========= */
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
              tailscaleStatusProbing={tailscaleStatusProbing}
              proxyRunning={proxyRunning}
              shadowedCidrs={shadowedCidrs}
              onSelectServer={onSelectServer}
              onToggleSelect={toggleSelect}
              actions={actions}
            />
          ))}
        </div>
      ) : (
        /* ========= 列表视图 ========= */
        <div className="rounded-md border divide-y">
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
              tailscaleStatusProbing={tailscaleStatusProbing}
              proxyRunning={proxyRunning}
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
