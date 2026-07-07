import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { useTranslation } from 'react-i18next';

/**
 * 首页冷重建骨架（#251）：store 未 hydrate（config===null）期的统一占位——silent 首唤 / watchdog discard 后 reopen
 * 等冷重建路径下，避免各卡把「尚未加载」渲成「确定错误态」（尤其原 ProxyControlCard（已退役，并入 ConnectionControlCard）`if(!config) return null` 致两列
 * grid 右列塌陷 / 布局塌方，比错文本扎眼一个量级）。config 到达（HomePage 的门放行）即整体切真实卡。
 *
 * 形似真 home 布局（PageHeader 真渲 + 两列等高卡 + 网络信息卡 + 拓扑卡）→ 防 hydrate 时 CLS 跳动。
 * 复用 `animate-pulse bg-muted`（network-info-card.tsx 先例，项目无 ui/skeleton 原语）。
 * 纯展示：零 store / 零 localStorage / 零凭据 / 零缓存（不用旧态冒充当前，骨架诚实说「还没好」）。
 */
function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function HomePageSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      {/* PageHeader 不依赖 config → 真渲，与真实首屏一致 */}
      <PageHeader title={t('home.pageTitle')} description={t('home.pageDesc')} />

      {/* 连接控制卡：出口节点行 + 接管/分流两列分段（合并后单卡，与真实首屏一致防 CLS） */}
      <Card>
        <CardHeader>
          <Bar className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Bar className="h-11 flex-1" />
            <Bar className="h-12 w-12 shrink-0 rounded-full" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Bar className="h-9 w-full" />
            <Bar className="h-9 w-full" />
          </div>
        </CardContent>
      </Card>

      {/* 网络信息卡：导流脊 + 双出口 IP 网格 + 遥测行 */}
      <Card>
        <CardHeader>
          <Bar className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Bar className="h-6 w-full" />
          <div className="grid grid-cols-2 gap-4">
            <Bar className="h-12 w-full" />
            <Bar className="h-12 w-full" />
          </div>
          <Bar className="h-4 w-2/3" />
        </CardContent>
      </Card>

      {/* 连接拓扑卡：图表区 */}
      <Card>
        <CardHeader>
          <Bar className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Bar className="h-40 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
