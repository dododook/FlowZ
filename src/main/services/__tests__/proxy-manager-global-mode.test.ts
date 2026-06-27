/**
 * 全局模式语义单测：global = 真·全局（忽略用户分流，一律走选中节点），对齐业内（Clash/Surge/sing-box GUI）。
 *
 * 单一真值 effectiveCustomRules / effectiveAppRules 仅 smart 模式返回规则，global/direct 返回 []；
 * 由此自定义路由规则与应用分流在 global 不进 route emit / 规则选择器 / geo 收集 / TUN 排除。
 * 另跑一遍 generateRouteConfig 端到端断言：global 下无 rule-sel-* 出站（custom/app selector），final 仍 = proxy-selector
 * （一律走选中节点）；smart 下有；direct 下无且 final=direct。私有方法经 `(svc as any)` 直调（跟随既有 proxy-manager 测试风格）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// generateRouteConfig 经 paths/ResourceManager 读 app.getPath('userData')；mock 到临时目录（运行时 .srs 不存在 →
// isValidSrsFile 返 false → 本地 geo 跳过，不影响 rule-sel/ final 断言）。helper 测试不依赖 electron。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-globalmode-'));
jest.mock('electron', () => ({ app: { getPath: () => TMP }, net: {} }));
// ResourceManager.getResourcesBaseDir 生产分支取 process.resourcesPath（jest 下未定义）；指向 TMP 即可——
// getLocalGeoRuleSets 只 string-join bundledPath，运行时 .srs 经 isValidSrsFile(TMP/rules/*) 判缺失而跳过，不读 bundled。
(process as any).resourcesPath = TMP;

import { ProxyManager } from '../ProxyManager';
import { buildCustomRuleFiles } from '../custom-rule-files';
import { effectiveCustomRules, effectiveAppRules } from '../singbox-config-helpers';
import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import type { UserConfig } from '../../../shared/types';

/** generateRouteConfig 已抽到 singbox-route-builder（buildRouteConfig）；注入 deps（端到端断言不依赖 probe/lan/version 细节）。 */
const routeDeps = (): RouteConfigDeps => ({
  probeDirectPort: null,
  probeProxyPort: null,
  updateInPort: null,
  lanResolverForDns: null,
  pendingEndpoints: [],
  log: () => {},
  onDegraded: () => {},
});

function makeSvc(): any {
  return new ProxyManager(
    undefined as any,
    undefined as any,
    '/tmp/flowz-test-globalmode-cfg.json',
    '/fake/sing-box'
  );
}

function makeConfig(proxyMode: 'smart' | 'global' | 'direct'): UserConfig {
  return {
    proxyMode,
    servers: [{ id: 's1', name: 'N1', protocol: 'vless', address: '1.2.3.4', port: 443 }],
    selectedServerId: 's1',
    customRules: [
      { id: 'c1', type: 'domain', values: ['example.com'], action: 'proxy', enabled: true },
    ],
    appRoutingEnabled: true,
    appRules: [{ appId: 'telegram', action: 'proxy', enabled: true }],
  } as unknown as UserConfig;
}

describe('用户路由 gate（effectiveCustomRules / effectiveAppRules 仅 smart）', () => {
  it('smart：返回用户的自定义规则与应用分流', () => {
    const cfg = makeConfig('smart');
    expect(effectiveCustomRules(cfg)).toHaveLength(1);
    expect(effectiveAppRules(cfg)).toHaveLength(1);
  });

  it('global：自定义规则与应用分流均为空（真·全局忽略用户分流）', () => {
    const cfg = makeConfig('global');
    expect(effectiveCustomRules(cfg)).toEqual([]);
    expect(effectiveAppRules(cfg)).toEqual([]);
  });

  it('direct：自定义规则与应用分流均为空', () => {
    const cfg = makeConfig('direct');
    expect(effectiveCustomRules(cfg)).toEqual([]);
    expect(effectiveAppRules(cfg)).toEqual([]);
  });

  it('应用分流总开关关闭：smart 下 appRules 仍为空（开关优先）', () => {
    const cfg = { ...makeConfig('smart'), appRoutingEnabled: false } as UserConfig;
    expect(effectiveAppRules(cfg)).toEqual([]);
    expect(effectiveCustomRules(cfg)).toHaveLength(1); // 自定义规则不受应用分流开关影响
  });
});

