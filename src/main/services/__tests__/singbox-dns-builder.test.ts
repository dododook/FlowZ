/**
 * singbox-dns-builder P4b 单测：Tailscale 按名解析（tailscale DNS server + preferred_by）。
 *
 * 字段 schema 经 resources/linux/sing-box check（1.14-alpha.32）实证：
 *  - tailscale DNS server：{type:'tailscale', endpoint:<ts endpoint tag>(必填), accept_search_domain?, accept_default_resolvers?}
 *  - preferred_by：DNS rule item，Listable[string]，配 action:'route' + server 指向同一 tailscale server
 *
 * 覆盖：① 选中 tailscale 节点 + resolveByName=true → 注入 dns-tailscale server(accept_search_domain) +
 *   preferred_by 规则置于规则链最前（先于 catch-all）；endpoint 引用 = 选中节点 tag（=节点名）。
 * ② acceptDefaultResolvers 联动：仅 acceptDefaultResolvers=true 才下发 accept_default_resolvers。
 * ③ resolveByName 关 / 选中非 tailscale 节点 → 不注入（与 doh.pub/google 并存、零副作用）。
 */

// getCustomRulesDir / getRuleSetRuntimeDir 依赖 electron app → mock 成固定 tmp，避免 buildDnsConfig 间接触 electron。
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => '/tmp/flowz-dns-builder-test',
  getCustomRulesDir: () => '/tmp/flowz-dns-builder-test/rules',
}));

import { buildDnsConfig } from '../singbox-dns-builder';
import { buildIdToTagMap } from '../singbox-config-helpers';
import type { UserConfig, ServerConfig } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';

const tsNode = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 'ts1',
    name: 'MyMeshNode',
    protocol: 'tailscale',
    tailscaleSettings: { resolveByName: true },
    ...over,
  }) as unknown as ServerConfig;

const baseConfig = (servers: ServerConfig[], selectedServerId: string | null): UserConfig =>
  ({
    servers,
    selectedServerId,
    // global 模式 + 关 FakeIP：跳过 smart-mode geo / fakeip 路径（不触 fs），聚焦 P4b 注入。
    proxyMode: 'global',
    proxyModeType: 'tun',
    enableIPv6: false,
    dnsConfig: { enableFakeIp: false },
  }) as unknown as UserConfig;

const noopLog = () => {};
const build = (config: UserConfig) => {
  const idToTagMap = buildIdToTagMap(config.servers);
  // 根治 §3.5：tailnet gate 放宽后需 pendingEndpoints 含「已发射」endpoint。模拟 tailscale/wireguard 节点全发射。
  const pendingEndpoints = config.servers
    .filter((s) => ['tailscale', 'wireguard'].includes(s.protocol.toLowerCase()))
    .map((s) => ({ type: s.protocol.toLowerCase(), tag: idToTagMap.get(s.id) }) as never);
  return buildDnsConfig(config, 'proxy-selector', null, idToTagMap, noopLog, 0, pendingEndpoints);
};

