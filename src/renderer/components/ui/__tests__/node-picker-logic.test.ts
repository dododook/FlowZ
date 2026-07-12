/**
 * NodePicker（`.npick`）纯逻辑单测：分组 / 过滤 / 选中回填 / 是否显搜索 / 延迟色档。
 * 组件基于 radix dropdown-menu 组合，本测试只锁与 UI 无关的数据变换（离线安全网，供批 3+ 复用前防回归）。
 */
import {
  enterSelection,
  filterItems,
  findItem,
  firstSelectable,
  groupItems,
  latencyTone,
  matchesQuery,
  shouldShowSearch,
  type NodePickerGroup,
  type NodePickerItem,
} from '../node-picker-logic';

const item = (over: Partial<NodePickerItem> & { id: string; name: string }): NodePickerItem => over;

describe('latencyTone', () => {
  it('未测 → idle（含不可测 na 且无值）', () => {
    expect(latencyTone(undefined)).toBe('idle');
    expect(latencyTone(undefined, true)).toBe('idle');
  });
  it('不可测 na 有值 → 按数值上色（出口伴测为当前 TS/组网出口写入延迟后显真实色档）', () => {
    expect(latencyTone(50, true)).toBe('good');
    expect(latencyTone(120, true)).toBe('medium');
    expect(latencyTone(500, true)).toBe('bad');
  });
  it('超时(-1) → bad', () => expect(latencyTone(-1)).toBe('bad'));
  it('阈值边界 <100 good / <300 medium / >=300 bad', () => {
    expect(latencyTone(0)).toBe('good');
    expect(latencyTone(99)).toBe('good');
    expect(latencyTone(100)).toBe('medium');
    expect(latencyTone(299)).toBe('medium');
    expect(latencyTone(300)).toBe('bad');
    expect(latencyTone(999)).toBe('bad');
  });
});

describe('matchesQuery / filterItems', () => {
  const items = [
    item({ id: 'a', name: '香港 IEPL 01', protocol: 'vless', address: 'hk01.iepl.net:443' }),
    item({ id: 'b', name: 'US CN2', protocol: 'trojan', keywords: '美国' }),
  ];
  it('空查询恒命中（含仅空白）', () => {
    expect(filterItems(items, '')).toHaveLength(2);
    expect(filterItems(items, '   ')).toHaveLength(2);
  });
  it('命中名 / 协议 / 地址 / 关键词（大小写不敏感）', () => {
    expect(matchesQuery(items[0], '香港')).toBe(true);
    expect(matchesQuery(items[0], 'VLESS')).toBe(true);
    expect(matchesQuery(items[0], 'iepl.net')).toBe(true);
    expect(matchesQuery(items[1], '美国')).toBe(true);
    expect(matchesQuery(items[1], 'TROJAN')).toBe(true);
  });
  it('不命中 → false / 过滤为空', () => {
    expect(matchesQuery(items[0], '日本')).toBe(false);
    expect(filterItems(items, '日本')).toEqual([]);
  });
});

describe('groupItems', () => {
  const groups: NodePickerGroup[] = [
    { id: 'manual', label: '自建' },
    { id: 'mesh', label: '组网' },
    { id: 'sub-hk', label: '香港专线' },
  ];
  const items = [
    item({ id: '__direct__', name: '直连' }), // 无 groupId → 无分组桶置顶
    item({ id: 'm1', name: 'M1', groupId: 'manual' }),
    item({ id: 'x1', name: 'X1', groupId: 'sub-hk' }),
    item({ id: 'm2', name: 'M2', groupId: 'manual' }),
  ];

  it('未传 groups → 单段平铺（group=null）', () => {
    const secs = groupItems(items);
    expect(secs).toHaveLength(1);
    expect(secs[0].group).toBeNull();
    expect(secs[0].items).toHaveLength(4);
  });

  it('有 groups → 无分组桶置顶 + 按 groups 顺序成段 + 空组省略', () => {
    const secs = groupItems(items, groups);
    // 无分组桶(直连) + manual + sub-hk（mesh 空 → 省略）
    expect(secs.map((s) => s.group?.id ?? null)).toEqual([null, 'manual', 'sub-hk']);
    expect(secs[0].items.map((i) => i.id)).toEqual(['__direct__']);
    expect(secs[1].items.map((i) => i.id)).toEqual(['m1', 'm2']);
    expect(secs[2].items.map((i) => i.id)).toEqual(['x1']);
  });

  it('全部有 groupId 时不产生空的无分组桶', () => {
    const secs = groupItems(items.slice(1), groups);
    expect(secs.every((s) => s.group !== null)).toBe(true);
  });

  it('空 items → 空段', () => {
    expect(groupItems([], groups)).toEqual([]);
    expect(groupItems([])).toEqual([]);
  });
});

