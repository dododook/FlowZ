import { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { formatBytes } from '@/lib/format';
import { getLatencyColor } from '@/components/settings/server-list-helpers';
import { cn } from '@/lib/utils';
import { ArrowDown, ArrowUp, Activity, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deriveConnectionStatus } from './connection-status';
import { pickStatusBarExit, statusDotTone } from './status-bar-state';

/** ISO 2 位国家码 → 当前语言本地化地区名（HK→香港 / Hong Kong，随 i18n 语言）；非 2 位码（已是名/城市）原样返回。 */
function localizeRegion(v: string | undefined, lang: string): string | undefined {
  if (!v) return v;
  if (/^[A-Za-z]{2}$/.test(v)) {
    try {
      return new Intl.DisplayNames([lang], { type: 'region' }).of(v.toUpperCase()) ?? v;
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * 首页状态栏（Conduit `.statusbar`）：聚合当前态一眼可读——状态点/文案 + 当前节点 + 出口（连→代理出口 IP、
 * 未连→本地出口 IP）+ 延迟 + 实时速率/连接数（仅连接态）。粘底呈仪表读数带（surface-2 + border-top，30px 高）；
 * mono tabular 数字为信息主角。数据全取自既有 store（connectionStatus/ipInfo/stats/latencyMap），零新增 IPC。
 */
export function HomeStatusBar() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const config = useAppStore((s) => s.config);
  const proxyError = useAppStore((s) => s.proxyError);
  const proxyBusy = useAppStore((s) => s.proxyBusy);
  const proxyPhase = useAppStore((s) => s.proxyPhase);
  const ipInfo = useAppStore((s) => s.ipInfo);
  const stats = useAppStore((s) => s.stats);
  const reprobeExitIp = useAppStore((s) => s.reprobeExitIp);
  const [reprobing, setReprobing] = useState(false);

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
  const region = localizeRegion(exit.info?.country ?? exit.info?.countryCode, i18n.language);

  // 手动重探：检测超时/出口无效终态下点刷新图标，force 重探出口 IP（绕 TTL）。in-flight 去重 + 转圈。
  const handleReprobe = async () => {
    if (reprobing) return;
    setReprobing(true);
    try {
      await reprobeExitIp();
    } finally {
      setReprobing(false);
    }
  };

  // 状态点：conduit `.dot` 仅有 ok/warn/idle；err 无预设 → 以 --err token 内联补齐（保留三态语义）。
  const tone = statusDotTone(status.variant);
  const dotClass = tone === 'err' ? 'dot' : `dot ${tone}`;
  const dotStyle =
    tone === 'err'
      ? { background: 'hsl(var(--err))', boxShadow: '0 0 0 3px hsl(var(--err) / 0.16)' }
      : undefined;

  return (
    <div className="statusbar overflow-hidden whitespace-nowrap">
      {/* 状态：点 + 文案 */}
      <span className={dotClass} style={dotStyle} />
      <span className="font-medium text-[hsl(var(--fg))]">{status.label}</span>

      {/* 当前节点 */}
      {selectedServer && (
        <>
          <span className="sb-sep">·</span>
          <span className="min-w-0 max-w-[180px] truncate" title={selectedServer.name}>
            {selectedServer.name}
          </span>
        </>
      )}

      {/* 出口：仅地区 + IP（去「本地出口/代理出口」前缀，用户反馈）。exit.isProxy 仍决定取代理/本地 IP。 */}
      <span className="sb-sep">·</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {exit.info ? (
          <span className="inline-flex min-w-0 items-center gap-2">
            {region && (
              <>
                <span className="shrink-0 text-[hsl(var(--fg-faint))]">{region}</span>
                <span className="sb-sep shrink-0">·</span>
              </>
            )}
            <span className="mono tnum truncate text-[hsl(var(--fg))]" title={exit.info.ip}>
              {exit.info.ip}
            </span>
          </span>
        ) : exit.invalid ? (
          // TS 出口 API 直判无效（未广告出口设备 / exit peer 离线）→ 橘色 warn「出口无效」，不再空转「检测中」（本修复）。
          <span className="text-[hsl(var(--warn))]">{t('home.exitInvalid', '出口无效')}</span>
        ) : exit.detecting ? (
          <span className="text-[hsl(var(--fg-faint))]">{t('home.exitDetecting', '检测中…')}</span>
        ) : exit.failed ? (
          // 探测超时/失败（含 TS 选中出口广播失效、路由无效）→ 橘色 warn 可见警示，替代空白「—」（用户反馈）。
          <span className="text-[hsl(var(--warn))]">{t('home.exitTimeout', '检测超时')}</span>
        ) : (
          <span className="text-[hsl(var(--fg-faint))]">—</span>
        )}
      </span>

      {/* 检测超时 / 出口无效 终态 → 状态后刷新图标：手动 force 重探出口 IP（用户反馈：失败态给重试入口）。 */}
      {running && (exit.failed || exit.invalid) && (
        <button
          type="button"
          onClick={handleReprobe}
          disabled={reprobing}
          title={t('home.reprobeExit', '重新检测出口')}
          aria-label={t('home.reprobeExit', '重新检测出口')}
          className="inline-flex shrink-0 items-center text-[hsl(var(--fg-faint))] transition-colors hover:text-[hsl(var(--fg))] disabled:opacity-50 [-webkit-app-region:no-drag]"
        >
          <RefreshCw className={cn('h-3 w-3', reprobing && 'animate-spin')} />
        </button>
      )}

      {/* 当前节点延迟 */}
      {selectedLatency !== undefined && (
        <>
          <span className="sb-sep">·</span>
          <span className={cn('mono tnum', getLatencyColor(selectedLatency))}>
            {selectedLatency === -1 ? t('servers.timeout', '超时') : `${selectedLatency} ms`}
          </span>
        </>
      )}

      {/* 实时速率 / 连接数（仅连接态）→ 右组 .sp（对齐原型 --dn/--up 读数 + --warn 连接数） */}
      {running && (
        <span className="sp">
          <span
            className="mono tnum inline-flex items-center gap-1"
            style={{ color: 'hsl(var(--dn))' }}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {formatBytes(stats?.downloadSpeed ?? 0)}/s
          </span>
          <span
            className="mono tnum inline-flex items-center gap-1"
            style={{ color: 'hsl(var(--up))' }}
          >
            <ArrowUp className="h-3.5 w-3.5" />
            {formatBytes(stats?.uploadSpeed ?? 0)}/s
          </span>
          <span className="sb-sep">·</span>
          <span
            className="mono tnum inline-flex items-center gap-1"
            style={{ color: 'hsl(var(--warn))' }}
          >
            <Activity className="h-3.5 w-3.5" />
            {stats?.activeConnections ?? 0}
          </span>
        </span>
      )}
    </div>
  );
}
