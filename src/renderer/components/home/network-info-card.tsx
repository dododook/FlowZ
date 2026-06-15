import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { formatBytes } from '@/lib/format';
import { Eye, EyeOff, RotateCw, Globe, ArrowUp, ArrowDown, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { IpInfo } from '@/bridge/types';

const MASK_KEY = 'flowz:maskIp';
const MASKED_IP = '••• ••• ••• •••';

function Flag({ cc }: { cc?: string }) {
  // flagcdn 加载失败（如未连代理的国内直连环境不可达）→ 兜底 Globe，不留空图标位
  const [failed, setFailed] = useState(false);
  if (!cc || failed)
    return <Globe className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return (
    <img
      src={`https://flagcdn.com/w40/${cc.toLowerCase()}.png`}
      alt={cc}
      className="mt-[3px] h-3.5 w-5 shrink-0 rounded-sm object-cover"
      onError={() => setFailed(true)}
    />
  );
}

/** countryCode → 本地化国家名（跟随界面语言，如 zh→「美国」/ en→「United States」）。失败/无码返 undefined。 */
function countryNameOf(cc: string | undefined, lang: string): string | undefined {
  if (!cc) return undefined;
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(cc.toUpperCase());
  } catch {
    return undefined; // 非法 region code / 环境不支持 → 兜底无名（仍显示国旗 + IP）
  }
}

export function NetworkInfoCard() {
  const { t, i18n } = useTranslation();
  const ipInfo = useAppStore((s) => s.ipInfo);
  const stats = useAppStore((s) => s.stats);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const refreshStatistics = useAppStore((s) => s.refreshStatistics);

  const running = connectionStatus?.proxyCore?.running ?? false;
  const loading = ipInfo?.loading ?? false;

  const [masked, setMasked] = useState<boolean>(() => localStorage.getItem(MASK_KEY) === '1');

  // 挂载拉初值（出口 IP + 流量快照）；写回 store 兜底「事件早于订阅 + TTL 命中不广播」的冷启动竞态
  useEffect(() => {
    api.ipInfo
      .get()
      .then((snap) => useAppStore.setState({ ipInfo: snap }))
      .catch(() => {});
    refreshStatistics();
  }, [refreshStatistics]);

  // 切节点的代理出口重测改由主进程在热切换成功后触发（refreshProxy），避免渲染端猜时机的竞态。

  const toggleMask = () => {
    const next = !masked;
    setMasked(next);
    localStorage.setItem(MASK_KEY, next ? '1' : '0');
  };

  const handleRefresh = () => {
    void api.ipInfo.get(true);
  };

  // IP 单元格主值
  const renderIpValue = (info: IpInfo | null, emptyText: string) => {
    if (masked && info)
      return <span className="min-w-0 break-all font-mono text-sm font-semibold">{MASKED_IP}</span>;
    if (info) {
      return (
        <span
          className="min-w-0 break-all font-mono text-sm font-semibold tabular-nums"
          title={info.ip}
        >
          {info.ip}
        </span>
      );
    }
    if (loading) {
      return <span className="inline-block h-5 w-24 animate-pulse rounded bg-muted" />;
    }
    return <span className="text-sm text-muted-foreground">{emptyText}</span>;
  };

  // IP 单元格副值（国家 / 状态）。country 名优先用接口给的（ip-api/ipip），
  // 缺失时（如 trace 只给 countryCode）由 countryCode 经 Intl.DisplayNames 按界面语言派生。
  const renderIpSub = (info: IpInfo | null, fallback: string) => {
    if (info && !masked) {
      const name = info.country ?? countryNameOf(info.countryCode, i18n.language);
      if (name) return name;
    }
    if (info) return fallback;
    return '';
  };

  const directInfo = ipInfo?.direct ?? null;
  const proxyInfo = running ? (ipInfo?.proxy ?? null) : null;
  const proxyEmpty = running ? t('home.ipFetchFailed') : t('home.ipNotConnected');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {t('home.networkInfo')}
            {ipInfo?.error && !loading && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-warning"
                title={t('home.ipStale', '部分出口 IP 获取失败，显示为上次结果')}
              />
            )}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={toggleMask}
              title={t('home.maskIp')}
            >
              {masked ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              title={t('home.refreshIp')}
            >
              <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {/* 本地出口 */}
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">{t('home.localExit')}</p>
            <div className="flex min-w-0 items-start gap-1.5">
              <Flag cc={masked ? undefined : directInfo?.countryCode} />
              {renderIpValue(directInfo, t('home.ipFetchFailed'))}
            </div>
            <p className="text-[11px] text-muted-foreground/70 truncate">
              {renderIpSub(directInfo, t('home.directLabel'))}
            </p>
          </div>

          {/* 代理出口 */}
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">{t('home.proxyExit')}</p>
            <div className="flex min-w-0 items-start gap-1.5">
              <Flag cc={masked ? undefined : proxyInfo?.countryCode} />
              {renderIpValue(proxyInfo, proxyEmpty)}
            </div>
            <p className="text-[11px] text-muted-foreground/70 truncate">
              {renderIpSub(proxyInfo, '')}
            </p>
          </div>

          {/* 上行 */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ArrowUp className="h-3 w-3" />
              {t('home.upload')}
            </p>
            <p className="text-base font-semibold tabular-nums">
              {formatBytes(stats?.uploadSpeed ?? 0)}/s
            </p>
            <p className="text-[11px] text-muted-foreground/70">
              {formatBytes(stats?.totalUpload ?? 0)}
            </p>
          </div>

          {/* 下行 */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ArrowDown className="h-3 w-3" />
              {t('home.download')}
            </p>
            <p className="text-base font-semibold tabular-nums">
              {formatBytes(stats?.downloadSpeed ?? 0)}/s
            </p>
            <p className="text-[11px] text-muted-foreground/70">
              {formatBytes(stats?.totalDownload ?? 0)}
            </p>
          </div>

          {/* 活动连接（2 列布局下落单 → 跨整行；5 列布局下正常单格） */}
          <div className="space-y-1 col-span-2 lg:col-span-1">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Activity className="h-3 w-3" />
              {t('home.activeConnections')}
            </p>
            <p className="text-base font-semibold tabular-nums">{stats?.activeConnections ?? 0}</p>
            <p className="text-[11px] text-muted-foreground/70">&nbsp;</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
