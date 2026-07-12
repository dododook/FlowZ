/**
 * `ServerConfig[]` → NodePicker `{ items, groups }` 的**单一映射**（首页出口 / 规则目标节点 / 应用分流指定节点 /
 * detour 前置代理共用），杜绝四处各自拷贝「分组 + 分组头本地化 + 哨兵置顶 + 延迟徽标 + 地址/排除/排序」逻辑漂移。
 *
 * 与 node-picker-logic 的分工：node-picker-logic 只认 NodePickerItem（与 ServerConfig 解耦、无 @shared 依赖）；
 * 本模块是「ServerConfig → NodePickerItem」的映射层，依赖 shared 分组/协议谓词。纯函数（无 react/store）——
 * 调用方喂 servers/subscriptions/latencyMap + 各处差异开关，供 .test.ts 直接覆盖等价矩阵。
 */
import type { ServerConfig, SubscriptionConfig, ProxyExitBlock } from '../../../shared/types';
import { groupServersBySubscription } from '../../../shared/server-grouping';
import { isEndpointProtocol, isSpeedTestable } from '../../../shared/endpoint-routes';
import { isWarpServer } from '../../../shared/warp';
import { deriveLatencyBadge } from '../../lib/latency-badge';
import type { NodePickerGroup, NodePickerItem } from './node-picker-logic';

/**
 * 徽标异常态输入（可选）：调用方（首页出口下拉）传入 TS 登录态 / 选中出口 / 出口直判无效 + 已本地化的文案，
 * 使下拉里 TS/组网节点也显「出口无效 / 未登录」warn 文案（与 SpeedBadge 同 deriveLatencyBadge 口径）。
 * 缺省（不传）→ 行为不变（规则页/分流页等调用方无需登录/出口态，可后续增量接入）。纯函数（labels 已本地化传入）。
 */
export interface ServerPickerBadgeOptions {
  /** store.tailscaleLoginStates：节点 id → 综合登录态。 */
  tsLoggedIn: Record<string, boolean>;
  /** config.selectedServerId（proxyBlocked 仅对选中出口有语义）。 */
  selectedServerId?: string;
  /** connectionStatus.proxyCore.running。 */
  proxyRunning: boolean;
  /** store.ipInfo?.proxyBlocked（TS 出口 API 直判无效）。 */
  proxyBlocked?: ProxyExitBlock;
  /** 已本地化「出口无效」文案（t('home.exitInvalid')）。 */
  exitInvalidLabel: string;
  /** 已本地化「未登录」文案（t('servers.tsNotLoggedIn')）。 */
  notLoggedInLabel: string;
}

/** 节点显示地址（触发器副文本 + 参与搜索）：无地址回退 undefined。 */
export function nodeAddress(s: ServerConfig): string | undefined {
  if (!s.address) return undefined;
  return s.port ? `${s.address}:${s.port}` : s.address;
}

/**
 * 节点是否为有效候选项（排除自身 excludeId + 可选排除组网协议）——**单一真值**：buildServerPickerModel 的入列过滤
 * 与调用方的「悬挂选择检测」（如 detour 目标已删/被过滤 → 回落直连）共用，杜绝两处各写一套过滤条件而漂移。
 */
export function isPickerCandidate(
  s: ServerConfig,
  excludeId?: string,
  excludeEndpoint?: boolean
): boolean {
  return s.id !== excludeId && !(excludeEndpoint && isEndpointProtocol(s.protocol));
}

/**
 * 置顶哨兵项（直连 / 跟随全局）。id 与各页语义一致（首页 DIRECT_SERVER_ID / detour DETOUR_DIRECT /
 * 规则 FOLLOW_GLOBAL_NODE_ID）；无 groupId → 落无分组桶恒置顶。缺省表示该页无哨兵（如应用分流「指定节点」）。
 */
export interface ServerPickerSentinel {
  id: string;
  name: string;
  role: 'direct' | 'follow';
}

export interface BuildServerPickerModelOptions {
  servers: ServerConfig[];
  subscriptions: SubscriptionConfig[];
  /** 节点 id → 延迟 ms（>=0 有效 / -1 超时 / undefined 未测）。 */
  latencyMap: Record<string, number | undefined>;
  /** 组网组分组头文案（本地化）。 */
  meshLabel: string;
  /** 自建组分组头文案（本地化）；订阅组用 group.name。 */
  manualLabel: string;
  /** 置顶哨兵项；缺省无哨兵。 */
  sentinel?: ServerPickerSentinel;
  /** 排除的节点 id（如 detour 排除自身，避免自我链）。 */
  excludeId?: string;
  /** 排除组网协议节点（detour 不作前置代理目标）。 */
  excludeEndpoint?: boolean;
  /** 是否附节点地址（触发器副文本 + 搜索）；缺省不附。 */
  withAddress?: boolean;
  /** 组内节点排序（如首页按延迟排序）；缺省保序。 */
  sortServers?: (servers: ServerConfig[]) => ServerConfig[];
  /** 徽标异常态输入（首页出口下拉传入使 TS 显「出口无效/未登录」）；缺省不显异常态文案。 */
  badge?: ServerPickerBadgeOptions;
  /** 本会话是否点过全量测速（store.speedTestAttempted）：未点过则不可测节点 latencyNA=false（显「—」同未测），
   *  点过才 latencyNA=true（显「不支持测速」）。**缺省 true = 既有行为**（规则/分流页调用方无需登录态，保持原样）。 */
  speedTestAttempted?: boolean;
}

