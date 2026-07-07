import { useState, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { NodePicker, type NodePickerGroup, type NodePickerItem } from '@/components/ui/node-picker';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAppStore } from '@/store/app-store';
import { useNodeSortStore } from '@/store/use-node-sort-store';
import { useSpeedTest } from '@/components/settings/use-speed-test';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownNarrowWide,
  Loader2,
  Play,
  Plus,
  Rss,
  Square,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { ProxyMode, ProxyModeType, ServerConfig } from '@/bridge/types';
import { cn } from '@/lib/utils';
import { deriveConnectionStatus } from './connection-status';
import { deriveConnectButtonState } from './connect-button-state';
import { TsExitWarning } from './ts-exit-warning';
import { DIRECT_SERVER_ID, isDirectSelection } from '@shared/direct-selection';
import { groupServersBySubscription } from '@shared/server-grouping';
import { sortServersByLatency } from '@shared/server-latency-sort';
import { isServerComplete } from '@shared/server-completeness';
import { applyFakeIpTunEntry } from '@shared/fakeip-tun-entry';
import {
  isEndpointProtocol,
  isMeshNodeUnroutable,
  isSpeedTestable,
  meshNodeCarriesFullTunnel,
} from '@shared/endpoint-routes';

/** 节点显示地址（触发器副文本 + 搜索）：自定义/无地址节点回退空。 */
function nodeAddress(s: ServerConfig): string | undefined {
  if (!s.address) return undefined;
  return s.port ? `${s.address}:${s.port}` : s.address;
}

/**
 * 出口节点选择（`.npick`）—— 独立子组件隔离 latencyMap / sortByLatency 订阅，
 * 使测速期间的延迟广播只重渲本下拉、不牵动整卡（沿用原 ConnectionStatusCard 的 F2 隔离意图）。
 */