describe('findItem（选中回填）', () => {
  const items = [item({ id: 'a', name: 'A' }), item({ id: 'b', name: 'B' })];
  it('命中 id', () => expect(findItem(items, 'b')?.name).toBe('B'));
  it('未命中 / 空 id → undefined', () => {
    expect(findItem(items, 'zzz')).toBeUndefined();
    expect(findItem(items, undefined)).toBeUndefined();
    expect(findItem(items, null)).toBeUndefined();
  });
});

describe('shouldShowSearch', () => {
  it('> 阈值才显（默认 6）', () => {
    expect(shouldShowSearch(6)).toBe(false);
    expect(shouldShowSearch(7)).toBe(true);
    expect(shouldShowSearch(3, 2)).toBe(true);
  });
});

describe('firstSelectable（Enter 选中首个可选，跳过 disabled）', () => {
  it('跳过前导 disabled，返回视觉首个可选', () => {
    const secs = groupItems([
      item({ id: 'a', name: 'A', disabled: true }),
      item({ id: 'b', name: 'B', disabled: true }),
      item({ id: 'c', name: 'C' }),
    ]);
    expect(firstSelectable(secs)?.id).toBe('c');
  });

  it('全 disabled → undefined', () => {
    const secs = groupItems([
      item({ id: 'a', name: 'A', disabled: true }),
      item({ id: 'b', name: 'B', disabled: true }),
    ]);
    expect(firstSelectable(secs)).toBeUndefined();
  });

  it('空段 → undefined', () => {
    expect(firstSelectable([])).toBeUndefined();
    expect(firstSelectable(groupItems([]))).toBeUndefined();
  });

  it('跨分组按段顺序取首个可选（前段全 disabled 则跨到后段）', () => {
    const groups: NodePickerGroup[] = [
      { id: 'g1', label: 'G1' },
      { id: 'g2', label: 'G2' },
    ];
    const secs = groupItems(
      [
        item({ id: 'x', name: 'X', groupId: 'g1', disabled: true }),
        item({ id: 'y', name: 'Y', groupId: 'g2' }),
      ],
      groups
    );
    expect(firstSelectable(secs)?.id).toBe('y');
  });
});

describe('enterSelection（Enter 选中 gate：空 query 不选，杜绝误清空）', () => {
  // 首项是顶部哨兵（直连/None/跟随全局），其后是真实节点——复刻 exit-node picker 结构。
  const sections = groupItems([
    item({ id: '__none__', name: '直连', role: 'none' }),
    item({ id: 'n1', name: 'Tokyo' }),
    item({ id: 'n2', name: 'Osaka' }),
  ]);

  it('空 query 的裸 Enter → undefined（不选顶部哨兵，onSelect 不被调用）', () => {
    expect(enterSelection('', sections)).toBeUndefined();
  });

  it('纯空白 query（仅空格）→ undefined（trim 后为空视同裸 Enter）', () => {
    expect(enterSelection('   ', sections)).toBeUndefined();
  });

  it('有真实查询词 → 选视觉首个可选项（首个匹配）', () => {
    const filtered = groupItems(
      filterItems(
        sections.flatMap((s) => s.items),
        'osaka'
      )
    );
    expect(enterSelection('osaka', filtered)?.id).toBe('n2');
  });

  it('有查询词但结果全 disabled / 空 → undefined', () => {
    const allDisabled = groupItems([item({ id: 'd', name: 'D', disabled: true })]);
    expect(enterSelection('d', allDisabled)).toBeUndefined();
    expect(enterSelection('zzz', groupItems([]))).toBeUndefined();
  });
});