describe('generateRouteConfig：global 不 emit 用户分流（端到端）', () => {
  const idMap = new Map([['s1', 'proxy-s1']]);
  const hasRuleSelOutbound = (route: any): boolean =>
    (route.rules || []).some(
      (r: any) => typeof r.outbound === 'string' && r.outbound.startsWith('rule-sel-')
    );

  it('smart：存在 rule-sel-* 出站（自定义/应用分流 selector），final=proxy-selector', () => {
    const route = buildRouteConfig(makeConfig('smart'), idMap, routeDeps());
    expect(hasRuleSelOutbound(route)).toBe(true);
    expect(route.final).toBe('proxy-selector');
  });

  it('global：无 rule-sel-* 出站（用户分流被忽略），final 仍=proxy-selector（一律走选中节点）', () => {
    const route = buildRouteConfig(makeConfig('global'), idMap, routeDeps());
    expect(hasRuleSelOutbound(route)).toBe(false);
    expect(route.final).toBe('proxy-selector');
  });

  it('direct：无 rule-sel-* 出站，final=direct', () => {
    const route = buildRouteConfig(makeConfig('direct'), idMap, routeDeps());
    expect(hasRuleSelOutbound(route)).toBe(false);
    expect(route.final).toBe('direct');
  });

  it('global：功能性强制直连仍保留（LAN 私网 + 节点 IP 排除）', () => {
    const route = buildRouteConfig(makeConfig('global'), idMap, routeDeps());
    const directIpRules = (route.rules || []).filter(
      (r: any) => r.outbound === 'direct' && Array.isArray(r.ip_cidr)
    );
    // LAN/私网直连兜底（防误伤内网/本地服务，与业内全局相比 FlowZ 作为 TUN 客户端保留）
    const hasPrivate = directIpRules.some((r: any) =>
      r.ip_cidr.some((c: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(c))
    );
    expect(hasPrivate).toBe(true);
    // 节点 IP 排除直连（防回流死循环）
    const hasNodeExclude = directIpRules.some((r: any) => r.ip_cidr.includes('1.2.3.4/32'));
    expect(hasNodeExclude).toBe(true);
  });
});

describe('优先级重排 + mesh 重叠提醒', () => {
  const idMap = new Map([['s1', 'proxy-s1']]);
  const wgServer = {
    id: 'wg1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'a',
      peerPublicKey: 'b',
      localAddress: ['10.0.0.2/32'],
      allowedIPs: ['192.168.50.0/24'],
    },
  };
  const vlessServer = { id: 's1', name: 'N1', protocol: 'vless', address: '1.2.3.4', port: 443 };

  it('reorder：自定义规则优先于 bypassLAN（custom ip_cidr 排在私网直连之前）', () => {
    const cfg = {
      ...makeConfig('smart'),
      customRules: [
        { id: 'c1', type: 'ipCidr', values: ['8.8.8.0/24'], action: 'proxy', enabled: true },
      ],
      bypassLAN: true,
    } as unknown as UserConfig;
    const rules = (buildRouteConfig(cfg, idMap, routeDeps()).rules || []) as any[];
    const customIdx = rules.findIndex(
      (r) => Array.isArray(r.ip_cidr) && r.ip_cidr.includes('8.8.8.0/24')
    );
    const bypassIdx = rules.findIndex(
      (r) =>
        r.outbound === 'direct' &&
        Array.isArray(r.ip_cidr) &&
        r.ip_cidr.some((c: string) => c.startsWith('192.168.'))
    );
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(bypassIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeLessThan(bypassIdx); // 用户规则优先级高于 bypassLAN（reorder）
  });

  it('mesh 重叠：自定义 ip_cidr 与组网(WG)段重叠 → 记 warn（非阻断）', () => {
    const logs: Array<[string, string]> = [];
    const deps = { ...routeDeps(), log: (lvl: any, msg: string) => logs.push([lvl, msg]) };
    const cfg = {
      ...makeConfig('smart'),
      servers: [vlessServer, wgServer],
      customRules: [
        { id: 'c1', type: 'ipCidr', values: ['192.168.50.128/25'], action: 'proxy', enabled: true },
      ],
    } as unknown as UserConfig;
    buildRouteConfig(cfg, idMap, deps);
    expect(logs.some(([lvl, msg]) => lvl === 'warn' && msg.includes('组网'))).toBe(true);
  });

  it('mesh 不重叠（172.16 vs 组网 192.168.50）→ 不 warn', () => {
    const logs: Array<[string, string]> = [];
    const deps = { ...routeDeps(), log: (lvl: any, msg: string) => logs.push([lvl, msg]) };
    const cfg = {
      ...makeConfig('smart'),
      servers: [vlessServer, wgServer],
      customRules: [
        { id: 'c1', type: 'ipCidr', values: ['172.16.0.0/24'], action: 'proxy', enabled: true },
      ],
    } as unknown as UserConfig;
    buildRouteConfig(cfg, idMap, deps);
    expect(logs.some(([lvl, msg]) => lvl === 'warn' && msg.includes('组网'))).toBe(false);
  });
});

describe('D7：选中 off-mesh 主节点 → 外网出口回退 direct（global+smart）', () => {
  const offWg = (allowedIPs: string[], allowInternet: boolean) => ({
    id: 'wg1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'a',
      peerPublicKey: 'b',
      localAddress: ['10.0.0.2/32'],
      allowedIPs,
      allowInternet,
    },
  });
  const cfg = (
    proxyMode: 'smart' | 'global',
    allowInternet: boolean,
    blockQuic = false
  ): UserConfig =>
    ({
      proxyMode,
      servers: [offWg(['10.8.0.0/24'], allowInternet)],
      selectedServerId: 'wg1',
      blockQuic,
    }) as unknown as UserConfig;
  const idMap = new Map([['wg1', 'proxy-wg1']]);
  // 用 domain_keyword(google) + final 断言「→代理」出口：geosite-!cn 是 rule_set，本测试环境无 .srs →
  // 该 rule_set 规则会被悬空引用剪枝移除（与现有 smart 测试同），故不依赖它；google 关键词规则恒在。
  const googleRule = (route: any) =>
    (route.rules || []).find(
      (r: any) =>
        Array.isArray(r.domain_keyword) &&
        r.domain_keyword.includes('google') &&
        r.action === 'route'
    );

  it('smart + off WG 主节点 → final/google 均 direct（消除海外黑洞）', () => {
    const route = buildRouteConfig(cfg('smart', false), idMap, routeDeps());
    expect(route.final).toBe('direct');
    expect(googleRule(route)?.outbound).toBe('direct');
  });

  it('global + off WG 主节点 → final direct（D4 原有，保持）', () => {
    expect(buildRouteConfig(cfg('global', false), idMap, routeDeps()).final).toBe('direct');
  });

  it('对照：smart + on WG 主节点 → final/google = proxy-selector（不回退）', () => {
    const route = buildRouteConfig(cfg('smart', true), idMap, routeDeps());
    expect(route.final).toBe('proxy-selector');
    expect(googleRule(route)?.outbound).toBe('proxy-selector');
  });

  it('smart + off WG + blockQuic → google/foreign 走 direct 且其前不配对 UDP443 reject', () => {
    const route = buildRouteConfig(cfg('smart', false, true), idMap, routeDeps());
    const rules = (route.rules || []) as any[];
    const gIdx = rules.findIndex(
      (r) =>
        Array.isArray(r.domain_keyword) &&
        r.domain_keyword.includes('google') &&
        r.action === 'route'
    );
    expect(gIdx).toBeGreaterThanOrEqual(0);
    expect(rules[gIdx].outbound).toBe('direct');
    const prev = rules[gIdx - 1];
    const prevIsGoogleUdpReject =
      !!prev &&
      prev.action === 'reject' &&
      Array.isArray(prev.port) &&
      prev.port.includes(443) &&
      Array.isArray(prev.domain_keyword) &&
      prev.domain_keyword.includes('google');
    expect(prevIsGoogleUdpReject).toBe(false);
  });
});