/**
 * 构建 NodePicker 数据模型：groupServersBySubscription 分组 → 多来源(>1 组)才显分组头 → 哨兵置顶 → 延迟徽标，
 * 按开关叠加地址 / 排除自身或组网 / 组内排序。groupId 仅在多来源时写（单一来源平铺，与各页口径一致）。
 */
/**
 * 单节点异常态文案（出口无效/未登录）→ 已本地化字符串；正常态返 undefined（走既有 latency/latencyNA 渲染）。
 * 复用 deriveLatencyBadge 口径（与 SpeedBadge 一致）；testedAt/now 对这两 kind 无关（P1/P2 分支不读），传 0。
 */
function statusLabelFor(
  s: ServerConfig,
  latency: number | undefined,
  badge: ServerPickerBadgeOptions
): string | undefined {
  const b = deriveLatencyBadge({
    server: s,
    latency,
    testedAt: undefined,
    now: 0,
    tsLoggedIn: badge.tsLoggedIn[s.id],
    isSelectedExit: badge.selectedServerId === s.id,
    proxyRunning: badge.proxyRunning,
    proxyBlocked: badge.proxyBlocked,
  });
  if (b.kind === 'exit-invalid') return badge.exitInvalidLabel;
  if (b.kind === 'not-logged-in') return badge.notLoggedInLabel;
  return undefined;
}

export function buildServerPickerModel(opts: BuildServerPickerModelOptions): {
  items: NodePickerItem[];
  groups: NodePickerGroup[];
} {
  const {
    servers,
    subscriptions,
    latencyMap,
    meshLabel,
    manualLabel,
    sentinel,
    excludeId,
    excludeEndpoint,
    withAddress,
    sortServers,
    badge,
    speedTestAttempted = true,
  } = opts;

  const filtered = servers.filter((s) => isPickerCandidate(s, excludeId, excludeEndpoint));
  const serverGroups = groupServersBySubscription(filtered, subscriptions);
  // 多来源才显分组头（单一来源平铺，不显冗余分组头）。
  const multi = serverGroups.length > 1;

  const groups: NodePickerGroup[] = multi
    ? serverGroups.map((g) => ({
        id: g.id,
        label: g.isMesh ? meshLabel : g.isManual ? manualLabel : g.name,
      }))
    : [];

  const nodeItems = serverGroups.flatMap((g) => {
    const list = sortServers ? sortServers(g.servers) : g.servers;
    return list.map<NodePickerItem>((s) => ({
      id: s.id,
      name: s.name,
      // WARP 基于 wireguard 但语义独立 → 角标显 'warp' 而非叠加 'wireguard'（用户反馈；小写与 vless/trojan 等协议名一致，
      // 不用大写 'WARP' 以免下拉里唯一大写显突兀；isWarpServer 兜底旧/导入无标记 WARP）。
      protocol: isWarpServer(s) ? 'warp' : s.protocol,
      address: withAddress ? nodeAddress(s) : undefined,
      latency: latencyMap[s.id],
      // 不可测节点：未点过全量测速时 latencyNA=false（显「—」同未测，口径同步）；点过才 true（显「不支持测速」）。
      // §16.1 path-aware：TS-exit 仅主核池可用（badge.proxyRunning）时可测；badge 缺省（规则/分流页）→ proxyRunning=false。
      latencyNA: !isSpeedTestable(s, { mainCorePool: badge?.proxyRunning ?? false }) && speedTestAttempted,
      // 异常态文案（仅传 badge 时）：出口无效/未登录 → warn 文案压过延迟。这两 kind 时间无关，statusLabelFor 内 now:0 无害。
      statusLabel: badge ? statusLabelFor(s, latencyMap[s.id], badge) : undefined,
      groupId: multi ? g.id : undefined,
    }));
  });

  const items: NodePickerItem[] = sentinel
    ? [{ id: sentinel.id, name: sentinel.name, role: sentinel.role }, ...nodeItems]
    : nodeItems;

  return { items, groups };
}
