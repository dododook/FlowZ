/**
 * topology-layout 纯函数单测（Tier-2：connection-topology 抽出布局计算后的离线安全网）。
 * 锁逐字移出的 computeTopologyLayout 坐标/聚合/Top-N/配色/缎带路径，使「每 2s 全量重算」的布局可回归。
 */
import { computeTopologyLayout, getSankeyPath, FIXED_HEIGHT } from '../topology-layout';
import type { ConnectionEntry } from '../../../../shared/types';

const t = (k: string) => k; // 恒等 i18n：home.others→'home.others'、home.myDevice→'home.myDevice'

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

const byId = <T extends { id: string }>(nodes: T[], id: string): T =>
  nodes.find((n) => n.id === id)!;

describe('computeTopologyLayout — 空态', () => {
  it('无连接 → 空', () => {
    expect(computeTopologyLayout([], 800, t)).toEqual({ nodes: [], links: [] });
  });
  it('width=0 → 空', () => {
    expect(computeTopologyLayout([conn({ host: 'a.com', chain: 'P' })], 0, t)).toEqual({
      nodes: [],
      links: [],
    });
  });
});

describe('computeTopologyLayout — 单连接精确坐标（width=800）', () => {
  const { nodes, links } = computeTopologyLayout(
    [conn({ host: 'example.com', chain: 'Proxy' })],
    800,
    t
  );

  it('三节点 source/rule/outbound', () => {
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.type).sort()).toEqual(['outbound', 'rule', 'source']);
  });

  it('source 节点坐标/配色', () => {
    expect(byId(nodes, 'source')).toMatchObject({
      name: 'home.myDevice',
      type: 'source',
      value: 1,
      x: 55, // PADDING_LEFT(20)+SHIFT_RIGHT(35)
      y: 210, // (450-30)/2
      height: 30, // scale 封顶 30 * 1
      color: 'fill-primary',
    });
  });

  it('middle 节点坐标/配色', () => {
    expect(byId(nodes, 'mid-example.com')).toMatchObject({
      name: 'example.com',
      type: 'rule',
      value: 1,
      x: 395, // 800*0.45+35
      y: 210,
      height: 30,
      color: 'fill-success',
    });
  });

  it('outbound 节点坐标/配色', () => {
    expect(byId(nodes, 'out-Proxy')).toMatchObject({
      name: 'Proxy',
      type: 'outbound',
      value: 1,
      x: 695, // 800-20-120+35
      y: 210,
      height: 30,
      color: 'fill-warning',
    });
  });

  it('两缎带 + 路径精确', () => {
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      source: 'source',
      target: 'mid-example.com',
      value: 1,
      path: 'M 61 210 C 228 210, 228 210, 395 210 L 395 240 C 228 240, 228 240, 61 240 L 61 210 Z',
    });
    expect(links[1]).toMatchObject({
      source: 'mid-example.com',
      target: 'out-Proxy',
      value: 1,
      path: 'M 401 210 C 548 210, 548 210, 695 210 L 695 240 C 548 240, 548 240, 401 240 L 401 210 Z',
    });
  });
});

describe('computeTopologyLayout — 聚合', () => {
  it('同 host+outbound 多连接 → 单节点累加 value', () => {
    const { nodes } = computeTopologyLayout(
      [conn({ host: 'a.com', chain: 'P' }), conn({ host: 'a.com', chain: 'P' })],
      800,
      t
    );
    expect(byId(nodes, 'source').value).toBe(2);
    expect(byId(nodes, 'mid-a.com').value).toBe(2);
    expect(byId(nodes, 'out-P').value).toBe(2);
  });

  it('名称优先级 host > destinationIP > rule:payload', () => {
    const r1 = computeTopologyLayout(
      [conn({ host: 'h.com', destinationIP: '1.1.1.1', rule: 'r' })],
      800,
      t
    );
    expect(byId(r1.nodes, 'mid-h.com')).toBeTruthy();

    const r2 = computeTopologyLayout([conn({ destinationIP: '1.2.3.4', rule: 'r' })], 800, t);
    expect(byId(r2.nodes, 'mid-1.2.3.4')).toBeTruthy();

    const r3 = computeTopologyLayout([conn({ rule: 'GEOIP', rulePayload: 'CN' })], 800, t);
    expect(byId(r3.nodes, 'mid-GEOIP: CN')).toBeTruthy();
  });

  it('outbound 取 chains[0]，无链 → Direct', () => {
    const { nodes } = computeTopologyLayout([conn({ host: 'a.com' })], 800, t);
    expect(byId(nodes, 'out-Direct')).toBeTruthy();
  });
});

describe('computeTopologyLayout — Top-N + Others 收敛', () => {
  it('>15 distinct host → 15 + Others（聚合余量）', () => {
    // host_k 有 k 条连接（k=1..16）→ 排序后 host1(最小) 落入 Others
    const conns: ConnectionEntry[] = [];
    for (let k = 1; k <= 16; k++) {
      for (let n = 0; n < k; n++) conns.push(conn({ host: `host${k}.com`, chain: 'P' }));
    }
    const { nodes } = computeTopologyLayout(conns, 800, t);
    const mids = nodes.filter((n) => n.type === 'rule');
    expect(mids).toHaveLength(16); // 15 top + Others
    const others = byId(nodes, 'mid-home.others');
    expect(others.name).toBe('home.others');
    expect(others.value).toBe(1); // 仅 host1(1 条) 被收敛
    expect(others.color).toBe('fill-muted-foreground'); // Others 用 slate(token)
  });
});

describe('getSankeyPath', () => {
  it('两段贝塞尔 + 闭合', () => {
    expect(getSankeyPath(0, 0, 10, 0, 5, 5)).toBe(
      'M 0 0 C 5 0, 5 0, 10 0 L 10 5 C 5 5, 5 5, 0 5 L 0 0 Z'
    );
  });
});

describe('常量导出', () => {
  it('FIXED_HEIGHT', () => expect(FIXED_HEIGHT).toBe(450));
});
