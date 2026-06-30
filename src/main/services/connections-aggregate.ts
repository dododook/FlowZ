/**
 * 连接聚合（首页拓扑数据下沉 main，issue #227）——纯函数：从连接明细聚合出 ConnectionsAggregate
 * （Top-N host + 各出口分布 + 出口总数）。取代渲染端 topology-layout 内对全量 ConnectionEntry[] 的每秒
 * O(N) 聚合 + 全量明细经 IPC 广播：main 算一次、广播小载荷（~Top-N host + 出口数），渲染端只做坐标布局。
 *
 * host 显示名优先级与原 topology-layout 严格一致：metadata.host(域名) > metadata.destinationIP(目标 IP)
 * > `rule: payload` > rule。outbound 取 chains[0]（连接首跳出站 tag），无链则 'Direct'。无名连接（上述全空）
 * 计入 total/outbound 但不建 host 节点（对齐原 layout 的 filter(n && n.trim())）。纯函数、无副作用，供单测。
 */
import {
  TOPOLOGY_OTHERS_KEY,
  type ConnectionEntry,
  type ConnectionsAggregate,
  type ConnectionAggHost,
} from '../../shared/types';

/** 拓扑中列 host 节点上限（与渲染端原 MAX_NODES 对齐）；超出按 count 降序取 Top-N，其余并入 TOPOLOGY_OTHERS_KEY。 */
export const TOPOLOGY_TOP_N = 15;

/** host 显示名（与原 topology-layout 同优先级）。trimConnection 恒置 rulePayload='' 故 `rule: payload` 分支
 *  当前不触发，保留以对齐原逻辑（未来若上游回填 rulePayload 自动生效）。 */
function hostNameOf(c: ConnectionEntry): string {
  const m = c.metadata || {};
  if (m.host) return m.host;
  if (m.destinationIP) return m.destinationIP;
  if (c.rulePayload) return `${c.rule}: ${c.rulePayload}`;
  return c.rule || '';
}

// outbound = chains[0]（首跳出站 tag），无链则 'Direct'。与原 topology-layout 实质等价：原 `if (chains.length>0)
// outbound=chains[0]` 在 chains[0] 为空串时会产出空串出口名，本实现回落 'Direct'——空 tag 实际不会发生（sing-box
// 链节点恒有 tag），此差异仅是更稳健的兜底，不改变真实数据下的结果。
function outboundOf(c: ConnectionEntry): string {
  return (Array.isArray(c.chains) && c.chains[0]) || 'Direct';
}

function flowsToArr(flows: Map<string, number>): ConnectionAggHost['flows'] {
  return Array.from(flows.entries()).map(([outbound, count]) => ({ outbound, count }));
}

export function aggregateConnections(
  conns: ConnectionEntry[],
  at: number,
  topN: number = TOPOLOGY_TOP_N
): ConnectionsAggregate {
  const hostMap = new Map<string, { count: number; flows: Map<string, number> }>();
  const outboundTotals = new Map<string, number>();

  for (const c of conns) {
    const ob = outboundOf(c);
    // outbound 计入所有连接（含无名，与原 layout 的 outboundTotals 同口径——右列节点高度按全部连接算）。
    outboundTotals.set(ob, (outboundTotals.get(ob) || 0) + 1);
    const name = hostNameOf(c);
    if (!name.trim()) continue; // 无名连接：计 total/outbound、不建 host 节点（对齐原 layout 过滤）
    let h = hostMap.get(name);
    if (!h) {
      h = { count: 0, flows: new Map() };
      hostMap.set(name, h);
    }
    h.count++;
    h.flows.set(ob, (h.flows.get(ob) || 0) + 1);
  }

  const sorted = Array.from(hostMap.entries()).sort((a, b) => b[1].count - a[1].count);
  let hosts: ConnectionAggHost[];
  if (sorted.length > topN) {
    const top = sorted.slice(0, topN);
    const othersFlows = new Map<string, number>();
    let othersCount = 0;
    for (const [, d] of sorted.slice(topN)) {
      othersCount += d.count;
      for (const [k, v] of d.flows) othersFlows.set(k, (othersFlows.get(k) || 0) + v);
    }
    hosts = [
      ...top.map(([name, d]) => ({ name, count: d.count, flows: flowsToArr(d.flows) })),
      { name: TOPOLOGY_OTHERS_KEY, count: othersCount, flows: flowsToArr(othersFlows) },
    ];
  } else {
    hosts = sorted.map(([name, d]) => ({ name, count: d.count, flows: flowsToArr(d.flows) }));
  }

  const outbounds = Array.from(outboundTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  return { total: conns.length, hosts, outbounds, at };
}
