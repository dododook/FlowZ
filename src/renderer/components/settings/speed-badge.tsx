/**
 * 测速结果徽标（延迟 ms / 超时 / 不可测 N/A / 出口无效 / 未登录）—— Conduit `.nd-lat` 形态，卡首行右上角展示。
 * 卡片视图与列表视图共用同一组件；态由 deriveLatencyBadge 单一真值派生（含 TS 出口态/登录态输入），纯展示无副作用。
 * 色档委托 latToneClass（与 getLatencyColor 同阈值单一真值）；异常态（出口无效/未登录）用 --warn 文案替代假延迟。
 */
import { useTranslation } from 'react-i18next';
import { latToneClass, type ServerConfigWithId } from './server-list-helpers';
import { useAppStore } from '../../store/app-store';
import { deriveLatencyBadge } from '../../lib/latency-badge';
import { ActionTip } from '../ui/tooltip';
import type { ProxyExitBlock } from '../../../shared/types';

/** TS 出口无效三原因 → title 文案键（复用首页 ts-exit-warning 长句，给悬停行动指引）。 */
const EXIT_BLOCK_TITLE_KEY: Record<ProxyExitBlock, string> = {
  'ts-no-exit-device': 'home.tsExitNoDeviceWarn',
  'ts-exit-device-offline': 'home.tsExitDeviceOfflineWarn',
  'ts-exit-not-advertised': 'home.tsExitNotAdvertisedWarn',
};

export function SpeedBadge({
  server,
  latencyMap,
}: {
  server: ServerConfigWithId;
  latencyMap: Record<string, number>;
}) {
  const { t } = useTranslation();
  // 徽标态的全部输入自读 store（testedAt/登录态/选中/运行/出口直判无效），使列表/下拉/详情各处徽标口径一致，无需逐层透传。
  const testedAt = useAppStore((s) => s.latencyTestedAt[server.id]);
  const tsLoggedIn = useAppStore((s) => s.tailscaleLoginStates[server.id]);
  const isSelectedExit = useAppStore((s) => s.config?.selectedServerId === server.id);
  const proxyRunning = useAppStore((s) => !!s.connectionStatus?.proxyCore?.running);
  const proxyBlocked = useAppStore((s) => s.ipInfo?.proxyBlocked);
  const speedTestAttempted = useAppStore((s) => s.speedTestAttempted);
  const notInPool = useAppStore((s) => s.speedTestNotInPool.has(server.id));
  // §2 待应用差集（实时数据源，优先于延迟徽标）：改=待生效（运行核仍跑旧参数、延迟值失真），增=待入池（未入核不可测）。
  const pendingModified = useAppStore((s) => s.pendingChanges.modified.includes(server.id));
  const pendingAdded = useAppStore((s) => s.pendingChanges.added.includes(server.id));

  // 已编辑未生效（dirty）：运行核仍是旧参数，展示的延迟属旧配置 → 显性「待生效」替代失真延迟，tooltip 给生效路径。
  if (pendingModified) {
    return (
      <ActionTip
        label={t('servers.speedTestNodeDirty', {
          defaultValue: '节点参数已修改但内核尚未应用；重启内核或点「立即应用」后生效',
        })}
      >
        <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
          {t('servers.speedTestPendingEffect', { defaultValue: '待生效' })}
        </span>
      </ActionTip>
    );
  }

  const badge = deriveLatencyBadge({
    server,
    latency: latencyMap[server.id],
    testedAt,
    now: Date.now(),
    tsLoggedIn,
    isSelectedExit,
    proxyRunning,
    proxyBlocked,
    speedTestAttempted,
    // §2：pending.added（实时未入核）并入 not-in-pool → 复用既有「待入池」徽标路径，不改 deriveLatencyBadge 纯函数。
    notInPool: notInPool || pendingAdded,
  });

  switch (badge.kind) {
    // 结构性不可用 → --warn 文案替代假延迟（用户诉求）。出口无效 title 按原因细分给行动指引。
    case 'exit-invalid':
      return (
        <ActionTip label={t(EXIT_BLOCK_TITLE_KEY[badge.reason])}>
          <span className="nd-lat mono" style={{ color: 'hsl(var(--warn))' }}>
            {t('home.exitInvalid', '出口无效')}
          </span>
        </ActionTip>
      );
    case 'not-logged-in':
      return (
        <span className="nd-lat mono" style={{ color: 'hsl(var(--warn))' }}>
          {t('servers.tsNotLoggedIn', '未登录')}
        </span>
      );
    // 不可测且无值：faint 占位。§16.1 reason=ts-needs-core（TS-exit 代理关，只是缺主核）→ 显「—」+ tooltip「连接代理后可测速」；
    // 否则恒不可测三类 → 「不支持测速」+ exitProbeHint（选为出口后伴测得真值，非永远测不了）。
    case 'na':
      return badge.reason === 'ts-needs-core' ? (
        <ActionTip label={t('servers.speedTestTsNeedsCore', { defaultValue: '连接代理后可测速' })}>
          <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
            —
          </span>
        </ActionTip>
      ) : (
        <ActionTip label={t('servers.exitProbeHint')}>
          <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
            {t('servers.speedTestNotApplicable')}
          </span>
        </ActionTip>
      );
    // 可测未测。reason=not-in-pool（新增节点未写入运行核）→ 显性「待入池」替代「—」（原生 title 的解释在 Electron 下常看不到）；
    // tooltip 给真实入池路径（选中该节点或重启内核，**非**「刷新订阅」——纯新增走 P2-A 免重启）。纯未测（未点测速）→ 占位「—」、无 tooltip。
    case 'untested':
      if (badge.reason === 'not-in-pool')
        return (
          <ActionTip
            label={t('servers.speedTestNodePending', {
              defaultValue: '新增节点尚未写入运行内核；选中该节点或重启内核后纳入测速',
            })}
          >
            <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
              {t('servers.speedTestPendingPool', { defaultValue: '待入池' })}
            </span>
          </ActionTip>
        );
      return (
        <span className="nd-lat mono" style={{ color: 'hsl(var(--fg-faint))' }}>
          —
        </span>
      );
    // 陈旧（会话内久未重测）→ 半透明提示「需重测」，title 给绝对测速时间；新鲜则正常显色。
    case 'timeout': {
      const title = testedAt ? new Date(testedAt).toLocaleString() : undefined;
      return (
        <span className={`nd-lat err mono ${badge.stale ? 'opacity-50' : ''}`} title={title}>
          {t('servers.timeout')}
        </span>
      );
    }
    case 'value': {
      const title = testedAt ? new Date(testedAt).toLocaleString() : undefined;
      return (
        <span
          className={`nd-lat ${latToneClass(badge.latency)} mono tnum ${badge.stale ? 'opacity-50' : ''}`}
          title={title}
        >
          {badge.latency}
          <i>ms</i>
        </span>
      );
    }
  }
}