describe('configGenerationNorm：global 下用户路由变更不翻转 norm（免无谓重启）', () => {
  const svc = makeSvc();
  const addRule = (cfg: UserConfig): UserConfig =>
    ({
      ...cfg,
      customRules: [
        ...((cfg.customRules as any) || []),
        { id: 'c2', type: 'domain', values: ['x.com'], action: 'proxy', enabled: true },
      ],
    }) as UserConfig;

  it('global：新增自定义规则 → norm 不变（生成的 sing-box 配置等价 → 不重启）', () => {
    const base = makeConfig('global');
    expect(svc.configGenerationNorm(base)).toBe(svc.configGenerationNorm(addRule(base)));
  });

  it('global：移除应用分流 → norm 不变', () => {
    const base = makeConfig('global');
    expect(svc.configGenerationNorm(base)).toBe(
      svc.configGenerationNorm({ ...base, appRules: [] } as UserConfig)
    );
  });

  it('smart：同样新增自定义规则 → norm 改变（fix 是 mode-specific，非一刀切忽略）', () => {
    const base = makeConfig('smart');
    expect(svc.configGenerationNorm(base)).not.toBe(svc.configGenerationNorm(addRule(base)));
  });
});

describe('buildCustomRuleFiles：仅 smart 外化（global/direct 返空集 → 外化文件按孤儿清扫）', () => {
  // 全 EXT 可表达（纯 domain 条件）→ smart 下应外化落盘 1 个文件
  const extRuleCfg = (proxyMode: 'smart' | 'global' | 'direct'): UserConfig =>
    ({
      proxyMode,
      dnsConfig: { enableFakeIp: true },
      customRules: [
        { id: 'c1', type: 'domain', values: ['ext.com'], action: 'proxy', enabled: true },
      ],
    }) as unknown as UserConfig;

  it('smart：外化文件非空', () => {
    expect(buildCustomRuleFiles(extRuleCfg('smart')).size).toBeGreaterThan(0);
  });
  it('global：外化文件为空集（无消费者）', () => {
    expect(buildCustomRuleFiles(extRuleCfg('global')).size).toBe(0);
  });
  it('direct：外化文件为空集', () => {
    expect(buildCustomRuleFiles(extRuleCfg('direct')).size).toBe(0);
  });
});
