import { useMemo, useState, type ReactNode } from 'react';
import { NodePicker } from '@/components/ui/node-picker';
import { buildServerPickerModel } from '@/components/ui/server-picker-items';
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
  Pause,
  Play,
  Plus,
  Rss,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { ProxyMode, ProxyModeType, ServerConfig } from '@/bridge/types';
import { cn } from '@/lib/utils';
import { deriveConnectionStatus } from './connection-status';
import { deriveConnectButtonState } from './connect-button-state';
import { UnlockInline } from './unlock-inline';
import { TsExitWarning } from './ts-exit-warning';
import { willRestartOnSelect } from './pending-select-hint';
import { DIRECT_SERVER_ID, isDirectSelection } from '@shared/direct-selection';
import { sortServersByLatency } from '@shared/server-latency-sort';
import { isServerComplete } from '@shared/server-completeness';
import { applyFakeIpTunEntry } from '@shared/fakeip-tun-entry';
import {
  isEndpointProtocol,
  isMeshNodeUnroutable,
  meshNodeCarriesFullTunnel,
} from '@shared/endpoint-routes';

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
  // 徽标异常态输入：使下拉里 TS/组网出口显「出口无效 / 未登录」warn 文案（与 SpeedBadge 同 deriveLatencyBadge 口径）。
  const tailscaleLoginStates = useAppStore((s) => s.tailscaleLoginStates);
  const proxyRunning = useAppStore((s) => !!s.connectionStatus?.proxyCore?.running);
  const proxyBlocked = useAppStore((s) => s.ipInfo?.proxyBlocked);
  const speedTestAttempted = useAppStore((s) => s.speedTestAttempted);

  // 直连哨兵（#73）恒置顶；组内按延迟排序开关；共享映射与规则/应用分流/detour 口径统一。
  // memo 对齐 rule-dialog / app-rules-card：仅在输入（节点/订阅/延迟/排序开关/i18n/登录·出口态）变化时重算，测速广播不空跑。
  const { items, groups } = useMemo(
    () =>
      buildServerPickerModel({
        servers,
        subscriptions,
        latencyMap,
        meshLabel: t('servers.meshNodes', '组网'),
        manualLabel: t('servers.manualNodes', '自建节点'),
        sentinel: { id: DIRECT_SERVER_ID, name: t('servers.directGlobal', '直连'), role: 'direct' },
        withAddress: true,
        sortServers: (arr) =>
          sortByLatency ? sortServersByLatency(arr, (id) => latencyMap[id]) : arr,
        speedTestAttempted,
        badge: {
          tsLoggedIn: tailscaleLoginStates,
          selectedServerId,
          proxyRunning,
          proxyBlocked,
          exitInvalidLabel: t('home.exitInvalid', '出口无效'),
          notLoggedInLabel: t('servers.tsNotLoggedIn', '未登录'),
        },
      }),
    [
      servers,
      subscriptions,
      latencyMap,
      sortByLatency,
      t,
      tailscaleLoginStates,
      selectedServerId,
      proxyRunning,
      proxyBlocked,
      speedTestAttempted,
    ]
  );

  return (
    <NodePicker
      items={items}
      groups={groups}
      value={selectedServerId}
      onSelect={onSelect}
      size="lg"
      showAddress
      hideTriggerLatency
      className="min-w-0 flex-1"
      placeholder={t('home.selectServer')}
      searchPlaceholder={t('common.search', '搜索')}
      ariaLabel={t('home.exitNode', '出口节点')}
    />
  );
}

