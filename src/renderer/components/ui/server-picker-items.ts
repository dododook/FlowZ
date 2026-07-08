/**
 * `ServerConfig[]` → NodePicker `{ items, groups }` 的**单一映射**（首页出口 / 规则目标节点 / 应用分流指定节点 /
 * detour 前置代理共用），杜绝四处各自拷贝「分组 + 分组头本地化 + 哨兵置顶 + 延迟徽标 + 地址/排除/排序」逻辑漂移。
 *
 * 与 node-picker-logic 的分工：node-picker-logic 只认 NodePickerItem（与 ServerConfig 解耦、无 @shared 依赖）；
 * 本模块是「ServerConfig → NodePickerItem」的映射层，依赖 shared 分组/协议谓词。纯函数（无 react/store）——
 * 调用方喂 servers/subscriptions/latencyMap + 各处差异开关，供 .test.ts 直接覆盖等价矩阵。
 */
import type { ServerConfig, SubscriptionConfig } from '../../../shared/types';
import { groupServersBySubscription } from '../../../shared/server-grouping';
import { isEndpointProtocol, isSpeedTestable } from '../../../shared/endpoint-routes';
import { isWarpServer } from '../../../shared/warp';
import type { NodePickerGroup, NodePickerItem } from './node-picker-logic';

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
}

/**
 * 构建 NodePicker 数据模型：groupServersBySubscription 分组 → 多来源(>1 组)才显分组头 → 哨兵置顶 → 延迟徽标，
 * 按开关叠加地址 / 排除自身或组网 / 组内排序。groupId 仅在多来源时写（单一来源平铺，与各页口径一致）。
 */
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
      latencyNA: !isSpeedTestable(s),
      groupId: multi ? g.id : undefined,
    }));
  });

  const items: NodePickerItem[] = sentinel
    ? [{ id: sentinel.id, name: sentinel.name, role: sentinel.role }, ...nodeItems]
    : nodeItems;

  return { items, groups };
}
