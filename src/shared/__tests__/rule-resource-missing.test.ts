/**
 * 正向「资源缺失」判定单测（纯函数，无 I/O）——守护路由规则页 / 应用分流页「资源缺失」角标的判定口径。
 *
 * 与 enumerateResourceRefs（反向）互补的关键：删除会把资源整条移出 config.ruleResources，故「可用集合」里直接没有它，
 * 正向判定（引用的 tag 不在可用集合 → 缺失）对「已删除」与「文件丢失（fileExists=false）」两态统一收口。
 * tag 口径须与 ProxyManager.generateCustomRules / getRequiredGeoCategories 对齐（geosite-<tag>/geoip-<tag>/geoTagOf(res:id)）。
 */
import {
  availableResourceTagSet,
  ruleResourceTags,
  ruleHasMissingResource,
  missingResourceRuleIds,
  appPresetResourceTags,
  missingResourceAppIds,
} from '../rule-resource-refs';
import type { Rule, AppRule, CustomAppPreset } from '../types';

const rule = (over: Partial<Rule>): Rule => ({
  id: 'r1',
  type: 'domain',
  values: ['example.com'],
  action: 'proxy',
  enabled: true,
  ...over,
});

describe('availableResourceTagSet', () => {
  it('仅收 fileExists 为真者，并把 builtin: 前缀归一为 geo tag', () => {
    const set = availableResourceTagSet([
      { id: 'builtin:geosite-cn', fileExists: true },
      { id: 'geosite-amazon', fileExists: false }, // 文件缺失 → 不算可用
      { id: 'res_abc', fileExists: true },
    ]);
    expect(set.has('geosite-cn')).toBe(true);
    expect(set.has('res_abc')).toBe(true);
    expect(set.has('geosite-amazon')).toBe(false);
  });
});

describe('ruleResourceTags', () => {
  it('ruleSet res:<id> → geoTagOf（builtin: 归一），其余裸值忽略', () => {
    const r = rule({
      type: 'ruleSet',
      values: ['res:geosite-amazon', 'res:builtin:geosite-cn', 'https://x/a.srs'],
    });
    expect(ruleResourceTags(r)).toEqual(['geosite-amazon', 'geosite-cn']);
  });

  it('geosite/geoip 裸 tag → geosite-/geoip- 前缀（trim + lowercase）', () => {
    expect(ruleResourceTags(rule({ type: 'geosite', values: ['Amazon', ' YouTube '] }))).toEqual([
      'geosite-amazon',
      'geosite-youtube',
    ]);
    expect(ruleResourceTags(rule({ type: 'geoip', values: [' CN '] }))).toEqual(['geoip-cn']);
  });

  it('非资源类条件（domain 等）→ 无 tag', () => {
    expect(ruleResourceTags(rule({ type: 'domain', values: ['a.com'] }))).toEqual([]);
  });
});

