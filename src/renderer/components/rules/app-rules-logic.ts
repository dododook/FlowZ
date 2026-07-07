/**
 * 应用分流卡片纯逻辑 —— 从 app-rules-card / app-card 抽出，无 react/store/@别名依赖，可被 .test.ts 直接覆盖
 * 「策略派生 / 策略计数 / 分类分组(空组隐) / 图标回退 / 搜索匹配」矩阵。离线安全网：把展示逻辑锁死，防重构回归。
 */
import type { AppRule } from '../../../shared/types';
import type { AppPreset } from '../../../shared/app-rules-preset';

/**
 * 展示用预设：把内置 AppPreset 与自定义预设归一。category 放宽为 string 以容纳自定义分类
 * （内置为固定 5 类，自定义可为任意用户自建分类名）。
 */
export interface DisplayAppPreset extends Omit<AppPreset, 'category'> {
  category: string;
  /** 自定义应用（custom-* id）：卡片显删除、名称直取（不过 i18n）。 */
  isCustom?: boolean;
}

/**
 * 卡片四态派生：无规则/未启用 = proxy（跟随全局）；direct / block 直读；proxy + targetServerId = node；
 * proxy 无目标 = proxy。与 handlePolicyChange 的写回口径互逆（单一真值，防卡首摘要与实际策略漂移）。
 */
export type AppPolicyKind = 'proxy' | 'node' | 'direct' | 'block';

export function deriveAppPolicy(rule: AppRule | undefined): AppPolicyKind {
  if (!rule || !rule.enabled) return 'proxy';
  if (rule.action === 'direct') return 'direct';
  if (rule.action === 'block') return 'block';
  return rule.targetServerId ? 'node' : 'proxy';
}

export interface PolicyCounts {
  total: number;
  proxy: number;
  node: number;
  direct: number;
  block: number;
}

/** 统计各出站策略应用数（over 全部预设，逐个派生四态）：供顶部策略计数摘要。 */
export function countAppPolicies(
  presetIds: string[],
  ruleOf: (id: string) => AppRule | undefined
): PolicyCounts {
  const c: PolicyCounts = { total: presetIds.length, proxy: 0, node: 0, direct: 0, block: 0 };
  for (const id of presetIds) {
    c[deriveAppPolicy(ruleOf(id))] += 1;
  }
  return c;
}

/** 已知内置分类顺序（组头按此排序，自定义分类按首次出现顺序追加其后）。 */
export const KNOWN_CATEGORIES = ['video', 'social', 'ai', 'tools', 'game'] as const;
export type KnownCategory = (typeof KNOWN_CATEGORIES)[number];

export interface AppCategoryGroup<T> {
  category: string;
  presets: T[];
}

/**
 * 按分类分组（空组隐）：先按 KNOWN_CATEGORIES 顺序，其后自定义分类按首次出现顺序；只产出非空组
 * （某分类无卡 → 整组不出现）。故对「搜索过滤后」的列表调用即天然得到「组内无卡则整组隐」效果。
 */
export function groupPresetsByCategory<T extends { category: string }>(
  presets: T[]
): AppCategoryGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const firstSeen: string[] = [];
  for (const p of presets) {
    const cat = p.category || 'tools';
    let bucket = buckets.get(cat);
    if (!bucket) {
      bucket = [];
      buckets.set(cat, bucket);
      firstSeen.push(cat);
    }
    bucket.push(p);
  }
  const known = KNOWN_CATEGORIES.filter((c) => buckets.has(c));
  const custom = firstSeen.filter((c) => !(KNOWN_CATEGORIES as readonly string[]).includes(c));
  return [...known, ...custom].map((category) => ({
    category,
    presets: buckets.get(category) as T[],
  }));
}

/** 图标回退：有 iconUrl 且未记录加载失败 → 显 img；否则 emoji 兜底（模块级失败缓存跨挂载持久，防闪变）。 */
export type AppIconResolution = { type: 'img'; url: string } | { type: 'emoji'; char: string };

export function resolveAppIcon(
  preset: { iconUrl?: string; emoji: string },
  presetId: string,
  failed?: ReadonlySet<string>
): AppIconResolution {
  if (preset.iconUrl && !failed?.has(presetId)) return { type: 'img', url: preset.iconUrl };
  return { type: 'emoji', char: preset.emoji };
}

/** 搜索匹配：应用名 / geosite / geoip / 进程名 任一命中（大小写不敏感）。空查询恒命中。 */
export function matchesAppSearch(
  preset: { geositeTags?: string[]; geoipTags?: string[]; processNames?: string[] },
  label: string,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (label.toLowerCase().includes(q)) return true;
  const hay = [
    ...(preset.geositeTags || []),
    ...(preset.geoipTags || []),
    ...(preset.processNames || []),
  ];
  return hay.some((h) => h.toLowerCase().includes(q));
}
