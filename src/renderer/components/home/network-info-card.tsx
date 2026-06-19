import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { formatBytes } from '@/lib/format';
import { Eye, EyeOff, RotateCw, Globe, ArrowUp, ArrowDown, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { IpInfo } from '@/bridge/types';
import { deriveSpineVisual, type SpineState } from './spine-state';

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

/** 导流连接线：连上=live 绿 + 流动光点（motion-safe，reduced-motion 下静止）；未连=暗线。 */
function ConduitLink({ state }: { state: SpineState }) {
  if (state === 'fault') {
    // 断点段:琥珀虚线、无流光——与上游绿色活路对比,读作「流到这里断了」。
    return (
      <div className="relative h-px flex-1">
        <div className="h-0 w-full border-t border-dashed border-warning/70" />
      </div>
    );
  }
  if (state === 'flow') {
    return (
      <div className="relative h-px flex-1">
        <div className="h-px w-full bg-success/40" />
        <span className="absolute top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-success shadow-[0_0_6px] shadow-success motion-safe:animate-conduit-flow" />
      </div>
    );
  }
  return (
    <div className="relative h-px flex-1">
      <div className="h-px w-full bg-border" />
    </div>
  );
}

/** 单条遥测:icon + mono 主值 + 副标签。上行/下行/活动连接共用,色由 color token 一处传入。 */
function TelemetryStat({
  icon: Icon,
  color,
  value,
  sub,
  subMono = true,
}: {
  icon: typeof ArrowUp;
  color: string;
  value: string;
  sub: string;
  subMono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={`h-3.5 w-3.5 ${color}`} />
      <span className={`font-mono text-base font-semibold tabular-nums ${color}`}>{value}</span>
      <span
        className={
          subMono
            ? 'font-mono text-[11px] tabular-nums text-muted-foreground/70'
            : 'text-xs text-muted-foreground'
        }
      >
        {sub}
      </span>
    </div>
  );
}

export function NetworkInfoCard() {
  const { t, i18n } = useTranslation();
  const ipInfo = useAppStore((s) => s.ipInfo);
  const stats = useAppStore((s) => s.stats);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const refreshStatistics = useAppStore((s) => s.refreshStatistics);

  const running = connectionStatus?.proxyCore?.running ?? false;
  const loading = ipInfo?.loading ?? false;

  // 导流脊三态。降级=连上但出口 IP 探测异常(error==='fetch_failed'),复用 IP 卡标题黄点的同源信号——
  // 仅 running 时对脊有意义(未连时 error 是直连探测失败,与代理路径无关)。loading 中暂不判降级,等探测落定。
  // error 是「本地+代理出口」探测的并集(IpInfoService.doRefresh),故末段琥珀是「出口探测降级」的保守提示,
  // 非「外网确定不可达」;proxy 探测失败会保留旧 IP 值,故只能靠 error 判降级,不能靠 proxy 是否为空。
  const degraded = running && !!ipInfo?.error && !loading;
  const spine = deriveSpineVisual(running, degraded);
  // 端点色档→class。健康连通末端低强度 success(读作「已抵达」;高饱和绿仍留给流光+出口节点);降级转 warning;离线 muted。
  const internetColor =
    spine.internet === 'warning'
      ? 'text-warning'
      : spine.internet === 'success'
        ? 'text-success'
        : 'text-muted-foreground';

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
  // 最终态（重试耗尽仍无值）友好提示，不再用刺眼的「获取失败」：运行中→代理出口暂不可用；未运行→未连接。
  const proxyEmpty = running ? t('home.ipProxyUnavailable') : t('home.ipNotConnected');

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
        {/* 导流脊:你 ● ── 出口 ◉(连上 live 绿锁定) ── Internet。签名,数据见下方 IP 详情。
            端点中性提亮(非染绿)、降级末段转琥珀虚线;绿色专留给流光+出口节点,保视觉主次。 */}
        <div className="mb-5 flex items-center gap-2.5 px-1">
          <span className="shrink-0 text-xs font-medium">{t('home.myDevice')}</span>
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full border ${spine.youDotLit ? 'border-foreground/60' : 'border-muted-foreground/50'}`}
          />
          <ConduitLink state={spine.leg1} />
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${running ? 'border-success shadow-[0_0_8px] shadow-success/40' : 'border-muted-foreground/40'}`}
            title={t('home.proxyExit')}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-success motion-safe:animate-pulse' : 'bg-muted-foreground/40'}`}
            />
          </span>
          <ConduitLink state={spine.leg2} />
          <Globe className={`h-4 w-4 shrink-0 ${internetColor}`} />
          <span
            className={`shrink-0 text-xs ${internetColor}`}
            title={degraded ? t('home.ipStale', '部分出口 IP 获取失败，显示为上次结果') : undefined}
          >
            Internet
          </span>
        </div>

        {/* IP 详情:本地出口 / 代理出口（含国旗 + IP + 地区，保留全部信息） */}
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">{t('home.localExit')}</p>
            <div className="flex min-w-0 items-start gap-1.5">
              <Flag cc={masked ? undefined : directInfo?.countryCode} />
              {renderIpValue(directInfo, t('home.ipNoInternet'))}
            </div>
            <p className="truncate text-[11px] text-muted-foreground/70">
              {renderIpSub(directInfo, t('home.directLabel'))}
            </p>
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">{t('home.proxyExit')}</p>
            <div className="flex min-w-0 items-start gap-1.5">
              <Flag cc={masked ? undefined : proxyInfo?.countryCode} />
              {renderIpValue(proxyInfo, proxyEmpty)}
            </div>
            <p className="truncate text-[11px] text-muted-foreground/70">
              {renderIpSub(proxyInfo, '')}
            </p>
          </div>
        </div>

        {/* 遥测:上行 / 下行 / 活动连接（mono + tabular） */}
        <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border/60 pt-3">
          <TelemetryStat
            icon={ArrowUp}
            color="text-info"
            value={`${formatBytes(stats?.uploadSpeed ?? 0)}/s`}
            sub={formatBytes(stats?.totalUpload ?? 0)}
          />
          <TelemetryStat
            icon={ArrowDown}
            color="text-success"
            value={`${formatBytes(stats?.downloadSpeed ?? 0)}/s`}
            sub={formatBytes(stats?.totalDownload ?? 0)}
          />
          <TelemetryStat
            icon={Activity}
            color="text-warning"
            value={String(stats?.activeConnections ?? 0)}
            sub={t('home.activeConnections')}
            subMono={false}
          />
        </div>
      </CardContent>
    </Card>
  );
}
