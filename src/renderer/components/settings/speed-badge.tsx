/**
 * 测速结果徽标（延迟 ms / 超时 / 不可测 N/A）—— 从 ServerActions 抽出（#59）。
 * 原先内联在节点卡名称行的操作按钮组里，出结果时把名称挤折叠；移到卡片右下角（传输/加密行）统一展示，
 * 名称行不再被挤。卡片视图与列表视图共用同一组件，两视图测速结果位置对齐。
 * 测速态/不可测口径与 ServerActions 一致（isSpeedTestable 单一真值 + latencyMap），纯展示无副作用。
 */
import { useTranslation } from 'react-i18next';
import { isSpeedTestable } from '../../../shared/endpoint-routes';
import { getLatencyColor, getLatencyBg, type ServerConfigWithId } from './server-list-helpers';
import { useAppStore } from '../../store/app-store';

/** 陈旧阈值：会话内超此时长未重测视为旧值 → dim 提示需重测（延迟仅会话内存态，重启清空）。 */
const STALE_MS = 30 * 60 * 1000;

export function SpeedBadge({
  server,
  latencyMap,
}: {
  server: ServerConfigWithId;
  latencyMap: Record<string, number>;
}) {
  const { t } = useTranslation();
  // 该节点最近测速时间戳（自读 store，使列表/下拉/详情各处徽标一致获得陈旧标识，无需逐层透传 prop）。
  const testedAt = useAppStore((s) => s.latencyTestedAt[server.id]);
  // 不可测节点（Tailscale / 自定义 endpoint / reverseMesh）：显「N/A」，与 ServerActions ⚡ 禁用同口径。
  const testable = isSpeedTestable(server);
  if (!testable) {
    return (
      <span className="text-xs font-medium px-1.5 py-0.5 rounded text-muted-foreground">
        {t('servers.speedTestNotApplicable')}
      </span>
    );
  }
  const latency = latencyMap[server.id];
  if (latency === undefined) return null;
  // 陈旧（会话内久未重测）→ 半透明提示「需重测」，title 给绝对测速时间；新鲜则正常显色。
  const stale = testedAt !== undefined && Date.now() - testedAt > STALE_MS;
  return (
    <span
      className={`text-xs font-medium px-1.5 py-0.5 rounded ${getLatencyColor(latency)} ${getLatencyBg(latency)} ${stale ? 'opacity-50' : ''}`}
      title={testedAt ? new Date(testedAt).toLocaleString() : undefined}
    >
      {latency === -1 ? t('servers.timeout') : `${latency} ms`}
    </span>
  );
}
