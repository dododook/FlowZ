/**
 * 地区分流（4.1.0）单一真值：智能分流的 geo 基线场景。主进程 route/dns 生成 + 渲染端 UI 共用。
 * undefined（存量/新装未改）= 默认中国大陆正向 = 今日智能分流行为 → 零迁移、config-snapshot 默认零变。
 */
import type { RegionId, RegionRoutingConfig } from './types';

export const DEFAULT_REGION_ROUTING: RegionRoutingConfig = {
  enabled: true,
  region: 'cn',
  reverse: false,
};

/** 取生效的地区分流配置；缺省=默认中国大陆正向（=今日行为）。 */
export function effectiveRegionRouting(config: {
  regionRouting?: RegionRoutingConfig;
}): RegionRoutingConfig {
  return config.regionRouting ?? DEFAULT_REGION_ROUTING;
}

/**
 * 各地区「本地」geo rule_set tag（正向→直连 / 反向→代理 的那一组）。tag 与 BUILTIN_GEO_RULESETS 对齐。
 */
export const REGION_LOCAL_GEO: Record<RegionId, { geosite: string[]; geoip: string[] }> = {
  cn: { geosite: ['geosite-cn'], geoip: ['geoip-cn'] },
  ir: { geosite: ['geosite-category-ir'], geoip: ['geoip-ir'] },
  ru: { geosite: ['geosite-category-ru'], geoip: ['geoip-ru'] },
};

/**
 * 各地区「海外」geo（正向→代理 / 反向→直连 的那一组）。仅 CN 有成熟的 geolocation-!cn；
 * ir/ru 无对应的 !ir/!ru 分类 → 空，靠 final 兜底（正向 final=代理覆盖海外，反向 final=直连覆盖海外）。
 */
export const REGION_FOREIGN_GEO: Record<RegionId, { geosite: string[] }> = {
  cn: { geosite: ['geosite-geolocation-!cn'] },
  ir: { geosite: [] },
  ru: { geosite: [] },
};

/**
 * 智能分流「geo 基线层」用到的内置 geo tag 集合（本地 + 海外，随地区）。仅 proxyMode=smart 且地区分流启用时非空；
 * global/direct 或关地区分流 → 空（基线不生效）。供规则资源 referencedBy 计数纳入「系统/智能分流对内置默认
 * (geosite-cn / geoip-cn / geosite-geolocation-!cn 等) 的隐式引用」——否则默认资源恒显 0 引用（用户反馈）。
 */
export function smartBaselineGeoTags(config: {
  proxyMode?: string;
  regionRouting?: RegionRoutingConfig;
}): Set<string> {
  if ((config.proxyMode || 'smart').toLowerCase() !== 'smart') return new Set();
  const rr = effectiveRegionRouting(config);
  if (!rr.enabled) return new Set();
  const local = REGION_LOCAL_GEO[rr.region];
  const foreign = REGION_FOREIGN_GEO[rr.region];
  // 磁盘 JSON 未受 RegionId 编译期约束——手改/旧配置的越界 region（如 'us'）→ 表查空。本函数现也在 renderer
  // (refsByItemId) 每次渲染跑，越界解引用会崩规则资源页，故 fail-safe 返回空集（无基线引用）。
  if (!local || !foreign) return new Set();
  return new Set([...local.geosite, ...local.geoip, ...foreign.geosite]);
}
