/**
 * aggregateConnections 单测（issue #227：首页拓扑聚合下沉 main）。锁：host 名优先级 / outbound 取链首 /
 * 同 host 累加 count+flows / Top-N + Others 合并到 sentinel / 无名连接计入 total+outbound 但不建 host /
 * outbounds 降序。原 topology-layout 的聚合语义逐字移此（layout 单测只剩坐标）。
 */
import { aggregateConnections, aggregateSignature, TOPOLOGY_TOP_N } from '../connections-aggregate';
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

/**
 * aggregateSignature 单测（batch2 §3.6 change-driven）：签名稳定性（剔 at + 顺序无关）+ 变化敏感（host/outbound
 * 计数或分布变）+ 空聚合稳定 + 不 mutate 入参。worker 靠它区分「内容真变」与「仅 at 变 / 仅兄弟重排的零信息增量」，
 * 仅前者才 post aggregate。排列不变性用例锁死 M1：入参连接数组每帧被 connMap #167 LRU 重排，若签名顺序敏感则等
 * 计数兄弟每帧「内容变」→ change-driven 退化到 rate-cap 下限。
 */
describe('aggregateSignature', () => {
  it('排列不变性：同一 multiset 不同数组顺序 → 同签名（等计数兄弟重排不改签名）', () => {
    // a.com / b.com 等计数（各 2）；出口 P / Q 等计数（各 2）；a.com、b.com 内 P/Q 两 flow 各等计数（各 1）。
    // 这些等计数兄弟的相对次序随入参顺序漂移；顺序敏感的签名会因此对「同内容」产出不同签名（修复前本断言 fail）。
    const cs = [
      conn({ host: 'a.com', chain: 'P' }),
      conn({ host: 'a.com', chain: 'Q' }),
      conn({ host: 'b.com', chain: 'P' }),
      conn({ host: 'b.com', chain: 'Q' }),
    ];
    const permuted = [cs[3], cs[1], cs[2], cs[0]]; // 同 multiset，打乱顺序（host / flow / outbound 兄弟均换位）
    const sigA = aggregateSignature(aggregateConnections(cs, 111));
    const sigB = aggregateSignature(aggregateConnections(permuted, 222));
    expect(sigB).toBe(sigA);
  });

  it('同内容不同 at → 同签名（剔 at）', () => {
    const conns = [conn({ host: 'a.com', chain: 'P' }), conn({ host: 'b.com', chain: 'Q' })];
    expect(aggregateSignature(aggregateConnections(conns, 1000))).toBe(
      aggregateSignature(aggregateConnections(conns, 9_999_999))
    );
  });

  it('host 计数变 → 签名变', () => {
    const base = aggregateSignature(aggregateConnections([conn({ host: 'a.com', chain: 'P' })], 0));
    const more = aggregateSignature(
      aggregateConnections(
        [conn({ host: 'a.com', chain: 'P' }), conn({ host: 'a.com', chain: 'P' })],
        0
      )
    );
    expect(more).not.toBe(base);
  });

  it('outbound 分布变 → 签名变', () => {
    const p = aggregateSignature(aggregateConnections([conn({ host: 'a.com', chain: 'P' })], 0));
    const q = aggregateSignature(aggregateConnections([conn({ host: 'a.com', chain: 'Q' })], 0));
    expect(p).not.toBe(q);
  });

  it('空聚合 → 稳定签名（不同 at 同签名）', () => {
    expect(aggregateSignature(aggregateConnections([], 1))).toBe(
      aggregateSignature(aggregateConnections([], 2))
    );
  });

  it('不 mutate 入参（hosts / flows / outbounds 数组引用与顺序不变）', () => {
    // x.com 内 flows 展示序 [Z(2), A(1)]（插入序）、outbounds 展示序 [Z(2), A(1)]（count 降序）均与签名内部的
    // name 升序 [A, Z] 相反——若签名原地 sort 会翻转它们，故可捕获 mutate。
    const agg = aggregateConnections(
      [
        conn({ host: 'x.com', chain: 'Z' }),
        conn({ host: 'x.com', chain: 'Z' }),
        conn({ host: 'x.com', chain: 'A' }),
      ],
      0
    );
    const hostsRef = agg.hosts;
    const flowsRef = agg.hosts[0].flows;
    const flowsSnapshot = agg.hosts[0].flows.slice();
    const outboundsRef = agg.outbounds;
    const outboundsSnapshot = agg.outbounds.slice();

    aggregateSignature(agg);

    expect(agg.hosts).toBe(hostsRef); // 顶层 hosts 数组引用不变
    expect(agg.hosts[0].flows).toBe(flowsRef); // flows 数组引用不变
    expect(agg.hosts[0].flows).toEqual(flowsSnapshot); // flows 顺序不变（未被原地 sort）
    expect(agg.outbounds).toBe(outboundsRef); // outbounds 数组引用不变
    expect(agg.outbounds).toEqual(outboundsSnapshot); // outbounds 顺序不变
  });
});