describe('ruleHasMissingResource / missingResourceRuleIds', () => {
  it('引用已删除/缺失资源（不在可用集合）→ 标缺失；存在 → 不标', () => {
    const available = new Set(['geosite-cn']);
    expect(
      ruleHasMissingResource(rule({ type: 'ruleSet', values: ['res:geosite-amazon'] }), available)
    ).toBe(true);
    expect(
      ruleHasMissingResource(
        rule({ type: 'ruleSet', values: ['res:builtin:geosite-cn'] }),
        available
      )
    ).toBe(false);
  });

  it('自定义 res_xxx 资源（非 geo）：原样往返，存在不标 / 删除即标', () => {
    expect(
      ruleHasMissingResource(
        rule({ type: 'ruleSet', values: ['res:res_abc'] }),
        new Set(['res_abc'])
      )
    ).toBe(false);
    expect(
      ruleHasMissingResource(rule({ type: 'ruleSet', values: ['res:res_abc'] }), new Set())
    ).toBe(true);
  });

  it('多条件规则：扫 conditions 数组，任一条件引用缺失即标缺失', () => {
    const available = new Set(['geosite-cn']);
    const r = rule({
      id: 'm',
      type: 'domain',
      values: ['a.com'],
      conditions: [
        { type: 'domain', values: ['a.com'] }, // 非资源
        { type: 'geosite', values: ['amazon'] }, // geosite-amazon 缺失
      ],
      combineMode: 'or',
    });
    expect(ruleResourceTags(r)).toEqual(['geosite-amazon']);
    expect(ruleHasMissingResource(r, available)).toBe(true);
  });

  it('geoip 类型条件未下载本地副本 → 标缺失（运行期会被剪枝）', () => {
    const available = new Set(['geoip-cn']);
    expect(ruleHasMissingResource(rule({ type: 'geoip', values: ['us'] }), available)).toBe(true);
    expect(ruleHasMissingResource(rule({ type: 'geoip', values: ['cn'] }), available)).toBe(false);
  });

  it('禁用规则不标（与运行期一致：不下发本就无效果）', () => {
    const available = new Set<string>();
    expect(
      ruleHasMissingResource(
        rule({ type: 'ruleSet', values: ['res:geosite-amazon'], enabled: false }),
        available
      )
    ).toBe(false);
  });

  it('missingResourceRuleIds 收集所有受影响规则 id', () => {
    const available = new Set(['geosite-cn']);
    const rules = [
      rule({ id: 'a', type: 'ruleSet', values: ['res:geosite-amazon'] }), // 缺
      rule({ id: 'b', type: 'geosite', values: ['cn'] }), // 在
      rule({ id: 'c', type: 'geoip', values: ['cn'] }), // 缺（geoip-cn 不在集合）
      rule({ id: 'd', type: 'geosite', values: ['netflix'], enabled: false }), // 禁用
    ];
    expect(missingResourceRuleIds(rules, available)).toEqual(new Set(['a', 'c']));
  });
});

describe('appPresetResourceTags / missingResourceAppIds', () => {
  it('preset.geositeTags/geoipTags → geosite-/geoip- 前缀', () => {
    expect(appPresetResourceTags({ geositeTags: ['Amazon'], geoipTags: ['Netflix'] })).toEqual([
      'geosite-amazon',
      'geoip-netflix',
    ]);
  });

  it('内置应用引用缺失 geo → 标缺失；齐全 → 不标', () => {
    const appRules: AppRule[] = [{ appId: 'youtube', action: 'proxy', enabled: true }];
    expect(missingResourceAppIds(appRules, new Set())).toEqual(new Set(['youtube']));
    expect(missingResourceAppIds(appRules, new Set(['geosite-youtube']))).toEqual(new Set());
  });

  it('自定义应用经 customAppPresets 解析 geo → 命中缺失', () => {
    const appRules: AppRule[] = [{ appId: 'custom-1', action: 'direct', enabled: true }];
    const customAppPresets: CustomAppPreset[] = [
      { id: 'custom-1', name: '我的应用', emoji: '🌐', geositeTags: ['amazon'] },
    ];
    expect(missingResourceAppIds(appRules, new Set(), customAppPresets)).toEqual(
      new Set(['custom-1'])
    );
    expect(missingResourceAppIds(appRules, new Set(['geosite-amazon']), customAppPresets)).toEqual(
      new Set()
    );
  });

  it('自定义应用的 geoipTags 缺失也命中（geosite 齐全但 geoip 缺）', () => {
    const appRules: AppRule[] = [{ appId: 'custom-2', action: 'proxy', enabled: true }];
    const customAppPresets: CustomAppPreset[] = [
      { id: 'custom-2', name: '我的应用', emoji: '🌐', geositeTags: ['amazon'], geoipTags: ['us'] },
    ];
    expect(missingResourceAppIds(appRules, new Set(['geosite-amazon']), customAppPresets)).toEqual(
      new Set(['custom-2'])
    );
    expect(
      missingResourceAppIds(appRules, new Set(['geosite-amazon', 'geoip-us']), customAppPresets)
    ).toEqual(new Set());
  });

  it('禁用 appRule 不标', () => {
    const appRules: AppRule[] = [{ appId: 'youtube', action: 'proxy', enabled: false }];
    expect(missingResourceAppIds(appRules, new Set())).toEqual(new Set());
  });
});
