/**
 * 规则资源页纯逻辑单测（离线安全网）：资源分类过滤 / 内置守卫（操作派生）/ 更新态派生。
 * 只锁数据变换，不依赖 DOM 或 IPC。
 */
import {
  CATALOG_FILTERS,
  matchesCategoryFilter,
  resourceRowAction,
  partitionProgress,
  isUpdateAllDisabled,
} from '../rule-resources-logic';
import type { RuleResourceProgress } from '../../../../shared/types';

const prog = (
  over: Partial<RuleResourceProgress> & Pick<RuleResourceProgress, 'status'>
): RuleResourceProgress => ({
  id: 'id',
  name: 'name',
  received: 0,
  total: null,
  percent: null,
  ...over,
});

describe('matchesCategoryFilter（资源分类过滤）', () => {
  it('all → 任何分类都通过', () => {
    for (const c of ['geosite', 'geoip', 'geosite-lite', 'geoip-lite', 'custom'] as const) {
      expect(matchesCategoryFilter(c, 'all')).toBe(true);
    }
  });

  it('geosite / geoip → 分类精确匹配', () => {
    expect(matchesCategoryFilter('geosite', 'geosite')).toBe(true);
    expect(matchesCategoryFilter('geoip', 'geosite')).toBe(false);
    expect(matchesCategoryFilter('geoip', 'geoip')).toBe(true);
    expect(matchesCategoryFilter('geosite', 'geoip')).toBe(false);
  });

  it('lite → 命中所有 -lite 分类，非 lite 不命中', () => {
    expect(matchesCategoryFilter('geosite-lite', 'lite')).toBe(true);
    expect(matchesCategoryFilter('geoip-lite', 'lite')).toBe(true);
    expect(matchesCategoryFilter('geosite', 'lite')).toBe(false);
    expect(matchesCategoryFilter('geoip', 'lite')).toBe(false);
  });

  it('精确分类过滤不把 -lite 变体算作基础分类', () => {
    // geosite-lite 属于 lite，不应被 'geosite' 精确过滤命中
    expect(matchesCategoryFilter('geosite-lite', 'geosite')).toBe(false);
    expect(matchesCategoryFilter('geoip-lite', 'geoip')).toBe(false);
  });

  it('CATALOG_FILTERS 不含 custom（catalog 仅手动 URL 才产生 custom）', () => {
    expect(CATALOG_FILTERS).toEqual(['all', 'geosite', 'geoip', 'lite']);
    expect(CATALOG_FILTERS).not.toContain('custom');
  });
});

describe('resourceRowAction（内置守卫 → 操作派生）', () => {
  it('内置资源 → 只能重置为出厂', () => {
    expect(resourceRowAction({ builtin: true })).toBe('reset');
  });

  it('外置资源 → 只能删除', () => {
    expect(resourceRowAction({ builtin: false })).toBe('delete');
    expect(resourceRowAction({ builtin: undefined })).toBe('delete');
  });
});

describe('partitionProgress（更新态派生）', () => {
  it('按 status 分出 active（下载/排队）与 error 两组', () => {
    const values = [
      prog({ id: 'a', status: 'downloading' }),
      prog({ id: 'b', status: 'queued' }),
      prog({ id: 'c', status: 'error', errorCode: 'network' }),
      prog({ id: 'd', status: 'done' }),
    ];
    const { active, error } = partitionProgress(values);
    expect(active.map((p) => p.id)).toEqual(['a', 'b']);
    expect(error.map((p) => p.id)).toEqual(['c']);
  });

  it('done 不进任何组（完成后转正式行）', () => {
    const { active, error } = partitionProgress([prog({ status: 'done' })]);
    expect(active).toHaveLength(0);
    expect(error).toHaveLength(0);
  });

  it('空快照 → 两组皆空', () => {
    const { active, error } = partitionProgress([]);
    expect(active).toHaveLength(0);
    expect(error).toHaveLength(0);
  });
});

describe('isUpdateAllDisabled（全部更新禁用判据）', () => {
  it('无资源 → 禁用', () => {
    expect(isUpdateAllDisabled(0, 0)).toBe(true);
  });

  it('有下载在途 → 禁用', () => {
    expect(isUpdateAllDisabled(5, 1)).toBe(true);
  });

  it('有资源且无在途 → 可用', () => {
    expect(isUpdateAllDisabled(5, 0)).toBe(false);
  });
});
