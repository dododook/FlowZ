import { ConnectionControlCard } from '@/components/home/connection-control-card';
import { ConnectionTopology } from '@/components/home/connection-topology';
import { useAppStore } from '@/store/app-store';
import { HomePageSkeleton } from './home-page-skeleton';
import { useTranslation } from 'react-i18next';

const TAKEOVER_LABEL_KEY: Record<string, string> = {
  systemProxy: 'home.takeoverSystemProxy',
  tun: 'home.takeoverTun',
  manual: 'home.takeoverManual',
};
const ROUTING_LABEL_KEY: Record<string, string> = {
  smart: 'home.routingSmart',
  global: 'home.routingGlobal',
  direct: 'home.routingDirect',
};

/**
 * 页头 `.sub` 实时摘要：接管方式 · 分流策略 · 运行时长（仅连接态且有 uptime）。
 * 独立订阅 connectionStatus 的 running/uptime（uptime 每 ~2s 变）——隔离在本小组件内，
 * 使轮询重渲不外溢到 HomePage / ConnectionTopology（沿用拓扑 F17 隔离意图）。
 */
function HomeHeaderSub() {
  const { t } = useTranslation();
  const proxyModeType = useAppStore(
    (s) => s.config?.proxyModeType || s.connectionStatus?.proxyModeType || 'systemProxy'
  );
  const proxyMode = useAppStore((s) => s.config?.proxyMode || 'smart');
  const running = useAppStore((s) => s.connectionStatus?.proxyCore?.running ?? false);
  const uptime = useAppStore((s) => s.connectionStatus?.proxyCore?.uptime);

  const parts = [
    t(TAKEOVER_LABEL_KEY[proxyModeType] ?? 'home.takeoverSystemProxy'),
    t(ROUTING_LABEL_KEY[proxyMode] ?? 'home.routingSmart'),
    running && uptime ? t('home.uptime', { min: Math.floor(uptime / 60) }) : '',
  ].filter(Boolean);

  return <span className="sub">{parts.join(' · ')}</span>;
}

export function HomePage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);

  // #251 冷重建：store 未 hydrate 时 config===null → 渲统一骨架，避免各卡把「尚未加载」渲成「确定错误态」。
  // config 无 set-null 路径 →「null==未 hydrate」判据可靠；config 到达即整体切真实卡。
  if (!config) return <HomePageSkeleton />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-page="home">
      <div className="page-h">
        <h1>{t('home.pageTitle')}</h1>
        <HomeHeaderSub />
      </div>

      {/* 连接控制卡（合并原状态卡 + 代理控制卡）：出口节点 .npick + 连接圆钮三态 + 接管/分流 seg2 */}
      <ConnectionControlCard />

      {/* 连接拓扑 hero：三列桑基前置为视觉主体，随窗口高自适应。状态栏已固化为窗口级底栏（main-layout） */}
      <ConnectionTopology />
    </div>
  );
}
