import { ConnectionStatusCard } from '@/components/home/connection-status-card';
import { ProxyControlCard } from '@/components/home/proxy-control-card';
import { NetworkInfoCard } from '@/components/home/network-info-card';
import { ConnectionTopology } from '@/components/home/connection-topology';
import { useTranslation } from 'react-i18next';

export function HomePage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{t('home.pageTitle')}</h2>
        <p className="text-muted-foreground mt-1">{t('home.pageDesc')}</p>
      </div>

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
