/**
 * 测速临时 config 的「端点目标解析」单测（纯 config 生成，无网络）。
 * 端点(WG/WARP)是 L3、目标域名必被本地解析：默认 dns-direct 从本机解析 → 本机 geo IP、端点出口够不着 → 超时/失真。
 * 修复(单形态):端点目标解析经 inbound 键控 dns.rule 定向到「穿本节点隧道」的 223.5.5.5(AliDNS 有大陆节点 + ECS,
 * 按出口地理返 IP → 境外/国内出口都对；1.1.1.1 因 anycast 无大陆 PoP、国内出口反挂,故用 223.5.5.5)。
 * 验:端点单入站、穿隧道 dns server(223.5.5.5/detour)、inbound 键控 dns.rule(disable_cache/strategy)、纯代理零变化。
 */
import { SpeedTestService } from '../SpeedTestService';

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<
  typeof SpeedTestService
>[0];

type Usable = { server: Record<string, unknown>; tag: string; outbound: Record<string, unknown> };
function gen(usable: Usable[], exitPorts: number[]) {
  const svc = new SpeedTestService(mockLog) as unknown as {
    generateProxyTestConfig: (u: Usable[], exit: Map<string, number>) => Record<string, any>;
  };
  const serverPortMap = new Map(usable.map((u, i) => [u.server.id as string, exitPorts[i]]));
  return svc.generateProxyTestConfig(usable, serverPortMap);
}
const wg = (id: string, localAddress: string[]): Usable => ({
  server: { id, name: 'WARP', protocol: 'wireguard', wireguardSettings: { localAddress } },
  tag: `out-${id.slice(0, 8)}`,
  outbound: { type: 'wireguard', tag: `out-${id.slice(0, 8)}` },
});
const vless = (id: string): Usable => ({
  server: { id, name: 'HK', protocol: 'vless' },
  tag: `out-${id.slice(0, 8)}`,
  outbound: { type: 'vless', tag: `out-${id.slice(0, 8)}`, uuid: 'x' },
});

describe('测速临时 config:端点目标解析穿隧道 223.5.5.5（单形态）', () => {
  it('WG 端点:单入站 + 穿隧道 223.5.5.5 dns server(detour) + inbound 键控 dns.rule(disable_cache/ipv4_only)', () => {
    const cfg = gen([wg('wgnode01', ['172.16.0.2/32'])], [21001]);
    expect(cfg.inbounds.map((i: any) => i.tag)).toEqual(['http-in-wgnode01']); // 单入站(无 local 兜底)
    expect(cfg.endpoints).toHaveLength(1); // WG 进 endpoints[]
    expect(cfg.route.rules.filter((r: any) => r.outbound === 'out-wgnode01')).toHaveLength(1);
    // 穿隧道 DNS server(223.5.5.5，detour 指向本端点 tag)
    expect(cfg.dns.servers.find((s: any) => s.tag === 'dns-exit-wgnode01')).toMatchObject({
      server: '223.5.5.5',
      detour: 'out-wgnode01',
    });
    // inbound 键控 dns.rule:端点入站、禁缓存、v4-only(无 v6 localAddress)
    expect(cfg.dns.rules).toEqual([
      {
        inbound: ['http-in-wgnode01'],
        action: 'route',
        server: 'dns-exit-wgnode01',
        strategy: 'ipv4_only',
        disable_cache: true,
      },
    ]);
  });

  it('WG localAddress 含 v6 → strategy prefer_ipv4', () => {
    const cfg = gen([wg('wgnodv61', ['172.16.0.2/32', '2606:4700::1/128'])], [21001]);
    expect(cfg.dns.rules[0].strategy).toBe('prefer_ipv4');
  });

  it('纯代理配置:无 dns.rules、单入站、无 endpoints、进 outbounds', () => {
    const cfg = gen([vless('vlessn01')], [21001]);
    expect(cfg.dns.rules).toBeUndefined();
    expect(cfg.inbounds).toHaveLength(1);
    expect(cfg.inbounds[0].tag).toBe('http-in-vlessn01');
    expect(cfg.endpoints).toBeUndefined();
    expect(cfg.outbounds.some((o: any) => o.tag === 'out-vlessn01')).toBe(true);
  });

  it('混合:代理条目零变化(单入站/无 dns.rule),仅端点有 dns.rule', () => {
    const cfg = gen([vless('vlessn01'), wg('wgnode01', ['172.16.0.2/32'])], [21001, 21003]);
    expect(cfg.dns.rules.map((r: any) => r.inbound[0])).toEqual(['http-in-wgnode01']); // 只端点有 dns.rule
    expect(cfg.inbounds.find((i: any) => i.tag === 'http-in-vlessn01').listen_port).toBe(21001);
    expect(cfg.inbounds.map((i: any) => i.tag).sort()).toEqual([
      'http-in-vlessn01',
      'http-in-wgnode01',
    ]);
  });
});
