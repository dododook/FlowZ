import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { EyeOff } from 'lucide-react';
import { ConnectionsTable } from '@/components/connections/connections-table';
import { shouldHideForPrivacy } from '@/components/connections/connection-utils';

/**
 * 连接信息页：复用 main 单一 poller 的连接快照（connectionsApi），逐条展示活动连接 + per-conn 速率差分。
 * 隐私模式屏蔽：连接表含 sourceIP/processPath 敏感信息，isPrivacyMode 激活时不渲染明细（决策）——
 * 既避免敏感数据进 DOM（防御纵深，PrivacyOverlay 之外再设一道），也明示用户该页在隐私态不可用。
 *
 * 布局（Conduit `data-page="conns"`）：页根为定高 flex 列（page-h · conns-bar · conns-card 顺序，gap 16px），
 * conns-card `flex:1` 自身内部滚动、截断脚注常驻卡底。定高经 100vh 减去标题栏 + 底部留白得出（容器非 flex-1，
 * 沿用首页拓扑 hero 的视口相对策略），保证宽表在卡内滚动而非整页滚动。
 */
export function ConnectionsPage() {
  const { t } = useTranslation();
  const isPrivacyMode = useAppStore((s) => s.isPrivacyMode);
  const hidden = shouldHideForPrivacy(isPrivacyMode);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-page="conns">
      <div className="page-h">
        <h1>{t('connections.pageTitle')}</h1>
        <span className="sub">{t('connections.pageDesc')}</span>
      </div>

      {hidden ? (
        <div className="card flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
          <EyeOff className="h-7 w-7" style={{ color: 'hsl(var(--fg-dim))' }} />
          <span className="text-[13px]" style={{ color: 'hsl(var(--fg-faint))' }}>
            {t('connections.privacyHidden')}
          </span>
        </div>
      ) : (
        <ConnectionsTable />
      )}
    </div>
  );
}
