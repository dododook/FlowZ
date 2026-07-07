/**
 * 应用分流卡片纯逻辑单测：策略派生 / 策略计数 / 分类分组(空组隐) / 图标回退 / 搜索匹配。
 * 离线安全网：把从 app-rules-card 抽出的展示逻辑锁死，防卡片重构（Select→matrix+.npick）引入回归。
 */
import type { AppRule } from '../../../../shared/types';
import {
  deriveAppPolicy,
  countAppPolicies,
  groupPresetsByCategory,
  resolveAppIcon,
  matchesAppSearch,
  KNOWN_CATEGORIES,
  type DisplayAppPreset,
} from '../app-rules-logic';

const rule = (over: Partial<AppRule>): AppRule => ({
  appId: 'x',
  action: 'proxy',
  enabled: true,
  ...over,
});

describe('deriveAppPolicy', () => {
  it('无规则 / 未启用 → proxy（跟随全局）', () => {
    expect(deriveAppPolicy(undefined)).toBe('proxy');
    expect(deriveAppPolicy(rule({ action: 'direct', enabled: false }))).toBe('proxy');
    expect(deriveAppPolicy(rule({ targetServerId: 's1', enabled: false }))).toBe('proxy');
  });
  it('direct / block 直读', () => {
    expect(deriveAppPolicy(rule({ action: 'direct' }))).toBe('direct');
    expect(deriveAppPolicy(rule({ action: 'block' }))).toBe('block');
  });
  it('proxy + targetServerId → node；proxy 无目标 → proxy', () => {
    expect(deriveAppPolicy(rule({ action: 'proxy', targetServerId: 's1' }))).toBe('node');
    expect(deriveAppPolicy(rule({ action: 'proxy', targetServerId: undefined }))).toBe('proxy');
  });
});

describe('countAppPolicies', () => {
  it('逐个派生四态并计数（含无规则应用计为 proxy）', () => {
    const rules: Record<string, AppRule> = {
      a: rule({ appId: 'a', action: 'proxy' }), // proxy
      b: rule({ appId: 'b', action: 'proxy', targetServerId: 's1' }), // node
      c: rule({ appId: 'c', action: 'direct' }), // direct
      d: rule({ appId: 'd', action: 'block' }), // block
      e: rule({ appId: 'e', enabled: false, action: 'block' }), // → proxy
    };
    const counts = countAppPolicies(
      ['a', 'b', 'c', 'd', 'e', 'f'], // f 无规则 → proxy
      (id) => rules[id]
    );
    // proxy = a(proxy) + e(disabled→proxy) + f(无规则→proxy) = 3
    expect(counts).toEqual({ total: 6, proxy: 3, node: 1, direct: 1, block: 1 });
  });
});

describe('groupPresetsByCategory', () => {
  const mk = (id: string, category: string): DisplayAppPreset => ({
    id,
    labelKey: id,
    emoji: '🌐',
    geositeTags: [id],
    category,
  });

  it('按 KNOWN_CATEGORIES 顺序，自定义分类按首次出现顺序追加其后', () => {
    const groups = groupPresetsByCategory([
      mk('g1', 'game'),
      mk('office1', '办公'),
      mk('v1', 'video'),
      mk('office2', '办公'),
      mk('dl1', '下载'),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['video', 'game', '办公', '下载']);
    // 组内成员保持输入顺序
    expect(groups.find((g) => g.category === '办公')!.presets.map((p) => p.id)).toEqual([
      'office1',
      'office2',
    ]);
  });

  it('空组隐：无成员的分类不出现（对搜索过滤后的列表调用即得空组隐）', () => {
    const groups = groupPresetsByCategory([mk('v1', 'video'), mk('v2', 'video')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('video');
    // social/ai/tools/game 均无成员 → 不出现
    expect(groups.some((g) => g.category === 'social')).toBe(false);
  });

  it('空输入 → 空数组（整体无卡则无组）', () => {
    expect(groupPresetsByCategory([])).toEqual([]);
  });

  it('KNOWN_CATEGORIES 为固定 5 类', () => {
    expect(KNOWN_CATEGORIES).toEqual(['video', 'social', 'ai', 'tools', 'game']);
  });
});

describe('resolveAppIcon', () => {
  it('有 iconUrl 且未失败 → img', () => {
    expect(resolveAppIcon({ iconUrl: 'http://x/y.png', emoji: '🌐' }, 'p1', new Set())).toEqual({
      type: 'img',
      url: 'http://x/y.png',
    });
  });
  it('图标加载失败 → emoji 兜底', () => {
    expect(
      resolveAppIcon({ iconUrl: 'http://x/y.png', emoji: '🎬' }, 'p1', new Set(['p1']))
    ).toEqual({ type: 'emoji', char: '🎬' });
  });
  it('无 iconUrl → emoji 兜底', () => {
    expect(resolveAppIcon({ emoji: '🐙' }, 'p1', undefined)).toEqual({ type: 'emoji', char: '🐙' });
  });
});

describe('matchesAppSearch', () => {
  const preset = {
    geositeTags: ['youtube', 'google'],
    geoipTags: ['netflix'],
    processNames: ['Steam.exe'],
  };
  it('空查询恒命中', () => {
    expect(matchesAppSearch(preset, 'YouTube', '')).toBe(true);
    expect(matchesAppSearch(preset, 'YouTube', '   ')).toBe(true);
  });
  it('命中应用名 / geosite / geoip / 进程名（大小写不敏感）', () => {
    expect(matchesAppSearch(preset, 'YouTube', 'you')).toBe(true); // name
    expect(matchesAppSearch(preset, 'YouTube', 'google')).toBe(true); // geosite
    expect(matchesAppSearch(preset, 'YouTube', 'NETFLIX')).toBe(true); // geoip 大小写
    expect(matchesAppSearch(preset, 'YouTube', 'steam.exe')).toBe(true); // process
  });
  it('全不命中 → false', () => {
    expect(matchesAppSearch(preset, 'YouTube', 'telegram')).toBe(false);
  });
});
