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
