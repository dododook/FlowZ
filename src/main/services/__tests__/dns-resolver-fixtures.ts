/**
 * #57 DNS 解析器测试夹具：构造 3 档 × 3 模式 UserConfig + 提取生成 config 的 dns/route 关键段。
 * 共享给 baseline 采集脚本与 dns-resolver.test.ts。
 */
import type { UserConfig, ServerConfig, ProxyModeType } from '../../../shared/types';

/** 两个带域名的节点（rule1 全量化断言要≥2 个 + 含 serverName） + 一个 IP 字面量节点（须被 rule1 过滤）。 */
export const NODE_A: ServerConfig = {
  id: 'node-a',
  name: '香港 A',
  protocol: 'vless' as ServerConfig['protocol'],
  address: 'a.example-argo.com',
  port: 443,
  uuid: '00000000-0000-0000-0000-00000000000a',
  tlsSettings: { serverName: 'sni-a.example.net' },
};
export const NODE_B: ServerConfig = {
  id: 'node-b',
  name: '美国 B',
  protocol: 'trojan' as ServerConfig['protocol'],
  address: 'b.trycloudflare.com',
  port: 443,
  password: 'pw',
  tlsSettings: { serverName: 'b.trycloudflare.com' },
};
export const NODE_IP: ServerConfig = {
  id: 'node-ip',
  name: 'IP 节点',
  protocol: 'trojan' as ServerConfig['protocol'],
  address: '203.0.113.7',
  port: 443,
  password: 'pw',
};

/** 全部节点域名集（address + serverName，去 IP 字面量）：a.example-argo.com / sni-a.example.net / b.trycloudflare.com。 */
export const EXPECTED_NODE_DOMAINS = [
  'a.example-argo.com',
  'sni-a.example.net',
  'b.trycloudflare.com',
];

type Resolver = 'auto' | 'dnspod' | 'system' | undefined;

function baseConfig(modeType: ProxyModeType, resolver: Resolver): UserConfig {
  // FakeIP 开关统一后 usesFakeIp 纯看 enableFakeIp。这些 #57 夹具的 FakeIP 状态须与改前等价
  // （旧语义：非 systemProxy 恒 FakeIP-on、systemProxy 看开关=off），否则 fakeip server/规则 + reverse_mapping
  // 会改变生成物、破坏正交的 #57 baseline byte-diff。故显式按模式声明 enableFakeIp：tun→true、systemProxy→false。
  const dnsConfig: Record<string, unknown> = {
    domesticDns: 'https://doh.pub/dns-query',
    foreignDns: 'https://dns.google/dns-query',
    enableFakeIp: modeType.toLowerCase() !== 'systemproxy',
  };
  if (resolver !== undefined) dnsConfig.nodeDomainResolver = resolver;
  return {
    subscriptions: [],
    servers: [NODE_A, NODE_B, NODE_IP],
    selectedServerId: 'node-a',
    proxyMode: 'smart',
    proxyModeType: modeType,
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: true,
    autoCheckUpdate: true,
    autoLightweightMode: false,
    autoUpdateSubscriptionOnStart: false,
    subscriptionUpdateIntervalHours: 12,
    subscriptionProxyPolicy: 'follow',
    mainSessionViaProxy: true,
    rememberWindowSize: false,
    enableIPv6: false,
    autoPrivacyMode: false,
    privacyPassword: '',
    dnsConfig: dnsConfig as unknown as UserConfig['dnsConfig'],
    customRuleSets: [],
    appRules: [],
    appRoutingEnabled: true,
    socksPort: 2081,
    httpPort: 2080,
    logLevel: 'info',
    disableLogFile: false,
    clashApiSecret: 'fixedsecret0000000000000000000000',
    uiTheme: 'system',
  } as unknown as UserConfig;
}

export interface Fixture {
  name: string;
  resolver: Resolver;
  modeType: ProxyModeType;
  /** 期望节点 dial / rule1 的 resolver tag。 */
  expectDialTag: string;
  expectRuleTag: string;
  config: UserConfig;
}

/**
 * 3 档 × 3 模式。modeType: tun(smart) / tun(global) / systemProxy。
 * 期望 tag（依最终决策）：
 *  - auto/缺字段：dial=dns-bootstrap（AliDNS 现状）；rule=dns-domestic（doh.pub 现状，忠实保留，不与 dial 统一）
 *  - dnspod：dial=rule=dns-node
 *  - system：dial=dns-local；rule：TUN 强制 dns-node（INV-1），systemProxy=dns-local
 */
export function buildFixtures(): Fixture[] {
  const out: Fixture[] = [];
  const modes: { key: string; modeType: ProxyModeType; proxyMode: 'smart' | 'global' }[] = [
    { key: 'tun-smart', modeType: 'tun', proxyMode: 'smart' },
    { key: 'tun-global', modeType: 'tun', proxyMode: 'global' },
    { key: 'systemproxy', modeType: 'systemProxy', proxyMode: 'smart' },
  ];
  const resolvers: { key: string; resolver: Resolver }[] = [
    { key: 'auto', resolver: undefined }, // 缺字段 = auto（基线）
    { key: 'autoExplicit', resolver: 'auto' },
    { key: 'dnspod', resolver: 'dnspod' },
    { key: 'system', resolver: 'system' },
  ];
  for (const m of modes) {
    for (const r of resolvers) {
      const config = baseConfig(m.modeType, r.resolver);
      config.proxyMode = m.proxyMode;
      const isTun = m.modeType === 'tun';
      // auto/缺字段：dial=dns-bootstrap（AliDNS 现状）；rule=dns-domestic（doh.pub 现状，忠实保留，不统一）。
      let dialTag = 'dns-bootstrap';
      let ruleTag = 'dns-domestic';
      if (r.resolver === 'dnspod') {
        dialTag = 'dns-node';
        ruleTag = 'dns-node';
      } else if (r.resolver === 'system') {
        dialTag = 'dns-local';
        ruleTag = isTun ? 'dns-node' : 'dns-local';
      }
      out.push({
        name: `${m.key}__${r.key}`,
        resolver: r.resolver,
        modeType: m.modeType,
        expectDialTag: dialTag,
        expectRuleTag: ruleTag,
        config,
      });
    }
  }
  return out;
}

/** 抽取生成 config 的 dns 段、route 关键直连规则、节点 outbound 的 domain_resolver。byte-diff 用。 */
export function extractDnsRoute(cfg: any) {
  const outbounds = (cfg.outbounds || [])
    .filter((o: any) => o.type !== 'selector' && o.type !== 'direct' && o.type !== 'block')
    .map((o: any) => ({ tag: o.tag, type: o.type, domain_resolver: o.domain_resolver }));
  return {
    dns: cfg.dns,
    routeRules: cfg.route?.rules,
    routeDefaultDomainResolver: cfg.route?.default_domain_resolver,
    inbounds: (cfg.inbounds || []).map((i: any) => ({
      type: i.type,
      tag: i.tag,
      route_exclude_address: i.route_exclude_address,
    })),
    outboundResolvers: outbounds,
  };
}
