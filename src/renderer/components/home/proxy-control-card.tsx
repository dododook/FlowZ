import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
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
import { Loader2, Play, Square } from 'lucide-react';
import type { ProxyMode, ProxyModeType } from '@/bridge/types';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { isServerComplete } from '../../../shared/server-completeness';

/**
 * 首页代理控制卡：两行 OpenClash 风格分段切换（接管方式 / 分流策略）+ 启停按钮。
 * 接管方式（systemProxy/tun/manual）从设置页迁移至此。macOS + TUN 下 helper 未就绪/失效的安装·修复·解禁
 * 引导**统一收敛到主进程 ProxyManager.start() 的 native gate**（无窗口依赖、所有 start 入口共用），
 * 渲染端不再各自弹窗；设置页 helper 管理卡仍提供常驻的安装/修复/卸载入口。
 */
export function ProxyControlCard() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const proxyBusy = useAppStore((s) => s.proxyBusy);
  const proxyPhase = useAppStore((s) => s.proxyPhase);
  const updateProxyMode = useAppStore((s) => s.updateProxyMode);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const startProxy = useAppStore((s) => s.startProxy);
  const stopProxy = useAppStore((s) => s.stopProxy);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingModeType, setPendingModeType] = useState<ProxyModeType | null>(null);
  // F2：updateProxyMode 不再写全局 busy → 用本地 routingBusy 提供分流切换进行中反馈
  const [routingBusy, setRoutingBusy] = useState(false);

  // config 是接管方式的持久化真值（用户设置）；优先它，避免启动时 connectionStatus 尚未刷新而默认 systemProxy 盖掉已存的 tun。
  const proxyModeType = config?.proxyModeType || connectionStatus?.proxyModeType || 'systemProxy';
  const isTunMode = proxyModeType === 'tun';
  const isManualMode = proxyModeType === 'manual';
  const isConnected =
    isTunMode || isManualMode
      ? connectionStatus?.proxyCore?.running === true
      : connectionStatus?.proxyCore?.running && connectionStatus?.proxy?.enabled;
  const hasError = connectionStatus?.proxyCore?.error;

  const isServerConfigured = isServerComplete(
    config?.servers?.find((x) => x.id === config?.selectedServerId)
  );

  // ── 接管方式（proxyModeType）────────────────────────────────────────────
  const applyTakeover = async (modeType: ProxyModeType) => {
    if (!config) return;
    try {
      await saveConfig({ ...config, proxyModeType: modeType });
      toast.success(t('settings.proxyMode.successUpdate'), {
        description: isConnected ? t('settings.proxyMode.reconnectToast') : undefined,
      });
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

  // ── 分流策略（proxyMode）────────────────────────────────────────────────
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

  // 启停：helper 引导（macOS TUN 未就绪）由主进程 start() 的 native gate 统一承接，此处直接启停。
  const handleToggleProxy = async () => {
    if (isConnected) {
      await stopProxy();
      return;
    }
    await startProxy();
  };

  if (!config) return null;

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
    { value: 'global' as const, label: t('home.routingGlobal'), title: t('home.modeGlobalDesc') },
    { value: 'smart' as const, label: t('home.routingSmart'), title: t('home.modeSmartDesc') },
    { value: 'direct' as const, label: t('home.routingDirect'), title: t('home.modeDirectDesc') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('home.proxyControl')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 接管方式 */}
        <div className="space-y-2">
          <span className="text-sm text-muted-foreground">{t('home.takeoverMethod')}</span>
          <SegmentedControl
            options={takeoverOptions}
            value={proxyModeType}
            onChange={handleTakeoverChange}
            disabled={proxyBusy}
          />
        </div>

        {/* 分流策略 */}
        <div className="space-y-2">
          <span className="text-sm text-muted-foreground">{t('home.routingStrategy')}</span>
          <SegmentedControl
            options={routingOptions}
            value={config.proxyMode || 'smart'}
            onChange={handleRoutingChange}
            disabled={proxyBusy || routingBusy}
          />
        </div>

        {/* 启停 */}
        <div className="pt-1">
          <Button
            onClick={handleToggleProxy}
            disabled={proxyBusy || !isServerConfigured}
            className="w-full"
            size="lg"
            variant={
              proxyPhase === 'stopping' || (proxyPhase === 'idle' && isConnected)
                ? 'destructive'
                : 'default'
            }
            title={!isServerConfigured ? t('home.plsConfigServer') : hasError ? hasError : ''}
          >
            {proxyPhase !== 'idle' ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {proxyPhase === 'stopping' ? t('home.disconnecting') : t('home.connecting')}
              </>
            ) : isConnected ? (
              <>
                <Square className="mr-2 h-4 w-4" />
                {t('home.stopProxy')}
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                {t('home.startProxy')}
              </>
            )}
          </Button>
        </div>
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
