/**
 * topology-layout 纯函数单测（Tier-2：connection-topology 抽出布局计算后的离线安全网）。
 * issue #227 后 layout 只做坐标布局——聚合（host 累加 / 名称优先级 / Top-N / Others）已下沉 main 的
 * aggregateConnections（见 connections-aggregate.test）。本测试锁坐标/配色/缎带路径 + OTHERS sentinel→i18n 替换。
 */
import {
  collectLinkedIds,
  computeTopologyLayout,
  getSankeyPath,
  hitBox,
  matchNodeIds,
  FIXED_HEIGHT,
} from '../topology-layout';
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
      y: 185, // (450-80)/2
      height: 80, // SOURCE_HEIGHT 恒定，不随连接数缩放
      color: 'fill-primary',
    });
  });

  it('middle 节点坐标/配色', () => {
    expect(byId(nodes, 'mid-example.com')).toMatchObject({
      name: 'example.com',
      type: 'rule',
      value: 1,
      x: 395, // 800*0.45+35
      y: 185,
      height: 80, // 单连接：min(PER_CONN_MAX 80, midCap 328/1) = 80，与 source 等高
      color: 'fill-success',
    });
  });

  it('outbound 节点坐标/配色', () => {
    expect(byId(nodes, 'out-Proxy')).toMatchObject({
      name: 'Proxy',
      type: 'outbound',
      value: 1,
      x: 695, // 800-20-120+35
      y: 185,
      height: 80, // 单出口：min(PER_CONN_MAX 80, OUT_TOTAL_SINGLE 80/1) = 80
      color: 'fill-warning',
    });
  });

  it('两缎带 + 路径精确', () => {
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      source: 'source',
      target: 'mid-example.com',
      value: 1,
      path: 'M 61 185 C 228 185, 228 185, 395 185 L 395 265 C 228 265, 228 265, 61 265 L 61 185 Z',
    });
    expect(links[1]).toMatchObject({
      source: 'mid-example.com',
      target: 'out-Proxy',
      value: 1,
      path: 'M 401 185 C 548 185, 548 185, 695 185 L 695 265 C 548 265, 548 265, 401 265 L 401 185 Z',
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

describe('computeTopologyLayout — 三列独立 scale（issue #303）', () => {
  /** 连接数拉高到让中/右列双双撞上限：canvasHeight=450 → availableHeight=410。 */
  const many = () =>
    computeTopologyLayout(
      agg(
        [
          ['a.com', 40, [['P1', 40]]],
          ['b.com', 40, [['P2', 40]]],
        ],
        [
          ['P1', 40],
          ['P2', 40],
        ]
      ),
      800,
      t
    );

  it('source 恒 80：与连接数无关（80 连接仍 80）', () => {
    expect(byId(many().nodes, 'source').height).toBe(80);
  });

  it('中列撞上限时总高 = maxContentHeight * 0.8，不受 source 高度约束', () => {
    const { nodes } = many();
    // middleCount=2 → totalMiddleGap=12；outboundCount=2 → totalOutboundGap=12
    // maxContentHeight = 410 - max(12,12) = 398；midCap = 398*0.8 = 318.4
    // scale = min(80, 318.4/80) = 3.98 → 每 host 40 * 3.98 = 159.2
    const midTotal = byId(nodes, 'mid-a.com').height + byId(nodes, 'mid-b.com').height;
    expect(midTotal).toBeCloseTo(398 * 0.8, 5);
  });

  it('多出口撞上限时右列总高 = 120（与中列上限彼此独立，不守恒）', () => {
    const { nodes } = many();
    const outTotal = byId(nodes, 'out-P1').height + byId(nodes, 'out-P2').height;
    expect(outTotal).toBeCloseTo(120, 5);
    // 三列刻意互不相等：source 80 / 中列 318.4 / 右列 120
    expect(byId(nodes, 'source').height).not.toBeCloseTo(outTotal, 5);
  });

  it('单出口 × 多连接 → 右条 80（判定的是出口节点数，非连接数）', () => {
    const { nodes } = computeTopologyLayout(agg([['a.com', 40, [['P', 40]]]], [['P', 40]]), 800, t);
    expect(byId(nodes, 'out-P').height).toBe(80);
  });

  it('少连接不顶上限：每条 PER_CONN_MAX(80)，中列不铺满 midCap', () => {
    const { nodes } = computeTopologyLayout(
      agg(
        [
          ['a.com', 1, [['P', 1]]],
          ['b.com', 1, [['P', 1]]],
        ],
        [['P', 2]]
      ),
      800,
      t
    );
    // scale = min(80, midCap/2)；midCap = (410-12)*0.8 = 318.4 → 318.4/2 = 159.2 > 80 → 取 80
    expect(byId(nodes, 'mid-a.com').height).toBe(80);
    expect(byId(nodes, 'mid-b.com').height).toBe(80);
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

describe('matchNodeIds — 检索匹配（issue #303）', () => {
  const { nodes } = computeTopologyLayout(
    agg(
      [
        ['API.Example.COM', 1, [['Proxy-A', 1]]],
        ['203.0.113.7', 1, [['direct', 1]]],
      ],
      [
        ['Proxy-A', 1],
        ['direct', 1],
      ]
    ),
    800,
    t
  );

  it('空 query → 空数组（未检索，与零命中区分）', () => {
    expect(matchNodeIds(nodes, '')).toEqual([]);
    expect(matchNodeIds(nodes, '   ')).toEqual([]);
  });

  it('域名：大小写不敏感子串', () => {
    expect(matchNodeIds(nodes, 'example')).toEqual(['mid-API.Example.COM']);
    expect(matchNodeIds(nodes, 'API.EXAMPLE')).toEqual(['mid-API.Example.COM']);
  });

  it('IP：与域名同一字段，无需分类匹配', () => {
    expect(matchNodeIds(nodes, '203.0.113')).toEqual(['mid-203.0.113.7']);
  });

  it('出口节点名可命中', () => {
    expect(matchNodeIds(nodes, 'proxy-a')).toEqual(['out-Proxy-A']);
  });

  it('source 节点不参与匹配（设备锚，非检索目标）', () => {
    expect(matchNodeIds(nodes, 'myDevice')).toEqual([]);
  });

  it('无命中 → 空数组', () => {
    expect(matchNodeIds(nodes, 'nonexistent')).toEqual([]);
  });
});

describe('collectLinkedIds — 链路高亮（hover 与检索共用）', () => {
  const { nodes: _n, links } = computeTopologyLayout(
    agg(
      [
        ['a.com', 1, [['P1', 1]]],
        ['b.com', 1, [['P2', 1]]],
      ],
      [
        ['P1', 1],
        ['P2', 1],
      ]
    ),
    800,
    t
  );

  it('空焦点 → 空集（无命中，非全亮）', () => {
    expect(collectLinkedIds(links, []).size).toBe(0);
  });

  it('中列节点 → 上游 source + 下游出口 + 沿途缎带', () => {
    const set = collectLinkedIds(links, ['mid-a.com']);
    expect(set.has('mid-a.com')).toBe(true);
    expect(set.has('source')).toBe(true); // 上游
    expect(set.has('out-P1')).toBe(true); // 下游
    expect(set.has('mid-b.com')).toBe(false); // 另一条链路不点亮
    expect(set.has('out-P2')).toBe(false);
  });

  it('多焦点（检索命中多个）→ 并集', () => {
    const set = collectLinkedIds(links, ['mid-a.com', 'mid-b.com']);
    expect(set.has('out-P1')).toBe(true);
    expect(set.has('out-P2')).toBe(true);
  });

  it('出口节点 → 反向点亮其全部上游 host', () => {
    const set = collectLinkedIds(links, ['out-P1']);
    expect(set.has('mid-a.com')).toBe(true);
    expect(set.has('source')).toBe(true);
    expect(set.has('mid-b.com')).toBe(false);
  });
});

describe('hitBox — 命中区与视觉尺寸解耦（issue #303 真机：条几 px 高时右键戳不中）', () => {
  const node = (over: Partial<Parameters<typeof hitBox>[0]>) =>
    ({
      id: 'x',
      name: 'x',
      type: 'rule',
      value: 1,
      x: 0,
      y: 0,
      height: 9,
      color: '',
      ...over,
    }) as Parameters<typeof hitBox>[0];

  it('细条（9px，真机实测值）→ 命中区抬到 18px 下限', () => {
    expect(hitBox(node({ height: 9 })).height).toBe(18);
  });

  it('极细条（2px 地板）→ 抬到 12px 封顶：防重叠优先于最小高度', () => {
    // 上界 = 条高 + NODE_GAP(12) - 2 = 12；再高就与相邻节点命中区重叠。
    // 12 仍是 2px 的 6 倍，可点性大幅改善，但不牺牲"绝不误触邻居"。
    expect(hitBox(node({ height: 2 })).height).toBe(12);
  });

  it('粗条（80px）→ 命中区不缩水，跟随条高', () => {
    expect(hitBox(node({ height: 80 })).height).toBe(80);
  });

  it('命中区恒不与相邻节点重叠：height ≤ 条高 + NODE_GAP(12) - 2', () => {
    for (const h of [2, 5, 9, 12, 16, 20, 40, 80]) {
      const box = hitBox(node({ height: h }));
      expect(box.height).toBeLessThanOrEqual(Math.max(h + 10, h));
    }
  });

  it('细条命中区以条为中心纵向扩展（上下对称）', () => {
    const box = hitBox(node({ height: 9 }));
    expect(box.y).toBeCloseTo((9 - box.height) / 2, 5);
  });

  it('rule/source 节点：命中区向左覆盖标签文字（文字 pointer-events:none 会穿透）', () => {
    const box = hitBox(node({ type: 'rule' }));
    expect(box.x).toBeLessThan(-10); // 远超原来的 -10，够到标签
    expect(box.width).toBeGreaterThan(100);
  });

  it('outbound 节点：标签在右侧，命中区不向左过度延伸', () => {
    expect(hitBox(node({ type: 'outbound' })).x).toBe(-10);
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
