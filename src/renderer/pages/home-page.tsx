import { ConnectionControlCard } from '@/components/home/connection-control-card';
import { NetworkInfoCard } from '@/components/home/network-info-card';
import { ConnectionTopology } from '@/components/home/connection-topology';
import { HomeStatusBar } from '@/components/home/home-status-bar';
import { PageHeader } from '@/components/page-header';
import { useAppStore } from '@/store/app-store';
import { HomePageSkeleton } from './home-page-skeleton';
import { useTranslation } from 'react-i18next';

export function HomePage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);

  // #251 冷重建：store 未 hydrate 时 config===null → 渲统一骨架，避免各卡把「尚未加载」渲成「确定错误态」。
  // config 无 set-null 路径 →「null==未 hydrate」判据可靠；config 到达即整体切真实卡。
  if (!config) return <HomePageSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('home.pageTitle')} description={t('home.pageDesc')} />

      {/* 连接控制卡（合并原状态卡 + 代理控制卡）：出口节点 .npick + 连接圆钮三态 + 接管/分流分段 */}
      <ConnectionControlCard />

      {/* 网络信息卡：导流脊 + 双出口 IP + 遥测（保留全部功能） */}
      <NetworkInfoCard />

      {/* 连接拓扑 hero：三列桑基，随窗口高自适应 */}
      <ConnectionTopology />

      {/* 状态栏：粘底聚合当前态（出口按连接分态） */}
      <HomeStatusBar />
    </div>
  );
}
