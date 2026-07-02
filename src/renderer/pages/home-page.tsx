import { ConnectionStatusCard } from '@/components/home/connection-status-card';
import { ProxyControlCard } from '@/components/home/proxy-control-card';
import { NetworkInfoCard } from '@/components/home/network-info-card';
import { ConnectionTopology } from '@/components/home/connection-topology';
import { PageHeader } from '@/components/page-header';
import { useAppStore } from '@/store/app-store';
import { HomePageSkeleton } from './home-page-skeleton';
import { useTranslation } from 'react-i18next';

export function HomePage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);

  // #251 冷重建（silent 首唤 / watchdog discard 后 reopen）：store 未 hydrate 时 config===null，直接渲统一骨架，
  // 避免 ProxyControlCard(`if(!config) return null`) 致两列 grid 塌陷 + 各卡渲「确定错误态」。**单条件 config**
  // （不入 connectionStatus——refreshConnectionStatus catch 不 set，首次 IPC 失败会永久卡骨架）；config 无 set-null
  // 路径 →「null==未 hydrate」判据可靠。config 到达即整体切真实卡（ConnectionTopology 此刻才挂载订阅 aggregate，
  // 冷重建首屏本不该空订阅，正协同非回归）。
  if (!config) return <HomePageSkeleton />;

  return (
    <div className="space-y-6">
      <PageHeader title={t('home.pageTitle')} description={t('home.pageDesc')} />

      {/* 2 列阈值用 min-[900px] 而非 lg(1024)：原 lg 较宽窗口就缩单列；900px 处内容区 ~612px、每卡 ~294px 仍舒适，
          再窄(<900)才单列，避免 md(768) 把卡内 3 段控件挤窄。 */}
      <div className="grid gap-6 min-[900px]:grid-cols-2">
        <ConnectionStatusCard />
        <ProxyControlCard />
      </div>

      <NetworkInfoCard />

      <ConnectionTopology />
    </div>
  );
}
