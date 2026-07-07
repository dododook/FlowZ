/**
 * NodePicker（`.npick`）纯逻辑单测：分组 / 过滤 / 选中回填 / 是否显搜索 / 延迟色档。
 * 组件基于 radix dropdown-menu 组合，本测试只锁与 UI 无关的数据变换（离线安全网，供批 3+ 复用前防回归）。
 */
import {
  filterItems,
  findItem,
  groupItems,
  latencyTone,
  matchesQuery,
  shouldShowSearch,
  type NodePickerGroup,
  type NodePickerItem,
} from '../node-picker-logic';

const item = (over: Partial<NodePickerItem> & { id: string; name: string }): NodePickerItem => over;

describe('latencyTone', () => {
  it('未测 / N/A → idle', () => {
    expect(latencyTone(undefined)).toBe('idle');
    expect(latencyTone(50, true)).toBe('idle');
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
