/**
 * topology-layout 纯函数单测（Tier-2：connection-topology 抽出布局计算后的离线安全网）。
 * issue #227 后 layout 只做坐标布局——聚合（host 累加 / 名称优先级 / Top-N / Others）已下沉 main 的
 * aggregateConnections（见 connections-aggregate.test）。本测试锁坐标/配色/缎带路径 + OTHERS sentinel→i18n 替换。
 */
import { computeTopologyLayout, getSankeyPath, FIXED_HEIGHT } from '../topology-layout';
import { TOPOLOGY_OTHERS_KEY, type ConnectionsAggregate } from '../../../../shared/types';

const t = (k: string) => k; // 恒等 i18n：home.others→'home.others'、home.myDevice→'home.myDevice'

/** 构造聚合输入：hosts=[name, count, flows([outbound,count])]，outbounds=[name, count]。 */
function agg(
  hosts: Array<[string, number, Array<[string, number]>]>,
  outbounds: Array<[string, number]>
): ConnectionsAggregate {
  return {
    total: hosts.reduce((a, [, c]) => a + c, 0),
    hosts: hosts.map(([name, count, flows]) => ({
      name,
      count,
      flows: flows.map(([outbound, c]) => ({ outbound, count: c })),
    })),
    outbounds: outbounds.map(([name, count]) => ({ name, count })),
    at: 0,
  };
}

const byId = <T extends { id: string }>(nodes: T[], id: string): T =>
  nodes.find((n) => n.id === id)!;

describe('computeTopologyLayout — 空态', () => {
  it('无 host → 空', () => {
    expect(computeTopologyLayout(agg([], []), 800, t)).toEqual({ nodes: [], links: [] });
  });
  it('width=0 → 空', () => {
    expect(computeTopologyLayout(agg([['a.com', 1, [['P', 1]]]], [['P', 1]]), 0, t)).toEqual({
      nodes: [],
      links: [],
    });
  });
});

describe('computeTopologyLayout — 单连接精确坐标（width=800）', () => {
  const { nodes, links } = computeTopologyLayout(
    agg([['example.com', 1, [['Proxy', 1]]]], [['Proxy', 1]]),
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

describe('computeTopologyLayout — 多 host 比例缩放', () => {
  it('source.value = 各 host count 之和；同 outbound 累加 outbound 节点高度', () => {
    const { nodes } = computeTopologyLayout(
      agg(
        [
          ['a.com', 2, [['P', 2]]],
          ['b.com', 1, [['P', 1]]],
        ],
        [['P', 3]]
      ),
      800,
      t
    );
    expect(byId(nodes, 'source').value).toBe(3);
    expect(byId(nodes, 'mid-a.com').value).toBe(2);
    expect(byId(nodes, 'mid-b.com').value).toBe(1);
    expect(byId(nodes, 'out-P').value).toBe(3);
  });
});

describe('computeTopologyLayout — OTHERS sentinel → i18n 替换', () => {
  it('main 下发的 TOPOLOGY_OTHERS_KEY 合并组 → 显示 t(home.others) + slate 配色', () => {
    const { nodes } = computeTopologyLayout(
      agg(
        [
          ['top.com', 5, [['P', 5]]],
          [TOPOLOGY_OTHERS_KEY, 3, [['P', 3]]],
        ],
        [['P', 8]]
      ),
      800,
      t
    );
    const others = byId(nodes, 'mid-home.others');
    expect(others.name).toBe('home.others'); // sentinel 被替换为本地化文案
    expect(others.value).toBe(3);
    expect(others.color).toBe('fill-muted-foreground'); // Others 用 slate(token)
    // 非 others 节点保持真实 host 名（不被替换）
    expect(byId(nodes, 'mid-top.com').color).toBe('fill-success');
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
