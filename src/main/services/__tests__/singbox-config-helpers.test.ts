/**
 * config-gen 共享纯 helper 单测 —— 锁 getNodeResolverTag 档位矩阵 + IP 字面量判定 + 用户规则 gate。
 * 这些函数原为 ProxyManager 私有方法、无覆盖测试；抽到 singbox-config-helpers 后补纯逻辑回归基线。
 */
import {
  isIpv4Host,
  isIpv6Host,
  stripHostBrackets,
  hostToExcludeCidr,
  getNodeResolverTag,
  effectiveCustomRules,
  effectiveAppRules,
  getCustomDomesticDnsEndpoint,
  getRequiredGeoCategories,
} from '../singbox-config-helpers';
import type { UserConfig, Rule, AppRule } from '../../../shared/types';
import { parseDnsServerSpec } from '../../../shared/dns';

describe('isIpv4Host', () => {
  it('真 IPv4 字面量', () => {
    expect(isIpv4Host('1.2.3.4')).toBe(true);
    expect(isIpv4Host('223.5.5.5')).toBe(true);
  });
  it('域名 / IPv6 / 非法 → false', () => {
    expect(isIpv4Host('example.com')).toBe(false);
    expect(isIpv4Host('::1')).toBe(false);
    expect(isIpv4Host('999.1.1.1')).toBe(false); // shared/ip.isIpv4 严格判定
  });
});

describe('isIpv6Host', () => {
  it('IPv6 字面量（含冒号且仅 hex/:）', () => {
    expect(isIpv6Host('::1')).toBe(true);
    expect(isIpv6Host('2001:db8::1')).toBe(true);
    expect(isIpv6Host('fe80::1')).toBe(true);
  });
  it('IPv4 / 域名 / 无冒号 → false', () => {
    expect(isIpv6Host('1.2.3.4')).toBe(false);
    expect(isIpv6Host('example.com')).toBe(false);
    expect(isIpv6Host('abcd')).toBe(false); // 无冒号
  });
  it('R4-1：IPv4-mapped/embedded（末段点分 IPv4）→ true，与 api-client target() 一致', () => {
    expect(isIpv6Host('::ffff:1.2.3.4')).toBe(true);
    expect(isIpv6Host('::1.2.3.4')).toBe(true);
    expect(isIpv6Host('[::ffff:1.2.3.4]')).toBe(true); // 带方括号亦纳入
    // 末段非严格 IPv4（>255）→ 拒（不误判畸形串为 IPv6）
    expect(isIpv6Host('::ffff:1.2.3.999')).toBe(false);
    // 仅 1 个冒号（IP:port 裸输入）→ 仍 false
    expect(isIpv6Host('8.8.8.8:53')).toBe(false);
  });
  it('zone-id（含 %）→ false（% 非 hex 字符，不被误收为合法 IPv6）', () => {
    expect(isIpv6Host('fe80::1%eth0')).toBe(false);
  });
});

describe('stripHostBrackets — 仅配对方括号脱，畸形原样返回（R4-2）', () => {
  it('配对方括号 → 脱括号', () => {
    expect(stripHostBrackets('[::1]')).toBe('::1');
    expect(stripHostBrackets('[2001:db8::1]')).toBe('2001:db8::1');
    expect(stripHostBrackets('[]')).toBe('');
  });
  it('裸地址 / 域名 / IPv4 → 原样', () => {
    expect(stripHostBrackets('::1')).toBe('::1');
    expect(stripHostBrackets('1.2.3.4')).toBe('1.2.3.4');
    expect(stripHostBrackets('example.com')).toBe('example.com');
    expect(stripHostBrackets('')).toBe('');
  });
  it('单边括号（畸形）→ 原样返回（不截成误判 IP 形态）', () => {
    expect(stripHostBrackets('[::1')).toBe('[::1');
    expect(stripHostBrackets('::1]')).toBe('::1]');
  });
});

