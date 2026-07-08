/**
 * 测速结果徽标（延迟 ms / 超时 / 不可测 N/A）—— Conduit `.nd-lat` 形态，卡首行右上角展示（与原型一致）。
 * 卡片视图与列表视图共用同一组件；测速态/不可测口径与 ServerActions 一致（isSpeedTestable 单一真值 + latencyMap），
 * 纯展示无副作用。色档委托 latToneClass（与 getLatencyColor 同阈值单一真值）。
 */
import { useTranslation } from 'react-i18next';
import { isSpeedTestable } from '../../../shared/endpoint-routes';
import { latToneClass, type ServerConfigWithId } from './server-list-helpers';
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
  // 不可测节点（Tailscale / 自定义 endpoint / reverseMesh）：显不可测占位（faint），与 ServerActions ⚡ 隐藏同口径。
  const testable = isSpeedTestable(server);
  if (!testable) {
    return (
      <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
        {t('servers.speedTestNotApplicable')}
      </span>
    );
  }
  const latency = latencyMap[server.id];
  // 未测速：占位 em dash（faint），与原型 pending 卡「—」一致（不隐藏，保持卡首行右侧对齐）。
  if (latency === undefined) {
    return (
      <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
        —
      </span>
    );
  }
  // 陈旧（会话内久未重测）→ 半透明提示「需重测」，title 给绝对测速时间；新鲜则正常显色。
  const stale = testedAt !== undefined && Date.now() - testedAt > STALE_MS;
  const title = testedAt ? new Date(testedAt).toLocaleString() : undefined;
  if (latency === -1) {
    return (
      <span className={`nd-lat err mono ${stale ? 'opacity-50' : ''}`} title={title}>
        {t('servers.timeout')}
      </span>
    );
  }
  return (
    <span
      className={`nd-lat ${latToneClass(latency)} mono tnum ${stale ? 'opacity-50' : ''}`}
      title={title}
    >
      {latency}
      <i>ms</i>
    </span>
  );
}
