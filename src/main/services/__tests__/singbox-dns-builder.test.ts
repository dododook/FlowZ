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
import type { UserConfig, ServerConfig } from '../../../shared/types';

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
const build = (config: UserConfig) => buildDnsConfig(config, 'proxy-selector', null, noopLog);

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

  it('选中节点非 tailscale → 不注入（即便存在一个 resolveByName 的非选中 tailscale 节点）', () => {
    const other = { id: 'p1', name: 'PlainNode', protocol: 'vless' } as unknown as ServerConfig;
    const dns = build(baseConfig([other, tsNode()], 'p1'));
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
