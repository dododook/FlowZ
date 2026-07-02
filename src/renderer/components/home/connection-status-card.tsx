import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
import { SpeedBadge } from '@/components/settings/speed-badge';
import { useSpeedTest } from '@/components/settings/use-speed-test';
import { useAppStore } from '@/store/app-store';
import { useNodeSortStore } from '@/store/use-node-sort-store';
import { Plus, Rss, AlertTriangle, Zap, ArrowDownNarrowWide } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { deriveConnectionStatus } from './connection-status';
import { isDirectSelection } from '@shared/direct-selection';
import { TsExitWarning } from './ts-exit-warning';

export function ConnectionStatusCard() {
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const config = useAppStore((state) => state.config);
  const proxyError = useAppStore((state) => state.proxyError);
  const proxyBusy = useAppStore((state) => state.proxyBusy);
  const proxyPhase = useAppStore((state) => state.proxyPhase);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const setServerPageAction = useAppStore((s) => s.setServerPageAction);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  // 仅订阅当前选中节点的延迟（折叠态徽标用），不订阅整张 latencyMap——否则测速期间每个节点结果广播都重渲整张卡。
  const selectedLatency = useAppStore((state) =>
    selectedServerId ? state.latencyMap[selectedServerId] : undefined
  );
  const sortByLatency = useNodeSortStore((state) => state.sortByLatency);
  const toggleSortByLatency = useNodeSortStore((state) => state.toggleSortByLatency);
  // 全局直连哨兵（#73）：selectedServerId='__direct__' 时无真实节点，但不是「未选择」——需走当前选择分支显示「直连」。
  const isDirect = isDirectSelection(selectedServerId);
  const { t } = useTranslation();
  // 首页就地全量测速：复用服务器页同一 hook（已封 isSpeedTestable 过滤 + 三态 + toast），结果经全局 latencyMap
  // 自动回流下拉延迟徽标。全量而非按组——测速层无按组原语、testAllServers 单飞为多入口复用全量设计（见设计文档）。
  const { isTestingSpeed, speedProgress, handleSpeedTest } = useSpeedTest(servers);

  const handleServerChange = async (serverId: string) => {
    if (!config) return;

    try {
      const updatedConfig = {
        ...config,
        selectedServerId: serverId,
      };

      await saveConfig(updatedConfig);
      toast.success(t('home.serverSwitched'));
    } catch (error) {
      toast.error(t('home.switchFailed'), {
        description: error instanceof Error ? error.message : t('home.switchError'),
      });
    }
  };

  const statusInfo = deriveConnectionStatus(
    {
      proxyError,
      connectionStatus,
      configProxyModeType: config?.proxyModeType,
      proxyBusy,
      proxyPhase,
    },
    t
  );

  // 节点列表头部控件（测速 + 延迟排序开关）：「已选节点」与「有节点未选中」两分支共用，
  // 避免「显延迟却无处就地触发测速/排序」的不一致。无可测节点（如全局直连且 0 节点）整体不渲染。
  const speedTestButton = (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
      disabled={isTestingSpeed}
      onClick={handleSpeedTest}
    >
      <Zap className={`h-3.5 w-3.5 ${isTestingSpeed ? 'animate-pulse' : ''}`} />
      {isTestingSpeed
        ? speedProgress
          ? `${speedProgress.tested}/${speedProgress.total}`
          : t('servers.speedTesting')
        : t('servers.speedTestGroup')}
    </Button>
  );
  // 延迟排序开关：亮（bg-primary/10 + text-primary）=按延迟，灰（muted）=config 原序。只管下拉 + 托盘列表顺序。
  // 图标 + 「延迟」文字（复用 servers.sortLatency，与「测速」按钮同款布局）——纯图标辨识度太低。
  const sortToggleButton = (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={sortByLatency}
      title={t('home.sortByLatency')}
      className={`h-7 shrink-0 gap-1.5 px-2 text-xs ${
        sortByLatency
          ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
          : 'text-muted-foreground'
      }`}
      onClick={toggleSortByLatency}
    >
      <ArrowDownNarrowWide className="h-3.5 w-3.5" />
      {t('servers.sortLatency')}
    </Button>
  );
  const nodeListControls =
    servers.length > 0 ? (
      <div className="flex items-center gap-1">
        {sortToggleButton}
        {speedTestButton}
      </div>
    ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('home.connectionStatus')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('home.status')}</span>
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
        </div>

        {/* 服务器选择区域 */}
        {servers.length === 0 && !isDirect ? (
          <div className="space-y-3">
            <div className="p-4 border border-dashed border-muted-foreground/25 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-3">{t('home.noServerConfig')}</p>
              <div className="flex justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setServerPageAction('add-server');
                    setCurrentView('server');
                  }}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  {t('home.addServer')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setServerPageAction('add-sub');
                    setCurrentView('server');
                  }}
                  className="flex items-center gap-2"
                >
                  <Rss className="h-4 w-4" />
                  {t('home.addSubscription')}
                </Button>
              </div>
            </div>
          </div>
        ) : !selectedServer && !isDirect ? (
          <div className="space-y-3">
            <div className="p-4 border border-warning/50 bg-warning/10 rounded-lg">
              <div className="mb-3 flex items-start justify-between gap-2">
                <p className="text-sm text-warning flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t('home.selectServerHint')}
                </p>
                {nodeListControls}
              </div>
              <Select onValueChange={handleServerChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('home.selectServer')} />
                </SelectTrigger>
                <SelectContent>
                  <ServerSelectGroups
                    servers={servers}
                    includeDirect
                    showLatency
                    enableLatencySort
                  />
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 服务器切换 */}
            <div className="space-y-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('home.currentServer')}</span>
                  {nodeListControls}
                </div>
                <Select value={selectedServerId ?? undefined} onValueChange={handleServerChange}>
                  {/* SelectValue(首个 span) 给 min-w-0/flex-1 → 长节点名 truncate 不挤压徽标/chevron（trigger 自带 [&>span]:truncate） */}
                  <SelectTrigger className="w-full [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1">
                    <SelectValue placeholder={t('home.selectServer')} />
                    {/* 折叠态也显当前节点延迟（与下拉徽标同源）：ms-auto 推到右侧、chevron 前 */}
                    {selectedServer && selectedLatency !== undefined ? (
                      <span className="ms-auto shrink-0 ps-2">
                        <SpeedBadge
                          server={selectedServer}
                          latencyMap={{ [selectedServer.id]: selectedLatency }}
                        />
                      </span>
                    ) : null}
                  </SelectTrigger>
                  <SelectContent>
                    <ServerSelectGroups
                      servers={servers}
                      selectedId={selectedServerId ?? undefined}
                      includeDirect
                      showLatency
                      enableLatencySort
                    />
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* §H：选中 TS 当出口但出不了公网（未选出口设备 / 设备离线）→ 出口下拉正下方行内 warning 注脚。none→null。 */}
            <TsExitWarning />

            {/* 全局直连：未命中规则的流量直连、仅按规则走代理（与「直连模式」不同，规则仍生效） */}
            {isDirect ? (
              <div className="space-y-2 pt-2 border-t">
                <p className="text-xs text-muted-foreground">
                  {t('home.directGlobalHint', '全局直连：未命中规则的流量直连，仅按规则走代理')}
                </p>
              </div>
            ) : selectedServer ? (
              <div className="space-y-2 pt-2 border-t">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('home.protocol')}</span>
                  <Badge variant="outline" className="text-xs">
                    {selectedServer.protocol}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('home.address')}</span>
                  <span
                    className="text-sm font-medium truncate max-w-[150px]"
                    title={selectedServer.address}
                  >
                    {selectedServer.address}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('home.port')}</span>
                  <span className="text-sm font-medium">{selectedServer.port}</span>
                </div>
              </div>
            ) : null}
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground">{statusInfo.description}</p>
        </div>

        {/* 仅本地代理特殊提示区 */}
        {(statusInfo as any).isManualNotice && (
          <div className="p-3 bg-info/10 border border-info/20 rounded-lg space-y-1">
            <p className="text-sm font-medium text-info flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-info opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-info"></span>
              </span>
              {t('home.manualModeTip')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
