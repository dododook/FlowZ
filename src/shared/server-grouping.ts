import type { ServerConfig, SubscriptionConfig } from './types';
import { isEndpointProtocol } from './endpoint-routes';

/**
 * 节点分组（自建 + 组网 + 各订阅），供托盘菜单 / 节点选择器 / 节点列表页 tab / 任意需要「分组」展示处共用，
 * **单一真值**——杜绝各处各自分组导致「列表页归组网、下拉/托盘归自建」的口径漂移。
 */
export interface ServerGroup {
  /** 'manual' / 'mesh' / 订阅 id */
  id: string;
  /** 订阅组=订阅名（直接展示）；自建/组网组=占位 'manual'/'mesh'，**消费方一律按 isManual/isMesh 本地化、不读 name**。 */
  name: string;
  isManual: boolean;
  /** 组网组（WireGuard/WARP/Tailscale 等 endpoint 协议）：调用方本地化为「组网」。 */
  isMesh?: boolean;
  servers: ServerConfig[];
}

/**
 * 把节点按归属分组：自建（无 subscriptionId，或 subscriptionId 指向已删订阅的孤儿）→ 再拆出**组网**
 * （endpoint 协议 WireGuard/WARP/Tailscale）独立成组，置于自建之后；其后每个订阅一组。空组省略，
 * 顺序：自建 → 组网 → 各订阅（与订阅入参一致），与节点列表页 tab 顺序一致。
 */
export function groupServersBySubscription(
  servers: ServerConfig[],
  subscriptions: SubscriptionConfig[] = []
): ServerGroup[] {
  const knownIds = new Set(subscriptions.map((s) => s.id));
  const groups: ServerGroup[] = [];

  // 自建 = 无归属 或 归属订阅已不存在（孤儿不丢，并入自建）；再按 endpoint 协议拆出「组网」。
  const manualAll = servers.filter((s) => !s.subscriptionId || !knownIds.has(s.subscriptionId));
  const manual = manualAll.filter((s) => !isEndpointProtocol(s.protocol));
  const mesh = manualAll.filter((s) => isEndpointProtocol(s.protocol));
  if (manual.length > 0) {
    groups.push({ id: 'manual', name: 'manual', isManual: true, servers: manual });
  }
  if (mesh.length > 0) {
    groups.push({ id: 'mesh', name: 'mesh', isManual: false, isMesh: true, servers: mesh });
  }

  for (const sub of subscriptions) {
    const subServers = servers.filter((s) => s.subscriptionId === sub.id);
    if (subServers.length > 0) {
      groups.push({ id: sub.id, name: sub.name, isManual: false, servers: subServers });
    }
  }

  return groups;
}
