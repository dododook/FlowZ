import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
import { useAppStore } from '@/store/app-store';
import { Plus, Rss, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { deriveConnectionStatus } from './connection-status';
import { isDirectSelection } from '@shared/direct-selection';

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
  // 全局直连哨兵（#73）：selectedServerId='__direct__' 时无真实节点，但不是「未选择」——需走当前选择分支显示「直连」。
  const isDirect = isDirectSelection(selectedServerId);
  const { t } = useTranslation();

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
              <p className="text-sm text-warning mb-3 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t('home.selectServerHint')}
              </p>
              <Select onValueChange={handleServerChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('home.selectServer')} />
                </SelectTrigger>
                <SelectContent>
                  <ServerSelectGroups servers={servers} includeDirect />
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
                      includeDirect
                    />
                  </SelectContent>
                </Select>
              </div>
            </div>

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
