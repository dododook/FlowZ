/**
 * ExitNodeField 的纯映射逻辑（tailnet peers → NodePicker items）—— 从组件抽出，零 react/store/i18n 运行时依赖
 * （仅 import type，编译期擦除），供 jest 直测「排序 / ip·hostName 双匹配 / disabled 判据(豁免当前配置) / note 拼装」矩阵。
 *
 * 迁 NodePicker(.npick) 背景：原实现用 radix Select 受控 value + onValueChange，form.reset / peer 流刷新会触发一次
 * 伪 onValueChange(回退 NONE) 把已配置 exit_node 静默清空，故需 interacted 守卫。NodePicker 基于 dropdown-menu、
 * 无受控 value/onValueChange 路径（value 只驱动回填✓、变更不回调），结构性免疫该伪回调 → 守卫已删。
 */
import type { TailscaleStatusPeer } from '../../../../shared/tailscale-status';
import type { NodePickerItem } from '../../ui/node-picker-logic';

// 哨兵值（不与任何 100.x IP 撞）。
export const NONE = '__none__';
export const CUSTOM = '__custom__';

/** peer 行状态文案（i18n 已译入）——由组件传入，保持本模块纯。 */
export interface ExitNodeLabels {
  none: string;
  custom: string;
  inUse: string;
  offline: string;
  notAdvertised: string;
}

/**
 * 排序：可作出口优先 → 在线优先 → 名称。仅含非空 ip 的 peer（NodePicker item id 用 ip，不可为空）。
 */
export function sortPeers(peers: TailscaleStatusPeer[]): TailscaleStatusPeer[] {
  return peers
    .filter((p) => !!p.ip)
    .slice()
    .sort((a, b) => {
      if (a.exitNodeOption !== b.exitNodeOption) return a.exitNodeOption ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.hostName || '').localeCompare(b.hostName || '');
    });
}

/**
 * 单个 peer 是否命中配置值（ip 或 hostName 双匹配）——单一真值，供 matchPeer 与 peerDisabled 复用，
 * 杜绝两处各写一套双匹配条件而漂移。sing-box exit_node 合法接受 IP 或 hostname。
 */
export function peerMatches(peer: TailscaleStatusPeer, trimmed: string): boolean {
  return peer.ip === trimmed || peer.hostName === trimmed;
}

/**
 * 按 ip 或主机名匹配：sing-box exit_node 合法接受 IP 或 hostname，故 hostname 配置也命中其设备行
 * （不被误判为自定义）。空 trimmed → undefined。
 */
export function matchPeer(
  peers: TailscaleStatusPeer[],
  trimmed: string
): TailscaleStatusPeer | undefined {
  if (!trimmed) return undefined;
  return peers.find((p) => peerMatches(p, trimmed));
}

/**
 * 是否禁用（不可选）：非广告出口 且 非当前已配置项。**当前配置项恒豁免**——保证已配置行始终可选/可回填✓，
 * 不因对端一时未广告出口而无法显示/重选。
 */
export function peerDisabled(peer: TailscaleStatusPeer, trimmed: string): boolean {
  return !peer.exitNodeOption && !peerMatches(peer, trimmed);
}

/** 名称后补充说明：ip · [使用中 / 离线 / 未广告出口]（各条件独立叠加，以 ' · ' 连接）。 */
export function peerNote(peer: TailscaleStatusPeer, labels: ExitNodeLabels): string {
  const parts = [peer.ip];
  if (peer.exitNode) parts.push(labels.inUse);
  if (!peer.online) parts.push(labels.offline);
  if (!peer.exitNodeOption) parts.push(labels.notAdvertised);
  return parts.join(' · ');
}

/**
 * peers(已 sortPeers) → NodePicker items：`[无, ...设备, 自定义]`。
 * - 无：清空 exit_node（role='none' → 灰点）；自定义：切文本框录入。
 * - 设备项：id=ip、name=hostName||ip、address=ip（触发器副文本 + 参与搜索）、dotTone=online?mesh:idle、
 *   note=ip·状态、disabled=peerDisabled。
 */
export function peersToItems(
  sortedPeers: TailscaleStatusPeer[],
  trimmed: string,
  labels: ExitNodeLabels
): NodePickerItem[] {
  return [
    { id: NONE, name: labels.none, role: 'none' },
    ...sortedPeers.map<NodePickerItem>((p) => ({
      id: p.ip,
      name: p.hostName || p.ip,
      address: p.ip,
      dotTone: p.online ? 'mesh' : 'idle',
      note: peerNote(p, labels),
      disabled: peerDisabled(p, trimmed),
    })),
    { id: CUSTOM, name: labels.custom },
  ];
}