describe('hostToExcludeCidr — 真 IP 才产 CIDR，非 IP/空/畸形 → null（R4-2/R4-4）', () => {
  it('裸 IPv4 → /32', () => {
    expect(hostToExcludeCidr('1.2.3.4')).toBe('1.2.3.4/32');
    expect(hostToExcludeCidr('223.5.5.5')).toBe('223.5.5.5/32');
  });
  it('裸 / 带括号 IPv6 → /128（去括号后）', () => {
    expect(hostToExcludeCidr('::1')).toBe('::1/128');
    expect(hostToExcludeCidr('2001:db8::1')).toBe('2001:db8::1/128');
    expect(hostToExcludeCidr('[::1]')).toBe('::1/128'); // 脱括号后再拼，非 '[::1]/128'
  });
  it('IPv4-mapped → /128（R4-1 与 isIpv6Host 同口径）', () => {
    expect(hostToExcludeCidr('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.4/128');
    expect(hostToExcludeCidr('[::ffff:1.2.3.4]')).toBe('::ffff:1.2.3.4/128');
  });
  it('空串 / [] / 单边括号 / 域名 / 非法 IP → null（不产非法 /32）', () => {
    expect(hostToExcludeCidr('')).toBeNull();
    expect(hostToExcludeCidr('[]')).toBeNull(); // 脱括号→空串→null（旧实现会拼非法 '/32'）
    expect(hostToExcludeCidr('[::1')).toBeNull(); // 单边括号畸形非 IP
    expect(hostToExcludeCidr('example.com')).toBeNull();
    expect(hostToExcludeCidr('999.1.1.1')).toBeNull(); // 非严格 IPv4
  });
});

describe('getNodeResolverTag — issue #147：race on→dns-node-race / off→档位矩阵', () => {
  const mk = (over: Partial<UserConfig>): UserConfig => over as unknown as UserConfig;
  // race off（逃生/降级 / snapshot·preflight 路径）才走单上游矩阵；race server 就绪时 ProxyManager 才置 config on。
  const off = (resolver?: string): Partial<UserConfig> =>
    ({
      dnsConfig: {
        resolveNodeDomainsAhead: false,
        ...(resolver ? { nodeDomainResolver: resolver } : {}),
      },
    }) as unknown as Partial<UserConfig>;

  it('race on（缺省 resolveNodeDomainsAhead）→ dns-node-race（dial 与 rule 同）', () => {
    expect(getNodeResolverTag(mk({ dnsConfig: {} as any }), 'dial')).toBe('dns-node-race');
    expect(getNodeResolverTag(mk({ dnsConfig: {} as any }), 'rule')).toBe('dns-node-race');
  });

  it('off + auto（缺省档）：dial=dns-bootstrap / rule=dns-domestic（两路径不同档）', () => {
    expect(getNodeResolverTag(mk(off('auto')), 'dial')).toBe('dns-bootstrap');
    expect(getNodeResolverTag(mk(off('auto')), 'rule')).toBe('dns-domestic');
  });

  it('off + dnspod → dns-node（两 ctx 一致）', () => {
    const c = mk(off('dnspod'));
    expect(getNodeResolverTag(c, 'dial')).toBe('dns-node');
    expect(getNodeResolverTag(c, 'rule')).toBe('dns-node');
  });

  it('off + system → dns-local；INV-1：TUN 下 rule ctx 强制 dns-node 防递归', () => {
    const sys = mk(off('system'));
    expect(getNodeResolverTag(sys, 'dial')).toBe('dns-local');
    expect(getNodeResolverTag(sys, 'rule')).toBe('dns-local'); // 非 TUN
    const sysTun = mk({ ...off('system'), proxyModeType: 'tun' });
    expect(getNodeResolverTag(sysTun, 'dial')).toBe('dns-local'); // dial 不受 INV-1
    expect(getNodeResolverTag(sysTun, 'rule')).toBe('dns-node'); // INV-1
  });
});

describe('effectiveCustomRules — 用户路由规则仅 smart 生效', () => {
  const rules = [
    { id: 'r1', type: 'domainSuffix', values: ['x.com'], action: 'proxy', enabled: true },
  ];
  const mk = (over: Partial<UserConfig>): UserConfig => over as unknown as UserConfig;

  it('smart（含缺省）→ 返回 customRules', () => {
    expect(effectiveCustomRules(mk({ proxyMode: 'smart', customRules: rules as any }))).toEqual(
      rules
    );
    expect(effectiveCustomRules(mk({ customRules: rules as any }))).toEqual(rules); // 缺省 smart
  });
  it('global / direct → 空数组（忽略用户分流）', () => {
    expect(effectiveCustomRules(mk({ proxyMode: 'global', customRules: rules as any }))).toEqual(
      []
    );
    expect(effectiveCustomRules(mk({ proxyMode: 'direct', customRules: rules as any }))).toEqual(
      []
    );
  });
  it('customRules 缺省 → 空数组', () => {
    expect(effectiveCustomRules(mk({ proxyMode: 'smart' }))).toEqual([]);
  });
});

describe('effectiveAppRules — 应用分流总开关 + 仅 smart 双 gate', () => {
  const appRules = [{ appId: 'telegram', action: 'proxy', enabled: true }];
  const mk = (over: Partial<UserConfig>): UserConfig => over as unknown as UserConfig;

  it('开关开 + smart → 返回 appRules', () => {
    expect(
      effectiveAppRules(
        mk({ appRoutingEnabled: true, proxyMode: 'smart', appRules: appRules as any })
      )
    ).toEqual(appRules);
  });
  it('开关关（默认）→ 空数组（开关优先于模式）', () => {
    expect(effectiveAppRules(mk({ proxyMode: 'smart', appRules: appRules as any }))).toEqual([]); // appRoutingEnabled 缺省 !== true
    expect(
      effectiveAppRules(
        mk({ appRoutingEnabled: false, proxyMode: 'smart', appRules: appRules as any })
      )
    ).toEqual([]);
  });
  it('开关开但 global / direct → 空数组', () => {
    expect(
      effectiveAppRules(
        mk({ appRoutingEnabled: true, proxyMode: 'global', appRules: appRules as any })
      )
    ).toEqual([]);
    expect(
      effectiveAppRules(
        mk({ appRoutingEnabled: true, proxyMode: 'direct', appRules: appRules as any })
      )
    ).toEqual([]);
  });
});

describe('getCustomDomesticDnsEndpoint — 国内 DNS 为 IP 字面量才返回端点', () => {
  const mk = (domesticDns?: string): UserConfig =>
    ({ dnsConfig: { domesticDns } }) as unknown as UserConfig;

  it('IP 型 DNS（udp://223.6.6.6 / 裸 IP）→ {ip, port}', () => {
    expect(getCustomDomesticDnsEndpoint(mk('udp://223.6.6.6'))).toEqual({
      ip: '223.6.6.6',
      port: 53,
    });
    expect(getCustomDomesticDnsEndpoint(mk('223.6.6.6'))).toEqual({ ip: '223.6.6.6', port: 53 });
  });
  it('DoH 域名 / 空 / 无效 → null（域名走 dns server，不进直连放行集）', () => {
    expect(getCustomDomesticDnsEndpoint(mk('https://doh.pub/dns-query'))).toBeNull();
    expect(getCustomDomesticDnsEndpoint(mk(undefined))).toBeNull();
    expect(getCustomDomesticDnsEndpoint({} as UserConfig)).toBeNull();
  });
});

// 注：getLocalGeoRuleSets 是 BUILTIN_GEO_RULESETS 的平凡 map，但 bundledPath() 经 ResourceManager 依赖 electron
// 路径解析；其 tag/path 已由 config-snapshot 网端到端覆盖（route 含本地 geo rule_set 定义），此处不再单测以免引入 electron mock。

describe('getRequiredGeoCategories — 扫 customRules + appRules 收集 geo 类别', () => {
  it('customRules 的 geosite/geoip 裸标签（去空、小写化）', () => {
    const rules: Rule[] = [
      {
        id: 'r1',
        type: 'geosite',
        values: ['YouTube', ' netflix '],
        action: 'proxy',
        enabled: true,
      },
      { id: 'r2', type: 'geoip', values: ['CN'], action: 'direct', enabled: true },
      { id: 'r3', type: 'geosite', values: ['disabled'], action: 'proxy', enabled: false }, // 禁用不计
    ] as unknown as Rule[];
    const { geosite, geoip } = getRequiredGeoCategories(rules, [], []);
    expect([...geosite].sort()).toEqual(['netflix', 'youtube']);
    expect([...geoip]).toEqual(['cn']);
  });

  it('appRules 经 preset.geositeTags/geoipTags 收集（禁用不计）', () => {
    const appRules: AppRule[] = [
      { appId: 'custom-a', action: 'proxy', enabled: true },
      { appId: 'custom-b', action: 'proxy', enabled: false },
    ] as unknown as AppRule[];
    const presets = [
      { id: 'custom-a', name: 'A', emoji: '🅰', geositeTags: ['google'], geoipTags: ['us'] },
      { id: 'custom-b', name: 'B', emoji: '🅱', geositeTags: ['bbb'], geoipTags: [] },
    ] as any;
    const { geosite, geoip } = getRequiredGeoCategories([], appRules, presets);
    expect([...geosite]).toEqual(['google']);
    expect([...geoip]).toEqual(['us']);
  });

  it('appRules preset tag 大写/含空白 → trim + 小写归一（对齐 customRules + route 发射端 + 本地 .srs 口径）', () => {
    const appRules: AppRule[] = [
      { appId: 'cap', action: 'proxy', enabled: true },
    ] as unknown as AppRule[];
    const presets = [
      {
        id: 'cap',
        name: 'Cap',
        emoji: '🧢',
        geositeTags: ['YouTube', ' Netflix '],
        geoipTags: ['US'],
      },
    ] as any;
    const { geosite, geoip } = getRequiredGeoCategories([], appRules, presets);
    // 不小写 → 'YouTube' 与本地 geosite-youtube.srs 错位被 fail-closed 剪掉，应规整为小写裸标签。
    expect([...geosite].sort()).toEqual(['netflix', 'youtube']);
    expect([...geoip]).toEqual(['us']);
  });

  it('空输入 → 两空集', () => {
    const { geosite, geoip } = getRequiredGeoCategories([], [], []);
    expect(geosite.size).toBe(0);
    expect(geoip.size).toBe(0);
  });
});

describe('parseDnsServerSpec — 非法输入 → null', () => {
  it('单边左括号（畸形 IPv6）→ null', () => {
    expect(parseDnsServerSpec('[::1')).toBeNull();
  });
});