describe('buildDnsConfig — P4b Tailscale 按名解析', () => {
  it('选中 tailscale 节点 + resolveByName → 注入 dns-tailscale server + preferred_by(最前) + endpoint 引用节点 tag', () => {
    const dns = build(baseConfig([tsNode()], 'ts1'));

    const tsServer = dns.servers.find((s) => s.type === 'tailscale');
    expect(tsServer).toBeDefined();
    expect(tsServer!.tag).toBe('dns-tailscale');
    // endpoint 必填，引用选中节点的 tag（=节点显示名）
    expect(tsServer!.endpoint).toBe('MyMeshNode');
    expect(tsServer!.accept_search_domain).toBe(true);
    // 未开 acceptDefaultResolvers → 不下发该字段
    expect(tsServer!.accept_default_resolvers).toBeUndefined();

    // preferred_by 规则存在、置于规则链最前（先于无条件 catch-all，否则永不命中）
    const firstRule = dns.rules![0];
    expect(firstRule.preferred_by).toEqual(['dns-tailscale']);
    expect(firstRule.action).toBe('route');
    expect(firstRule.server).toBe('dns-tailscale');
    // catch-all（无 preferred_by / 无 domain* 条件的 fallthrough）应在 preferred_by 之后
    const catchAllIdx = dns.rules!.findIndex(
      (r) => !r.preferred_by && !r.domain && !r.domain_suffix && !r.domain_keyword && !r.rule_set
    );
    expect(catchAllIdx).toBeGreaterThan(0);
  });

  it('acceptDefaultResolvers=true → 下发 accept_default_resolvers', () => {
    const dns = build(
      baseConfig(
        [tsNode({ tailscaleSettings: { resolveByName: true, acceptDefaultResolvers: true } })],
        'ts1'
      )
    );
    const tsServer = dns.servers.find((s) => s.type === 'tailscale');
    expect(tsServer!.accept_default_resolvers).toBe(true);
  });

  it('resolveByName 关 → 不注入 tailscale DNS server / preferred_by 规则', () => {
    const dns = build(baseConfig([tsNode({ tailscaleSettings: { resolveByName: false } })], 'ts1'));
    expect(dns.servers.find((s) => s.type === 'tailscale')).toBeUndefined();
    expect(dns.rules!.some((r) => r.preferred_by)).toBe(false);
  });

  it('根治 §3.5：选中非 tailscale 但有 resolveByName 的 TS 已发射 → 仍注入（gate 放宽=组网即生效，不绑主出口）', () => {
    const other = { id: 'p1', name: 'PlainNode', protocol: 'vless' } as unknown as ServerConfig;
    const dns = build(baseConfig([other, tsNode()], 'p1'));
    const tsServer = dns.servers.find((s) => s.type === 'tailscale');
    expect(tsServer).toBeDefined();
    // 引用那个 resolveByName 的 TS（非选中的 p1），证明不再绑主出口
    expect(tsServer!.endpoint).toBe('MyMeshNode');
    expect(dns.rules!.some((r) => r.preferred_by?.includes('dns-tailscale'))).toBe(true);
  });

  it('根治 §3.5：resolveByName 的 TS 未发射（不在 pendingEndpoints）→ 不注入（防悬空引用 FATAL）', () => {
    const idToTagMap = buildIdToTagMap([tsNode()]);
    // 不传 pendingEndpoints（默认 []）= TS endpoint 未发射 → tailnet 解析跳过
    const dns = buildDnsConfig(baseConfig([tsNode()], 'ts1'), 'proxy-selector', null, idToTagMap, noopLog);
    expect(dns.servers.find((s) => s.type === 'tailscale')).toBeUndefined();
    expect(dns.rules!.some((r) => r.preferred_by)).toBe(false);
  });

  it('根治 §3.5：其它节点已发射但该 TS 自身未发射 → 不注入（gate 按该 TS 的 tag，非「pendingEndpoints 非空」）', () => {
    const ts = tsNode(); // id=ts1, tag=MyMeshNode
    const wg = { id: 'w1', name: 'WG', protocol: 'wireguard' } as unknown as ServerConfig;
    const idToTagMap = buildIdToTagMap([wg, ts]);
    // pendingEndpoints 非空但只含 wg（模拟 TS 被 system-interface/reverseMesh gate 跳过、未发射）→ 仍须跳过 tailnet 解析
    const pending = [{ type: 'wireguard', tag: idToTagMap.get('w1') } as never];
    const dns = buildDnsConfig(
      baseConfig([wg, ts], 'ts1'),
      'proxy-selector',
      null,
      idToTagMap,
      noopLog,
      0,
      pending
    );
    expect(dns.servers.find((s) => s.type === 'tailscale')).toBeUndefined();
    expect(dns.rules!.some((r) => r.preferred_by)).toBe(false);
  });

  it('endpoint tag 去重：同名节点在前占用基名 → 选中节点 tag 追加 (n)，endpoint 引用一致', () => {
    const dup = tsNode({
      id: 'dup',
      name: 'MyMeshNode',
      protocol: 'vless',
    } as Partial<ServerConfig>);
    const sel = tsNode({ id: 'ts1', name: 'MyMeshNode' });
    const dns = build(baseConfig([dup, sel], 'ts1'));
    const tsServer = dns.servers.find((s) => s.type === 'tailscale');
    // 第一个 MyMeshNode 占基名，选中节点 tag = "MyMeshNode (1)"
    expect(tsServer!.endpoint).toBe('MyMeshNode (1)');
  });
});

describe('根治 §3.6：dns-bootstrap-udp 已删 + DoH server 域名解析改 IP-DoH', () => {
  it('dns.servers 无 dns-bootstrap-udp；DoH server 域名(doh.pub)解析 rule 用 dns-bootstrap(IP-DoH 非 UDP53)', () => {
    const dns = build(baseConfig([tsNode()], 'ts1'));
    // ① 历史残留 dns-bootstrap-udp server 已删（positive assertion，防未来回退明文 UDP53、违背「IP-DoH 避免 UDP53」自定设计）
    expect(dns.servers.some((s) => s.tag === 'dns-bootstrap-udp')).toBe(false);
    // DoH server 自身域名解析 rule 改指 dns-bootstrap（https IP-DoH，抗 UDP53 劫持）
    const bootRule = dns.rules!.find(
      (r) => Array.isArray(r.domain) && (r.domain as string[]).includes('doh.pub')
    );
    expect(bootRule).toBeDefined();
    expect(bootRule!.server).toBe('dns-bootstrap');
  });
});

/**
 * singbox-dns-builder P2b/P2c 单测：乐观 DNS 缓存(optimistic) + DNS 查询超时(timeout) 映射。
 *
 * 字段 schema 经 resources/linux/sing-box check（1.14-alpha.32）实证（顶层 dns 对象、非 server/rule 级）：
 *  - dns.optimistic：boolean（server 级 optimistic 报 unknown field）
 *  - dns.timeout：Go duration 字符串，如 "5s"/"500ms"（裸数字 / 空串 / 无单位 FATAL；server 级 timeout 报 unknown field）
 *
 * 映射约定（保配置字节最小化）：optimisticCache!==true → 不下发 optimistic；dnsTimeoutMs 非有限正数 → 不下发 timeout。
 */
