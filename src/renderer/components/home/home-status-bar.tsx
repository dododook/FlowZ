import { useAppStore } from '@/store/app-store';
import { formatBytes } from '@/lib/format';
import { getLatencyColor } from '@/components/settings/server-list-helpers';
import { cn } from '@/lib/utils';
import { ArrowDown, ArrowUp, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deriveConnectionStatus } from './connection-status';
import { pickStatusBarExit, statusDotTone, type StatusDotTone } from './status-bar-state';

const DOT_CLASS: Record<StatusDotTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-destructive',
  idle: 'bg-muted-foreground/50',
};

/**
 * 首页状态栏：聚合当前态一眼可读——状态点/文案 + 当前节点 + 出口（连→代理出口 IP、未连→本地出口 IP）+ 延迟
 * + 实时速率/连接数（仅连接态）。粘底（sticky）呈仪表读数带；mono tabular 数字为信息主角（Conduit）。
 * 数据全取自既有 store（connectionStatus/ipInfo/stats/latencyMap），零新增 IPC。
 */
export function HomeStatusBar() {
  const { t } = useTranslation();
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const config = useAppStore((s) => s.config);
  const proxyError = useAppStore((s) => s.proxyError);
  const proxyBusy = useAppStore((s) => s.proxyBusy);
  const proxyPhase = useAppStore((s) => s.proxyPhase);
  const ipInfo = useAppStore((s) => s.ipInfo);
  const stats = useAppStore((s) => s.stats);

  const selectedServerId = config?.selectedServerId;
  const selectedServer = config?.servers?.find((s) => s.id === selectedServerId);
  const selectedLatency = useAppStore((s) =>
    selectedServerId ? s.latencyMap[selectedServerId] : undefined
  );

  const running = connectionStatus?.proxyCore?.running ?? false;
  const status = deriveConnectionStatus(
    {
      proxyError,
      connectionStatus,
      configProxyModeType: config?.proxyModeType,
      proxyBusy,
      proxyPhase,
    },
    t
  );
  const exit = pickStatusBarExit(running, ipInfo);
  const region = exit.info?.country ?? exit.info?.countryCode;

  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-background/85 px-6 py-2 text-xs text-muted-foreground backdrop-blur">
      {/* 状态：点 + 文案 */}
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('h-2 w-2 rounded-full', DOT_CLASS[statusDotTone(status.variant)])} />
        <span className="font-medium text-foreground">{status.label}</span>
      </span>

      {/* 当前节点 */}
      {selectedServer && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="max-w-[180px] truncate" title={selectedServer.name}>
            {selectedServer.name}
          </span>
        </>
      )}

      {/* 出口（按连接分态）：代理出口 / 本地出口 IP */}
      <span className="text-muted-foreground/50">·</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground/70">
          {exit.isProxy ? t('home.proxyExit') : t('home.localExit')}
        </span>
        {exit.info ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            {region && <span className="shrink-0 text-muted-foreground/70">{region}</span>}
            <span className="truncate font-mono tabular-nums text-foreground" title={exit.info.ip}>
              {exit.info.ip}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </span>

      {/* 当前节点延迟 */}
      {selectedLatency !== undefined && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className={cn('font-mono tabular-nums', getLatencyColor(selectedLatency))}>
            {selectedLatency === -1 ? t('servers.timeout', '超时') : `${selectedLatency} ms`}
          </span>
        </>
      )}

      {/* 实时速率 / 连接数（仅连接态） */}
      {running && (
        <span className="ms-auto flex items-center gap-x-3">
          <span className="inline-flex items-center gap-1 font-mono tabular-nums text-success">
            <ArrowDown className="h-3.5 w-3.5" />
            {formatBytes(stats?.downloadSpeed ?? 0)}/s
          </span>
          <span className="inline-flex items-center gap-1 font-mono tabular-nums text-info">
            <ArrowUp className="h-3.5 w-3.5" />
            {formatBytes(stats?.uploadSpeed ?? 0)}/s
          </span>
          <span className="text-muted-foreground/50">·</span>
          {/* 连接数是中性读数（非告警态）→ 用中性 foreground 色，不用 text-warning（避免误读为告警）。 */}
          <span className="inline-flex items-center gap-1 font-mono tabular-nums text-foreground">
            <Activity className="h-3.5 w-3.5" />
            {stats?.activeConnections ?? 0}
          </span>
        </span>
      )}
    </div>
  );
}