function ExitNodePicker({
  servers,
  selectedServerId,
  onSelect,
}: {
  servers: ServerConfig[];
  selectedServerId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const subscriptions = useAppStore((s) => s.config?.subscriptions || []);
  const latencyMap = useAppStore((s) => s.latencyMap);
  const sortByLatency = useNodeSortStore((s) => s.sortByLatency);

  const groups = groupServersBySubscription(servers, subscriptions);
  // 多来源才显分组头（单一来源平铺，与 ServerSelectGroups 口径一致）。
  const pickerGroups: NodePickerGroup[] =
    groups.length > 1
      ? groups.map((g) => ({
          id: g.id,
          label: g.isMesh
            ? t('servers.meshNodes', '组网')
            : g.isManual
              ? t('servers.manualNodes', '自建节点')
              : g.name,
        }))
      : [];
  const sortNodes = (arr: ServerConfig[]): ServerConfig[] =>
    sortByLatency ? sortServersByLatency(arr, (id) => latencyMap[id]) : arr;

  const items: NodePickerItem[] = [
    // 直连哨兵（#73）恒置顶，无 groupId → 归无分组桶。
    { id: DIRECT_SERVER_ID, name: t('servers.directGlobal', '直连'), role: 'direct' },
    ...groups.flatMap((g) =>
      sortNodes(g.servers).map<NodePickerItem>((s) => ({
        id: s.id,
        name: s.name,
        protocol: s.protocol,
        address: nodeAddress(s),
        latency: latencyMap[s.id],
        latencyNA: !isSpeedTestable(s),
        groupId: pickerGroups.length ? g.id : undefined,
        dotTone: 'ok',
      }))
    ),
  ];

  return (
    <NodePicker
      items={items}
      groups={pickerGroups}
      value={selectedServerId}
      onSelect={onSelect}
      size="lg"
      showAddress
      className="min-w-0 flex-1"
      placeholder={t('home.selectServer')}
      searchPlaceholder={t('common.search', '搜索')}
      ariaLabel={t('home.exitNode', '出口节点')}
    />
  );
}

/**
 * 首页连接控制卡：合并原「连接状态卡 + 代理控制卡」——出口节点（`.npick` 一步选）+ 连接圆钮三态
 * （未连 teal ▶ / 已连 红 ‖ / 错误 橘 !）+ 接管方式 seg（系统/TUN/手动，切换时若已连弹重连确认）+ 分流策略
 * seg（智能/全局/直连）。功能全保留：空态引导、就地测速/延迟排序、TS 出口警示、选中详情、组网回退提示、
 * manual 提示、置灰原因。接管方式的 FakeIP-TUN 待纠正 / native gate 引导逻辑与原卡逐字迁移。
 */
export function ConnectionControlCard() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const proxyError = useAppStore((s) => s.proxyError);
  const proxyBusy = useAppStore((s) => s.proxyBusy);
  const proxyPhase = useAppStore((s) => s.proxyPhase);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const startProxy = useAppStore((s) => s.startProxy);
  const stopProxy = useAppStore((s) => s.stopProxy);
  const updateProxyMode = useAppStore((s) => s.updateProxyMode);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setServerPageAction = useAppStore((s) => s.setServerPageAction);
  const sortByLatency = useNodeSortStore((s) => s.sortByLatency);
  const toggleSortByLatency = useNodeSortStore((s) => s.toggleSortByLatency);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingModeType, setPendingModeType] = useState<ProxyModeType | null>(null);
  // updateProxyMode 不写全局 busy → 本地 routingBusy 提供分流切换反馈（沿用原卡）。
  const [routingBusy, setRoutingBusy] = useState(false);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const isDirect = isDirectSelection(selectedServerId);

  // 就地全量测速（复用服务器页 hook：isSpeedTestable 过滤 + 三态 + toast，结果经全局 latencyMap 回流下拉）。
  const { isTestingSpeed, speedProgress, handleSpeedTest } = useSpeedTest(servers);

  // config 是接管方式持久化真值；优先它，避免启动时 connectionStatus 未刷新而默认 systemProxy 盖掉已存的 tun。
  const proxyModeType = config?.proxyModeType || connectionStatus?.proxyModeType || 'systemProxy';
  const isTunMode = proxyModeType === 'tun';
  const isManualMode = proxyModeType === 'manual';
  const isConnected =
    isTunMode || isManualMode
      ? connectionStatus?.proxyCore?.running === true
      : !!connectionStatus?.proxyCore?.running && !!connectionStatus?.proxy?.enabled;
  const coreError = connectionStatus?.proxyCore?.error;
  const hasError = !!(proxyError || coreError);

  const isServerConfigured = isServerComplete(selectedServer);
  const meshNoInternet = !!selectedServer && isMeshNodeUnroutable(selectedServer);
  const startDisabledReason = !isServerConfigured
    ? meshNoInternet
      ? t('home.meshNoInternetGate')
      : t('home.plsConfigServer')
    : coreError || '';
  // 选中「不承载全隧道」的组网节点为主节点（可连接，非置灰）→ 外网回退直连、仅其网段经此节点（TS 由 TsExitWarning 专管）。
  const meshExitDirect =
    !!selectedServer &&
    isEndpointProtocol(selectedServer.protocol) &&
    selectedServer.protocol?.toLowerCase() !== 'tailscale' &&
    !meshNodeCarriesFullTunnel(selectedServer) &&
    !meshNoInternet &&
    (config?.proxyMode || 'smart').toLowerCase() !== 'direct';

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

  const connBtn = deriveConnectButtonState({
    proxyPhase,
    isConnected,
    hasError,
    isServerConfigured,
  });

  // ── 选节点（走既有 saveConfig：selectedServerId 写入配置，非新增 store action）──────────────────
  const handleServerChange = async (serverId: string) => {
    if (!config) return;
    try {
      await saveConfig({ ...config, selectedServerId: serverId });
      toast.success(t('home.serverSwitched'));
    } catch (error) {
      toast.error(t('home.switchFailed'), {
        description: error instanceof Error ? error.message : t('home.switchError'),
      });
    }
  };

  // ── 启停（helper 引导由主进程 start() native gate 统一承接，此处直接启停）────────────────────────
  const handleToggleProxy = async () => {
    if (isConnected) {
      await stopProxy();
      return;
    }
    await startProxy();
  };

  // ── 接管方式（proxyModeType）──────────────────────────────────────────────────────────────────
  const applyTakeover = async (modeType: ProxyModeType) => {
    if (!config) return;
    try {
      // FakeIP-TUN 待纠正：systemProxy 迁移冻结的 enableFakeIp:false 首次进 TUN 时回 true（消费快照）。
      const { config: next, corrected } = applyFakeIpTunEntry({
        ...config,
        proxyModeType: modeType,
      });
      await saveConfig(next);
      toast.success(t('settings.proxyMode.successUpdate'), {
        description: isConnected ? t('settings.proxyMode.reconnectToast') : undefined,
      });
      if (corrected) toast.info(t('settings.proxyMode.fakeIpAutoEnabled'));
    } catch {
      toast.error(t('settings.proxyMode.failUpdate'));
    }
  };

  const handleTakeoverChange = (next: ProxyModeType) => {
    if (next === config?.proxyModeType) return;
    if (isConnected) {
      setPendingModeType(next);
      setConfirmOpen(true);
    } else {
      applyTakeover(next);
    }
  };

  const confirmTakeover = () => {
    if (pendingModeType) applyTakeover(pendingModeType);
    setPendingModeType(null);
    setConfirmOpen(false);
  };

  // ── 分流策略（proxyMode）─────────────────────────────────────────────────────────────────────
  const handleRoutingChange = async (next: ProxyMode) => {
    setRoutingBusy(true);
    try {
      await updateProxyMode(next);
    } catch {
      toast.error(t('common.saveFailed'));
    } finally {
      setRoutingBusy(false);
    }
  };

  const takeoverOptions = [
    {
      value: 'systemProxy' as const,
      label: t('home.takeoverSystemProxy'),
      title: t('settings.proxyMode.systemProxyModeDesc'),
    },
    {
      value: 'tun' as const,
      label: t('home.takeoverTun'),
      title: t('settings.proxyMode.tunModeDesc'),
    },
    {
      value: 'manual' as const,
      label: t('home.takeoverManual'),
      title: t('settings.proxyMode.manualProxyModeDesc'),
    },
  ];
  const routingOptions = [
    { value: 'smart' as const, label: t('home.routingSmart'), title: t('home.modeSmartDesc') },
    { value: 'global' as const, label: t('home.routingGlobal'), title: t('home.modeGlobalDesc') },
    { value: 'direct' as const, label: t('home.routingDirect'), title: t('home.modeDirectDesc') },
  ];

  // 连接圆钮：三态配色（token 双主题）+ spinner + 图标。
  const connBtnColor =
    connBtn.kind === 'stop' || connBtn.kind === 'stopping'
      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
      : connBtn.kind === 'error'
        ? 'bg-warning text-warning-foreground hover:bg-warning/90'
        : 'bg-primary text-primary-foreground hover:bg-primary/90';
  const connIcon = connBtn.busy ? (
    <Loader2 className="h-5 w-5 animate-spin" />
  ) : connBtn.kind === 'stop' ? (
    <Square className="h-5 w-5 fill-current" />
  ) : connBtn.kind === 'error' ? (
    <AlertCircle className="h-5 w-5" />
  ) : (
    <Play className="h-5 w-5 translate-x-px fill-current" />
  );
  const connTitle =
    connBtn.kind === 'stop'
      ? t('home.stopProxy')
      : connBtn.disabled
        ? startDisabledReason || t('home.startProxy')
        : t('home.startProxy');

  // 就地测速 + 延迟排序（仅有节点时显）：紧凑图标按钮，放出口节点行内。
  const nodeControls =
    servers.length > 0 ? (
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          aria-pressed={sortByLatency}
          title={t('home.sortByLatency')}
          onClick={toggleSortByLatency}
          className={cn(
            'h-9 w-9',
            sortByLatency && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
          )}
        >
          <ArrowDownNarrowWide className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          disabled={isTestingSpeed}
          title={
            isTestingSpeed && speedProgress
              ? `${speedProgress.tested}/${speedProgress.total}`
              : t('servers.speedTestGroup')
          }
          onClick={handleSpeedTest}
        >
          <Zap className={cn('h-4 w-4', isTestingSpeed && 'animate-pulse')} />
        </Button>
      </div>
    ) : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t('home.connectionStatus')}</CardTitle>
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 出口节点：一步选下拉 + 测速/排序 + 连接圆钮 */}
        <div className="space-y-2">
          <span className="text-sm text-muted-foreground">{t('home.exitNode', '出口节点')}</span>
          {servers.length === 0 && !isDirect ? (
            // 空态引导：无节点 → 添加节点/订阅（连接圆钮同排但置灰）。
            <div className="flex items-center gap-2">
              <div className="flex flex-1 flex-wrap gap-2 rounded-md border border-dashed border-muted-foreground/25 p-3">
                <span className="w-full text-sm text-muted-foreground">
                  {t('home.noServerConfig')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setServerPageAction('add-server');
                    setCurrentView('server');
                  }}
                  className="gap-1.5"
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
                  className="gap-1.5"
                >
                  <Rss className="h-4 w-4" />
                  {t('home.addSubscription')}
                </Button>
              </div>
              <ConnectButton
                disabled
                title={t('home.plsConfigServer')}
                colorClass={connBtnColor}
                icon={connIcon}
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <ExitNodePicker
                  servers={servers}
                  selectedServerId={selectedServerId ?? undefined}
                  onSelect={handleServerChange}
                />
                {nodeControls}
                <ConnectButton
                  onClick={handleToggleProxy}
                  disabled={connBtn.disabled}
                  title={connTitle}
                  colorClass={connBtnColor}
                  icon={connIcon}
                />
              </div>

              {/* 有节点未选中：行内提示（选出口）。直连不触发。 */}
              {!selectedServer && !isDirect && (
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {t('home.selectServerHint')}
                </p>
              )}

              {/* §H：TS 出口名不副实行内警示；none→null。 */}
              <TsExitWarning />

              {/* 选中详情（协议/地址/端口）/ 全局直连说明。 */}
              {isDirect ? (
                <p className="text-xs text-muted-foreground">
                  {t('home.directGlobalHint', '全局直连：未命中规则的流量直连，仅按规则走代理')}
                </p>
              ) : selectedServer ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {t('home.protocol')}
                    <Badge variant="outline" className="text-[10px]">
                      {selectedServer.protocol}
                    </Badge>
                  </span>
                  {selectedServer.address && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      {t('home.address')}
                      <span
                        className="max-w-[180px] truncate font-mono text-foreground"
                        title={selectedServer.address}
                      >
                        {selectedServer.address}
                      </span>
                    </span>
                  )}
                  {selectedServer.port ? (
                    <span className="inline-flex items-center gap-1">
                      {t('home.port')}
                      <span className="font-mono text-foreground">{selectedServer.port}</span>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="h-px bg-border" />

        {/* 接管方式 + 分流策略：两列等宽分段（窄屏转单列） */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <span className="text-sm text-muted-foreground">{t('home.takeoverMethod')}</span>
            <SegmentedControl
              options={takeoverOptions}
              value={proxyModeType}
              onChange={handleTakeoverChange}
              disabled={proxyBusy}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm text-muted-foreground">{t('home.routingStrategy')}</span>
            <SegmentedControl
              options={routingOptions}
              value={config?.proxyMode || 'smart'}
              onChange={handleRoutingChange}
              disabled={proxyBusy || routingBusy}
            />
          </div>
        </div>

        {meshExitDirect && (
          <p className="text-xs text-warning">
            {t(
              'home.meshExitDirectHint',
              '所选组网节点未开启外网访问：外网流量走直连，仅其网段经此节点。'
            )}
          </p>
        )}

        {/* 状态描述 + 仅本地代理（manual）提示 */}
        <p className="text-xs text-muted-foreground">{statusInfo.description}</p>
        {(statusInfo as { isManualNotice?: boolean }).isManualNotice && (
          <div className="flex items-center gap-1.5 rounded-md border border-info/20 bg-info/10 p-2.5 text-sm font-medium text-info">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-info" />
            </span>
            {t('home.manualModeTip')}
          </div>
        )}
      </CardContent>

      {/* 已连接时切换接管方式 → 确认重连 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.proxyMode.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.proxyMode.confirmDesc')}
              <br />
              <br />
              {t('settings.proxyMode.confirmSwitch')}
              <strong>
                {pendingModeType === 'tun'
                  ? t('settings.proxyMode.tunMode')
                  : pendingModeType === 'manual'
                    ? t('settings.proxyMode.manualProxyMode')
                    : t('settings.proxyMode.systemProxyMode')}
              </strong>
              {t('settings.proxyMode.confirmQuestion')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingModeType(null)}>
              {t('settings.proxyMode.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmTakeover}>
              {t('settings.proxyMode.confirmBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** 连接圆钮（三态圆形按钮）：颜色/图标由父卡按 deriveConnectButtonState 传入。 */
function ConnectButton({
  onClick,
  disabled,
  title,
  colorClass,
  icon,
}: {
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  colorClass: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'ms-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-full shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        colorClass
      )}
    >
      {icon}
    </button>
  );
}