const dnsP2Config = (
  dnsExtra: Record<string, unknown>,
  selected: string | null = null
): UserConfig =>
  ({
    servers: [],
    selectedServerId: selected,
    proxyMode: 'global',
    proxyModeType: 'tun',
    enableIPv6: false,
    dnsConfig: { enableFakeIp: false, ...dnsExtra },
  }) as unknown as UserConfig;

describe('buildDnsConfig — P2b 乐观 DNS 缓存(optimistic)', () => {
  it('optimisticCache=true → 顶层 dns.optimistic=true', () => {
    const dns = build(dnsP2Config({ optimisticCache: true }));
    expect(dns.optimistic).toBe(true);
  });

  it('optimisticCache=false → 不下发 optimistic（保字节）', () => {
    const dns = build(dnsP2Config({ optimisticCache: false }));
    expect(dns.optimistic).toBeUndefined();
  });

  it('未设 optimisticCache → 不下发 optimistic', () => {
    const dns = build(dnsP2Config({}));
    expect(dns.optimistic).toBeUndefined();
  });
});

describe('buildDnsConfig — P2c DNS 查询超时(timeout)', () => {
  it('dnsTimeoutMs=5000 → dns.timeout="5000ms"（带单位字符串）', () => {
    const dns = build(dnsP2Config({ dnsTimeoutMs: 5000 }));
    expect(dns.timeout).toBe('5000ms');
  });

  it('dnsTimeoutMs=250 → "250ms"', () => {
    const dns = build(dnsP2Config({ dnsTimeoutMs: 250 }));
    expect(dns.timeout).toBe('250ms');
  });

  it('dnsTimeoutMs 为小数 → 四舍五入为整数毫秒', () => {
    const dns = build(dnsP2Config({ dnsTimeoutMs: 1499.6 }));
    expect(dns.timeout).toBe('1500ms');
  });

  it('dnsTimeoutMs<=0 / 非有限 / 未设 → 不下发 timeout', () => {
    expect(build(dnsP2Config({ dnsTimeoutMs: 0 })).timeout).toBeUndefined();
    expect(build(dnsP2Config({ dnsTimeoutMs: -100 })).timeout).toBeUndefined();
    expect(build(dnsP2Config({ dnsTimeoutMs: NaN })).timeout).toBeUndefined();
    expect(build(dnsP2Config({})).timeout).toBeUndefined();
  });

  it('optimistic + timeout 可并存（两者独立映射）', () => {
    const dns = build(dnsP2Config({ optimisticCache: true, dnsTimeoutMs: 3000 }));
    expect(dns.optimistic).toBe(true);
    expect(dns.timeout).toBe('3000ms');
  });
});

// P6 LAN 网关：local DNS server 邻居解析后缀（sing-box 1.14 neighbor_domain）。门控：仅 Linux/macOS，
// 每条归一化为以 '.' 开头（内核硬限界），附到 dns-local server。
describe('buildDnsConfig — P6 邻居短名解析(neighbor_domain)', () => {
  const neighborCfg = (neighborDomains?: string[]): UserConfig =>
    ({
      servers: [],
      selectedServerId: null,
      proxyMode: 'global',
      proxyModeType: 'tun',
      enableIPv6: false,
      dnsConfig: { enableFakeIp: false },
      tunConfig: {
        mtu: 1350,
        stack: 'system',
        autoRoute: true,
        strictRoute: true,
        neighborDomains,
      },
    }) as unknown as UserConfig;

  it('Linux：配置后缀 → dns-local.neighbor_domain（裸后缀补前导点、去重）', () => {
    const dns = withPlatform('linux', () => build(neighborCfg(['lan', '.home', 'lan'])));
    const local = dns.servers.find((s) => s.tag === 'dns-local');
    expect(local!.neighbor_domain).toEqual(['.lan', '.home']);
  });

  it('macOS：同样支持', () => {
    const dns = withPlatform('darwin', () => build(neighborCfg(['nas.local'])));
    const local = dns.servers.find((s) => s.tag === 'dns-local');
    expect(local!.neighbor_domain).toEqual(['.nas.local']);
  });

  it('win32：不发射（内核不支持邻居解析）', () => {
    const dns = withPlatform('win32', () => build(neighborCfg(['lan'])));
    const local = dns.servers.find((s) => s.tag === 'dns-local');
    expect(local!.neighbor_domain).toBeUndefined();
  });

  it('未配 neighborDomains → dns-local 无 neighbor_domain（零变化）', () => {
    const dns = withPlatform('linux', () => build(neighborCfg(undefined)));
    const local = dns.servers.find((s) => s.tag === 'dns-local');
    expect(local!.neighbor_domain).toBeUndefined();
  });

  it('空串/空白条目被过滤 → 全空则不发射', () => {
    const dns = withPlatform('linux', () => build(neighborCfg(['', '  '])));
    const local = dns.servers.find((s) => s.tag === 'dns-local');
    expect(local!.neighbor_domain).toBeUndefined();
  });
});
