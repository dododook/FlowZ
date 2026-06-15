/**
 * enumerateResourceRefs / isResourceReferenced 单测（纯函数，无 I/O）。
 *
 * 锁定 fail-closed 闭环的单一真值：某个规则资源(geo/.srs)被哪些启用规则引用——覆盖三类引用形态：
 *   ① 自定义路由规则的 ruleSet `res:<id>`（含 builtin: / 用户下载 id）；
 *   ② 自定义路由规则的 geosite/geoip **类型条件**（裸 tag → `geosite-<tag>`/`geoip-<tag>` 资源 id）；
 *   ③ 应用分流 appRules（经内置/自定义 preset 的 geositeTags/geoipTags 间接引用）。
 * 历史漏报（②③）会导致删除提醒不全 + geo 下载后不触发 reload（规则不恢复）——这些用例守护其不回归。
 */
import { enumerateResourceRefs, isResourceReferenced } from '../rule-resource-refs';
import type { Rule, AppRule, CustomAppPreset } from '../types';

const rule = (over: Partial<Rule>): Rule => ({
  id: 'r1',
  type: 'domain',
  values: ['example.com'],
  action: 'proxy',
  enabled: true,
  ...over,
});

describe('enumerateResourceRefs', () => {
  it('ruleSet res:<id> 精确引用 → route 引用', () => {
    const r = rule({
      id: 'rA',
      type: 'ruleSet',
      values: ['res:geosite-amazon'],
      remarks: '亚马逊',
    });
    const refs = enumerateResourceRefs('geosite-amazon', { customRules: [r] });
    expect(refs).toEqual([{ kind: 'route', id: 'rA', label: '亚马逊' }]);
  });

  it('geosite 类型条件（裸 tag）→ 命中 geosite-<tag> 资源', () => {
    const r = rule({ id: 'rB', type: 'geosite', values: ['amazon'], remarks: '' });
    const refs = enumerateResourceRefs('geosite-amazon', { customRules: [r] });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'route', id: 'rB' });
    // 无备注 → label 回落首条件摘要
    expect(refs[0].label).toContain('geosite');
  });

  it('geoip 类型条件 → 命中 geoip-<tag> 资源（大小写/空格归一）', () => {
    const r = rule({ id: 'rC', type: 'geoip', values: [' CN '] });
    expect(enumerateResourceRefs('geoip-cn', { customRules: [r] })).toHaveLength(1);
    // geosite 同名 tag 不应误命中 geoip 资源
    expect(enumerateResourceRefs('geosite-cn', { customRules: [r] })).toHaveLength(0);
  });

  it('多条件规则：任一条件命中即计一次（不重复计）', () => {
    const r = rule({
      id: 'rD',
      type: 'geosite',
      values: ['amazon'],
      conditions: [
        { type: 'geosite', values: ['amazon'] },
        { type: 'ruleSet', values: ['res:geosite-amazon'] },
      ],
      combineMode: 'or',
    });
    expect(enumerateResourceRefs('geosite-amazon', { customRules: [r] })).toHaveLength(1);
  });

  it('应用分流：内置 preset → app 引用（appBuiltin=true, label=labelKey）', () => {
    const appRules: AppRule[] = [{ appId: 'youtube', action: 'proxy', enabled: true }];
    const refs = enumerateResourceRefs('geosite-youtube', { appRules });
    expect(refs).toEqual([{ kind: 'app', id: 'youtube', label: 'youtube', appBuiltin: true }]);
  });

  it('应用分流：内置 preset 的 geoip（netflix 有 geoipTags）→ 命中 geoip-netflix', () => {
    const appRules: AppRule[] = [{ appId: 'netflix', action: 'proxy', enabled: true }];
    expect(enumerateResourceRefs('geoip-netflix', { appRules })).toHaveLength(1);
  });

  it('应用分流：自定义 preset → app 引用（appBuiltin=false, label=name）', () => {
    const appRules: AppRule[] = [{ appId: 'custom-1', action: 'proxy', enabled: true }];
    const customAppPresets: CustomAppPreset[] = [
      { id: 'custom-1', name: '我的应用', emoji: '🌐', geositeTags: ['amazon'] },
    ];
    const refs = enumerateResourceRefs('geosite-amazon', { appRules, customAppPresets });
    expect(refs).toEqual([{ kind: 'app', id: 'custom-1', label: '我的应用', appBuiltin: false }]);
  });

  it('builtin:<tag> 资源 id 归一为 geo tag → 同时被 geo 条件与 app 规则命中', () => {
    const r = rule({ id: 'rE', type: 'geosite', values: ['youtube'] });
    const appRules: AppRule[] = [{ appId: 'youtube', action: 'proxy', enabled: true }];
    const refs = enumerateResourceRefs('builtin:geosite-youtube', { customRules: [r], appRules });
    expect(refs.map((x) => x.kind).sort()).toEqual(['app', 'route']);
  });

  it('禁用的规则 / 禁用的 appRule 不计入', () => {
    const r = rule({ id: 'rF', type: 'geosite', values: ['amazon'], enabled: false });
    const appRules: AppRule[] = [{ appId: 'youtube', action: 'proxy', enabled: false }];
    expect(enumerateResourceRefs('geosite-amazon', { customRules: [r] })).toHaveLength(0);
    expect(enumerateResourceRefs('geosite-youtube', { appRules })).toHaveLength(0);
  });

  it('非 geo 资源 id（res_xxx）：仅 ruleSet res: 命中，不被 geo 条件/app 误命中', () => {
    const r1 = rule({ id: 'rG', type: 'ruleSet', values: ['res:res_abc'] });
    const r2 = rule({ id: 'rH', type: 'geosite', values: ['res_abc'] }); // geosite 条件值恰为 res_abc — 不应命中（资源 id 非 geo 形态）
    expect(enumerateResourceRefs('res_abc', { customRules: [r1, r2] })).toEqual([
      { kind: 'route', id: 'rG', label: 'ruleSet: res:res_abc' },
    ]);
  });
});

describe('isResourceReferenced', () => {
  it('有任意引用 → true；无引用 → false', () => {
    const r = rule({ id: 'rI', type: 'geosite', values: ['amazon'] });
    expect(isResourceReferenced('geosite-amazon', { customRules: [r] })).toBe(true);
    expect(isResourceReferenced('geosite-netflix', { customRules: [r] })).toBe(false);
  });
});
