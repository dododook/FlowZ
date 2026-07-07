/**
 * 规则集选择器（下拉复选）纯逻辑单测：分区 / 搜索 / 引用勾选切换 / fail-closed 可选性。
 * （是否显搜索的 shouldShowSearch 谓词已复用 .npick，覆盖在 node-picker-logic.test.ts。）
 * 组件基于 radix dropdown-menu + checkbox，本测试只锁数据变换（离线安全网）。
 */
import {
  resourceRef,
  isResourceSelected,
  toggleResourceRef,
  isResourceSelectable,
  partitionResources,
  filterResources,
} from '../resource-picker-logic';
import type { RuleResourceListItem } from '../../../../shared/types';

const res = (
  over: Partial<RuleResourceListItem> & { id: string; name: string }
): RuleResourceListItem => ({
  category: 'geosite',
  sourceUrl: '',
  fileName: `${over.id}.srs`,
  format: 'binary',
  size: 100,
  downloadedAt: '',
  fileExists: true,
  referencedBy: 0,
  ...over,
});

describe('resourceRef / isResourceSelected', () => {
  it('引用值 = res:<id>', () => {
    expect(resourceRef('builtin:geosite-cn')).toBe('res:builtin:geosite-cn');
  });
  it('已选判定按 res:<id>', () => {
    expect(isResourceSelected(['res:a', 'res:b'], 'a')).toBe(true);
    expect(isResourceSelected(['res:a'], 'b')).toBe(false);
  });
});

describe('toggleResourceRef', () => {
  it('未选 → 追加（保序）', () => {
    expect(toggleResourceRef(['res:a'], 'b')).toEqual(['res:a', 'res:b']);
  });
  it('已选 → 移除', () => {
    expect(toggleResourceRef(['res:a', 'res:b'], 'a')).toEqual(['res:b']);
  });
  it('不误伤同前缀其它值', () => {
    expect(toggleResourceRef(['res:ab'], 'a')).toEqual(['res:ab', 'res:a']);
  });
});

describe('isResourceSelectable (fail-closed)', () => {
  it('文件存在 → 可选', () => {
    expect(isResourceSelectable(res({ id: 'a', name: 'a', fileExists: true }), false)).toBe(true);
  });
  it('文件缺失且未引用 → 不可新选', () => {
    expect(isResourceSelectable(res({ id: 'a', name: 'a', fileExists: false }), false)).toBe(false);
  });
  it('文件缺失但已引用 → 仍可（取消失效引用）', () => {
    expect(isResourceSelectable(res({ id: 'a', name: 'a', fileExists: false }), true)).toBe(true);
  });
});

describe('partitionResources', () => {
  it('按 builtin 分内置/外置，保序', () => {
    const list = [
      res({ id: 'b1', name: 'b1', builtin: true }),
      res({ id: 'e1', name: 'e1' }),
      res({ id: 'b2', name: 'b2', builtin: true }),
    ];
    const { builtin, external } = partitionResources(list);
    expect(builtin.map((r) => r.id)).toEqual(['b1', 'b2']);
    expect(external.map((r) => r.id)).toEqual(['e1']);
  });
});

describe('filterResources', () => {
  const list = [
    res({ id: '1', name: 'geosite-cn' }),
    res({ id: '2', name: 'geosite-netflix' }),
    res({ id: '3', name: 'geoip-cn' }),
  ];
  it('空查询 → 全量', () => {
    expect(filterResources(list, '   ')).toHaveLength(3);
  });
  it('大小写不敏感按名称过滤', () => {
    expect(filterResources(list, 'NETFLIX').map((r) => r.id)).toEqual(['2']);
  });
  it('无匹配 → 空', () => {
    expect(filterResources(list, 'zzz')).toEqual([]);
  });
});
