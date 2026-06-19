import {
  effectiveRegionRouting,
  DEFAULT_REGION_ROUTING,
  REGION_LOCAL_GEO,
  REGION_FOREIGN_GEO,
} from '../region-routing';

describe('region-routing 单一真值', () => {
  it('undefined → 默认中国大陆正向（=今日智能分流行为，零迁移）', () => {
    expect(effectiveRegionRouting({})).toEqual({ enabled: true, region: 'cn', reverse: false });
    expect(effectiveRegionRouting({ regionRouting: undefined })).toEqual(DEFAULT_REGION_ROUTING);
  });

  it('显式配置原样返回（不被默认覆盖）', () => {
    const r = { enabled: false, region: 'ir' as const, reverse: true };
    expect(effectiveRegionRouting({ regionRouting: r })).toBe(r);
  });

  it('地区 geo 映射与内置 .srs tag(BUILTIN_GEO_RULESETS)对齐', () => {
    expect(REGION_LOCAL_GEO.cn).toEqual({ geosite: ['geosite-cn'], geoip: ['geoip-cn'] });
    expect(REGION_LOCAL_GEO.ir).toEqual({ geosite: ['geosite-category-ir'], geoip: ['geoip-ir'] });
    expect(REGION_LOCAL_GEO.ru).toEqual({ geosite: ['geosite-category-ru'], geoip: ['geoip-ru'] });
  });

  it('海外 geo：仅 CN 有成熟 !cn 分类，ir/ru 空（靠 final 兜底）', () => {
    expect(REGION_FOREIGN_GEO.cn.geosite).toEqual(['geosite-geolocation-!cn']);
    expect(REGION_FOREIGN_GEO.ir.geosite).toEqual([]);
    expect(REGION_FOREIGN_GEO.ru.geosite).toEqual([]);
  });
});