/**
 * 首页连接控制卡（Conduit `.card.conn-card`）：出口节点 `.npick` 一步选 + 连接圆钮三态
 * （未连 teal ▶ `.conn-toggle.off` / 已连 红 ‖ `.on` / 错误 橘 ! `.err`）+ 接管方式 `.seg2`（系统/TUN/手动，
 * 切换时若已连弹重连确认）+ 分流策略 `.seg2`（智能/全局/直连）。功能全保留：空态引导、就地测速/延迟排序、
 * TS 出口警示、选中详情、组网回退提示、manual 提示、置灰原因。接管方式的 FakeIP-TUN 待纠正 / native gate
 * 引导逻辑逐字迁移。附加状态（空态/提示/详情/重连确认）以同一 conduit 语言渲染在卡片下方，自然承接。
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

  // 弹窗开合由 pendingModeType 单一真值驱动（非空即开），省去冗余 confirmOpen。
  const [pendingModeType, setPendingModeType] = useState<ProxyModeType | null>(null);
  // updateProxyMode 不写全局 busy → 本地 routingBusy 提供分流切换反馈（沿用原卡）。
  const [routingBusy, setRoutingBusy] = useState(false);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const isDirect = isDirectSelection(selectedServerId);

  // 就地全量测速（复用服务器页 hook：isSpeedTestable 过滤 + 聚合 toast，结果经全局 latencyMap 回流下拉）。
  const { isTestingSpeed, handleSpeedTest } = useSpeedTest(servers);

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
    // issue 3：选中「待入池/待生效」节点将使其变被引用 → 触发自动整核重启、待应用动作条随即消失。
    // 先判后 save（save 成功即触发重启清差集），成功后给一次性提示，解释「动作条为何消失」。
    // pendingChanges 在 handler 内即时读取（getState），不订阅——否则每次 configChanged 广播都重渲整卡（Nit-11）。
    const willRestart = willRestartOnSelect(useAppStore.getState().pendingChanges, serverId);
    try {
      await saveConfig({ ...config, selectedServerId: serverId });
      // 选节点不弹「已切换」成功 toast（用户反馈：picker 即时反映选择即为反馈、无需提醒；同接管方式 toast 移除理由）。
      if (willRestart) toast.info(t('home.selectPendingNodeRestartHint'));
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
      // 接管方式变更不弹「代理模式已更新」成功 toast（用户反馈：无需提醒、避免叠加）；分段控件即时反映即为反馈。
      // 仅保留 FakeIP 自动纠正的一次性提示（罕见、有实际副作用需告知）。
      if (corrected) toast.info(t('settings.proxyMode.fakeIpAutoEnabled'));
    } catch {
      toast.error(t('settings.proxyMode.failUpdate'));
    }
  };

  const handleTakeoverChange = (next: ProxyModeType) => {
    if (next === config?.proxyModeType) return;
    if (isConnected) {
      setPendingModeType(next);
    } else {
      applyTakeover(next);
    }
  };

  const confirmTakeover = () => {
    if (pendingModeType) applyTakeover(pendingModeType);
    setPendingModeType(null);
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
  const currentRouting = config?.proxyMode || 'smart';

  // 连接圆钮三态：off=未连（teal ▶）/ on=已连或断开中（红 ‖）/ err=错误（橘 !）；busy 期间显 spinner。
  const connState =
    connBtn.kind === 'stop' || connBtn.kind === 'stopping'
      ? 'on'
      : connBtn.kind === 'error'
        ? 'err'
        : 'off';
  const connIcon = connBtn.busy ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : connBtn.kind === 'stop' ? (
    <Pause className="h-4 w-4 fill-current" />
  ) : connBtn.kind === 'error' ? (
    <AlertCircle className="h-4 w-4" />
  ) : (
    <Play className="h-4 w-4 translate-x-px fill-current" />
  );
  const connTitle =
    connBtn.kind === 'stop'
      ? t('home.stopProxy')
      : connBtn.disabled
        ? startDisabledReason || t('home.startProxy')
        : t('home.startProxy');

  const speedTitle = isTestingSpeed ? t('servers.speedTesting') : t('servers.speedTestGroup');

  const isEmptyState = servers.length === 0 && !isDirect;

  return (
    <div className="flex flex-col gap-3">
      <div className="card conn-card">
        {/* 出口节点：一步选下拉 + 测速/排序 + 连接圆钮三态 */}
        <div className="field">
          {/* 出口节点标签行：右侧内联解锁检测（解锁态 ↔ 出口节点强绑，零挤占垂直空间） */}
          <div className="flex items-center gap-3">
            <div className="field-lbl shrink-0">{t('home.exitNode', '出口节点')}</div>
            <div className="ms-auto min-w-0">
              <UnlockInline />
            </div>
          </div>
          {isEmptyState ? (
            // 空态引导：无节点 → 添加节点/订阅（连接圆钮同排但置灰）。
            <div className="cc-node-row">
              <div className="flex flex-1 flex-wrap items-center gap-2 rounded-[9px] border border-dashed border-[hsl(var(--line))] bg-[hsl(var(--surface-2))] p-3">
                <span className="text-[12.5px] text-[hsl(var(--fg-dim))]">
                  {t('home.noServerConfig')}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setServerPageAction('add-server');
                    setCurrentView('server');
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('home.addServer')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setServerPageAction('add-sub');
                    setCurrentView('server');
                  }}
                >
                  <Rss className="h-3.5 w-3.5" />
                  {t('home.addSubscription')}
                </button>
              </div>
              <ConnToggle
                disabled
                title={t('home.plsConfigServer')}
                state={connState}
                icon={connIcon}
              />
            </div>
          ) : (
            <div className="cc-node-row">
              <ExitNodePicker
                servers={servers}
                selectedServerId={selectedServerId ?? undefined}
                onSelect={handleServerChange}
              />
              {servers.length > 0 && (
                <>
                  <button
                    type="button"
                    className="btn ghost icon"
                    disabled={isTestingSpeed}
                    title={speedTitle}
                    aria-label={speedTitle}
                    onClick={handleSpeedTest}
                  >
                    <Zap className={cn('h-4 w-4', isTestingSpeed && 'animate-pulse')} />
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'btn ghost icon',
                      sortByLatency &&
                        'border-[hsl(var(--flow)/0.4)] bg-[hsl(var(--flow-weak))] text-[hsl(var(--flow-hi))] hover:bg-[hsl(var(--flow-weak))]'
                    )}
                    aria-pressed={sortByLatency}
                    title={t('home.sortByLatency')}
                    aria-label={t('home.sortByLatency')}
                    onClick={toggleSortByLatency}
                  >
                    <ArrowDownNarrowWide className="h-4 w-4" />
                  </button>
                </>
              )}
              <ConnToggle
                onClick={handleToggleProxy}
                disabled={connBtn.disabled}
                title={connTitle}
                state={connState}
                icon={connIcon}
              />
            </div>
          )}
        </div>

        <div className="cc-hair" />

        {/* 接管方式 + 分流策略：两列等宽 seg2 */}
        <div className="mode-grid">
          <div className="field">
            <div className="field-lbl">{t('home.takeoverMethod')}</div>
            <div className="seg2">
              {takeoverOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={cn(
                    o.value === proxyModeType && 'on',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                  title={o.title}
                  disabled={proxyBusy}
                  onClick={() => handleTakeoverChange(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field-lbl">{t('home.routingStrategy')}</div>
            <div className="seg2">
              {routingOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={cn(
                    o.value === currentRouting && 'on',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                  title={o.title}
                  disabled={proxyBusy || routingBusy}
                  onClick={() => handleRoutingChange(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 附加状态（同一 conduit 语言，承接卡片下方；不适用时各自渲 null，不占位）───────────────── */}

      {/* 有节点未选中：行内提示（选出口）。直连不触发。 */}
      {servers.length > 0 && !selectedServer && !isDirect && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('home.selectServerHint')}
        </p>
      )}

      {/* §H：TS 出口名不副实行内警示；none→null。 */}
      <TsExitWarning />

      {/* 全局直连说明（仅 direct 模式）。选中节点协议/地址/端口已由出口 npick + 状态栏承载，首页不再重复该行。 */}
      {isDirect && (
        <p className="text-xs text-muted-foreground">
          {t('home.directGlobalHint', '全局直连：未命中规则的流量直连，仅按规则走代理')}
        </p>
      )}

      {meshExitDirect && (
        <p className="text-xs text-warning">
          {t(
            'home.meshExitDirectHint',
            '所选组网节点未开启外网访问：外网流量走直连，仅其网段经此节点。'
          )}
        </p>
      )}

      {/* 仅本地代理（manual）提示。通用连接状态（未启用/已连接等）已由状态栏 + 页头摘要承载，首页卡内不再重复状态描述行。 */}
      {(statusInfo as { isManualNotice?: boolean }).isManualNotice && (
        <div className="flex items-center gap-1.5 rounded-md border border-info/20 bg-info/10 p-2.5 text-sm font-medium text-info">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-info" />
          </span>
          {t('home.manualModeTip')}
        </div>
      )}

      {/* 已连接时切换接管方式 → 确认重连（pendingModeType 非空即开；关闭即清 pending） */}
      <AlertDialog
        open={pendingModeType !== null}
        onOpenChange={(o) => {
          if (!o) setPendingModeType(null);
        }}
      >
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
    </div>
  );
}

/**
 * 连接圆钮（Conduit `.conn-toggle` 三态圆钮，40px）：state=off（teal ▶）/ on（红 ‖）/ err（橘 !）由父卡按
 * deriveConnectButtonState 传入；禁用时降透明度。图标（含 spinner）由父卡传入。
 */
function ConnToggle({
  onClick,
  disabled,
  title,
  state,
  icon,
}: {
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  state: 'off' | 'on' | 'err';
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn('conn-toggle', state, disabled && 'cursor-not-allowed opacity-50')}
    >
      {icon}
    </button>
  );
}
