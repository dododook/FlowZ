/**
 * aggregateConnections 单测（issue #227：首页拓扑聚合下沉 main）。锁：host 名优先级 / outbound 取链首 /
 * 同 host 累加 count+flows / Top-N + Others 合并到 sentinel / 无名连接计入 total+outbound 但不建 host /
 * outbounds 降序。原 topology-layout 的聚合语义逐字移此（layout 单测只剩坐标）。
 */
import { aggregateConnections, TOPOLOGY_TOP_N } from '../connections-aggregate';
import {
  TOPOLOGY_OTHERS_KEY,
  type ConnectionEntry,
  type ConnectionsAggregate,
} from '../../../shared/types';

let idc = 0;
function conn(o: {
  host?: string;
  destinationIP?: string;
  rule?: string;
  rulePayload?: string;
  chain?: string;
}): ConnectionEntry {
  return {
    id: `c${idc++}`,
    chains: o.chain ? [o.chain] : [],
    rule: o.rule ?? 'final',
    rulePayload: o.rulePayload ?? '',
    metadata:
      o.host || o.destinationIP ? { host: o.host, destinationIP: o.destinationIP } : undefined,
  } as ConnectionEntry;
}

const hostByName = (agg: ConnectionsAggregate, name: string) =>
  agg.hosts.find((h) => h.name === name);
const outByName = (agg: ConnectionsAggregate, name: string) =>
  agg.outbounds.find((o) => o.name === name);

describe('aggregateConnections', () => {
  it('total = 连接总数；同 host+outbound 累加 count + flows', () => {
    const agg = aggregateConnections(
      [conn({ host: 'a.com', chain: 'P' }), conn({ host: 'a.com', chain: 'P' })],
      0
    );
    expect(agg.total).toBe(2);
    expect(hostByName(agg, 'a.com')?.count).toBe(2);
    expect(hostByName(agg, 'a.com')?.flows).toEqual([{ outbound: 'P', count: 2 }]);
    expect(outByName(agg, 'P')?.count).toBe(2);
  });

  it('host 名优先级 host > destinationIP > rule:payload > rule', () => {
    expect(
      hostByName(
        aggregateConnections([conn({ host: 'h.com', destinationIP: '1.1.1.1', rule: 'r' })], 0),
        'h.com'
      )
    ).toBeTruthy();
    expect(
      hostByName(
        aggregateConnections([conn({ destinationIP: '1.2.3.4', rule: 'r' })], 0),
        '1.2.3.4'
      )
    ).toBeTruthy();
    expect(
      hostByName(aggregateConnections([conn({ rule: 'GEOIP', rulePayload: 'CN' })], 0), 'GEOIP: CN')
    ).toBeTruthy();
    expect(hostByName(aggregateConnections([conn({ rule: 'final' })], 0), 'final')).toBeTruthy();
  });

  it('outbound 取 chains[0]，无链 → Direct', () => {
    expect(outByName(aggregateConnections([conn({ host: 'a.com' })], 0), 'Direct')).toBeTruthy();
    expect(
      outByName(aggregateConnections([conn({ host: 'a.com', chain: 'hk' })], 0), 'hk')
    ).toBeTruthy();
  });

  it('>TOP_N distinct host → Top-N + Others（最小者按 count 合并到 sentinel）', () => {
    // host_k 有 k 条连接（k=1..TOP_N+1）→ 排序后 host1(最小=1 条) 落入 Others。
    const conns: ConnectionEntry[] = [];
    for (let k = 1; k <= TOPOLOGY_TOP_N + 1; k++) {
      for (let n = 0; n < k; n++) conns.push(conn({ host: `host${k}.com`, chain: 'P' }));
    }
    const agg = aggregateConnections(conns, 0);
    expect(agg.hosts).toHaveLength(TOPOLOGY_TOP_N + 1); // Top-N + Others
    const others = hostByName(agg, TOPOLOGY_OTHERS_KEY);
    expect(others?.count).toBe(1); // 仅 host1(1 条) 被收敛
    expect(others?.flows).toEqual([{ outbound: 'P', count: 1 }]);
  });

  it('无名连接（metadata 空 + rule 空）计入 total + outbound，但不建 host 节点', () => {
    const agg = aggregateConnections(
      [conn({ rule: '', chain: 'P' }), conn({ host: 'a.com', chain: 'P' })],
      0
    );
    expect(agg.total).toBe(2);
    expect(agg.hosts).toHaveLength(1); // 仅 a.com
    expect(hostByName(agg, 'a.com')?.count).toBe(1);
    expect(outByName(agg, 'P')?.count).toBe(2); // 两条都计入 outbound
  });

  it('outbounds 按 count 降序', () => {
    const agg = aggregateConnections(
      [
        conn({ host: 'a.com', chain: 'P1' }),
        conn({ host: 'b.com', chain: 'P2' }),
        conn({ host: 'c.com', chain: 'P2' }),
      ],
      0
    );
    expect(agg.outbounds.map((o) => o.name)).toEqual(['P2', 'P1']); // P2(2) > P1(1)
  });

  it('空输入 → 空聚合（保留 at）', () => {
    expect(aggregateConnections([], 123)).toEqual({
      total: 0,
      hosts: [],
      outbounds: [],
      at: 123,
    });
  });
});
