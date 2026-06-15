import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
import { useAppStore } from '@/store/app-store';
import { Plus, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export function ConnectionStatusCard() {
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const config = useAppStore((state) => state.config);
  const proxyError = useAppStore((state) => state.proxyError);
  const proxyBusy = useAppStore((state) => state.proxyBusy);
  const proxyPhase = useAppStore((state) => state.proxyPhase);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const setCurrentView = useAppStore((state) => state.setCurrentView);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const { t } = useTranslation();

  const getStatusInfo = () => {
    // Use proxyModeType from connectionStatus if available, otherwise fall back to config
    const proxyModeType = config?.proxyModeType || connectionStatus?.proxyModeType || 'systemProxy';
    const isTunMode = proxyModeType === 'tun';
    const isManualMode = proxyModeType === 'manual';
    const modeText = isTunMode
      ? t('home.tunMode')
      : isManualMode
        ? t('home.manualMode')
        : t('home.systemProxyMode');

    // Show proxy error from store if present
    if (proxyError) {
      return {
        label: t('home.statusError'),
        variant: 'destructive' as const,
        description: proxyError,
        mode: modeText,
      };
    }

    if (!connectionStatus) {
      return {
        label: t('home.statusUnknown'),
        variant: 'secondary' as const,
        description: t('home.fetchingStatus'),
        mode: modeText,
      };
    }

    const { proxyCore, proxy } = connectionStatus;

    // Handle proxy core errors with more specific messages
    if (proxyCore.error) {
      // Parse TUN mode specific errors
      let errorDescription = proxyCore.error;

      if (proxyCore.error.includes('权限不足') || proxyCore.error.includes('管理员权限')) {
        errorDescription = t('home.tunNeedsAdmin');
      } else if (proxyCore.error.includes('wintun') || proxyCore.error.includes('驱动')) {
        errorDescription = t('home.tunDriverFail');
      } else if (proxyCore.error.includes('接口创建失败')) {
        errorDescription = t('home.tunInterfaceFail');
      } else if (proxyCore.error.includes('sing-box.exe')) {
        errorDescription = t('home.singboxMissing');
      }

      return {
        label: t('home.statusError'),
        variant: 'destructive' as const,
        description: errorDescription,
        mode: modeText,
      };
    }

    // TUN模式下，只需要检查代理核心是否运行
    if (isTunMode) {
      if (proxyCore.running) {
        const uptime = proxyCore.uptime
          ? t('home.uptime', { min: Math.floor(proxyCore.uptime / 60) })
          : '';
        return {
          label: t('home.statusConnected'),
          variant: 'default' as const,
          description: `${t('home.tunMode')}${t('home.statusConnected')}${uptime ? ' - ' + uptime : ''}`,
          mode: modeText,
        };
      }

      if (proxyBusy) {
        const stopping = proxyPhase === 'stopping';
        return {
          label: t(stopping ? 'home.disconnecting' : 'home.statusConnecting'),
          variant: 'secondary' as const,
          description: t(stopping ? 'home.stoppingProxy' : 'home.startingTun'),
          mode: modeText,
        };
      }

      return {
        label: t('home.statusDisconnected'),
        variant: 'outline' as const,
        description: t('home.tunNotEnabled'),
        mode: modeText,
      };
    }

    // 系统代理或仅本地代理模式下，需要检查代理核心和（系统代理的）状态
    // 对于仅本地代理，只要 proxyCore.running 即可，因为它不碰 proxy.enabled状态
    if (proxyCore.running && (proxy.enabled || isManualMode)) {
      const uptime = proxyCore.uptime
        ? t('home.uptime', { min: Math.floor(proxyCore.uptime / 60) })
        : '';

      if (isManualMode) {
        return {
          label: t('home.statusConnected'),
          variant: 'default' as const,
          description: uptime ? `${t('home.manualMode')} - ${uptime}` : t('home.manualMode'),
          mode: modeText,
          isManualNotice: true,
        };
      }

      return {
        label: t('home.statusConnected'),
        variant: 'default' as const,
        description: `${t('home.systemProxyConnected')}${uptime ? ' - ' + uptime : ''}`,
        mode: modeText,
      };
    }

    if (proxyCore.running && !proxy.enabled && !isManualMode) {
      return {
        label: t('home.statusConnecting'),
        variant: 'secondary' as const,
        description: t('home.singboxRunningEnabling'),
        mode: modeText,
      };
    }

    if (proxyBusy) {
      const stopping = proxyPhase === 'stopping';
      return {
        label: t(stopping ? 'home.disconnecting' : 'home.statusConnecting'),
        variant: 'secondary' as const,
        description: t(stopping ? 'home.stoppingProxy' : 'home.startingSingbox'),
        mode: modeText,
      };
    }

    return {
      label: t('home.statusDisconnected'),
      variant: 'outline' as const,
      description: t('home.proxyNotEnabled'),
      mode: modeText,
    };
  };

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

  const handleGoToServers = () => {
    setCurrentView('server');
  };

  const statusInfo = getStatusInfo();

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

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('home.runningMode')}</span>
          <Badge variant="secondary">{statusInfo.mode}</Badge>
        </div>

        {/* 服务器选择区域 */}
        {servers.length === 0 ? (
          <div className="space-y-3">
            <div className="p-4 border border-dashed border-muted-foreground/25 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-3">{t('home.noServerConfig')}</p>
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGoToServers}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  {t('home.addServer')}
                </Button>
              </div>
            </div>
          </div>
        ) : !selectedServer ? (
          <div className="space-y-3">
            <div className="p-4 border border-warning/50 bg-warning/10 rounded-lg">
              <p className="text-sm text-warning mb-3 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t('home.selectServerHint')}
              </p>
              <Select onValueChange={handleServerChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('home.selectServer')} />
                </SelectTrigger>
                <SelectContent>
                  <ServerSelectGroups servers={servers} />
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 服务器切换 */}
            <div className="space-y-2">
              <div className="space-y-2">
                <span className="text-sm text-muted-foreground">{t('home.currentServer')}</span>
                <Select value={selectedServerId ?? undefined} onValueChange={handleServerChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('home.selectServer')} />
                  </SelectTrigger>
                  <SelectContent>
                    <ServerSelectGroups
                      servers={servers}
                      selectedId={selectedServerId ?? undefined}
                    />
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* 服务器详细信息 */}
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
