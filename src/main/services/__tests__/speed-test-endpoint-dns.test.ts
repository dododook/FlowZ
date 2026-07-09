/**
 * 测速临时 config 的「端点目标解析」单测（纯 config 生成，无网络）。
 * 端点(WG/WARP)是 L3、目标域名必被本地解析：默认 dns-direct(国内 DNS)会解出国内 geo IP、境外出口回连中国 → 超时/失真。
 * 修复:exit 形态入站的目标解析穿隧道走 1.1.1.1(geo 正确)+ local 形态入站回落 dns-direct(救国内出口 WG),inbound 键控。
 * 验:端点双入站/双 route、穿隧道 dns server(detour)、inbound 键控 dns.rule(disable_cache/strategy)、纯代理零变化。
 */
import { SpeedTestService } from '../SpeedTestService';

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<
  typeof SpeedTestService
>[0];

type Usable = { server: Record<string, unknown>; tag: string; outbound: Record<string, unknown> };
function gen(usable: Usable[], exitPorts: number[], localPorts: Record<string, number>) {
  const svc = new SpeedTestService(mockLog) as unknown as {
    generateProxyTestConfig: (
      u: Usable[],
      exit: Map<string, number>,
      local: Map<string, number>
    ) => Record<string, any>;
  };
  const serverPortMap = new Map(usable.map((u, i) => [u.server.id as string, exitPorts[i]]));
  const endpointLocalPortMap = new Map(Object.entries(localPorts));
  return svc.generateProxyTestConfig(usable, serverPortMap, endpointLocalPortMap);
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

describe('测速临时 config:端点目标解析穿隧道 + local 兜底', () => {
  it('WG 端点:双入站 + 穿隧道 dns server(detour) + inbound 键控 dns.rule(disable_cache/ipv4_only)', () => {
    const cfg = gen([wg('wgnode01', ['172.16.0.2/32'])], [21001], { wgnode01: 21002 });
    const inTags = cfg.inbounds.map((i: any) => i.tag);
    expect(inTags).toContain('http-in-wgnode01'); // exit 形态
    expect(inTags).toContain('http-in-l-wgnode01'); // local 兜底形态
    expect(cfg.endpoints).toHaveLength(1); // WG 进 endpoints[]
    // 两入站都指向同一端点 tag
    expect(cfg.route.rules.filter((r: any) => r.outbound === 'out-wgnode01')).toHaveLength(2);
    // 穿隧道 DNS server(detour 指向本端点 tag)
    expect(cfg.dns.servers.find((s: any) => s.tag === 'dns-exit-wgnode01')).toMatchObject({
      server: '1.1.1.1',
      detour: 'out-wgnode01',
    });
    // inbound 键控 dns.rule:仅 exit 形态、禁缓存、v4-only(无 v6 localAddress)
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
    const cfg = gen([wg('wgnodv61', ['172.16.0.2/32', '2606:4700::1/128'])], [21001], {
      wgnodv61: 21002,
    });
    expect(cfg.dns.rules[0].strategy).toBe('prefer_ipv4');
  });

  it('纯代理配置:无 dns.rules、单入站、无 endpoints、进 outbounds', () => {
    const cfg = gen([vless('vlessn01')], [21001], {});
    expect(cfg.dns.rules).toBeUndefined();
    expect(cfg.inbounds).toHaveLength(1);
    expect(cfg.inbounds[0].tag).toBe('http-in-vlessn01');
    expect(cfg.endpoints).toBeUndefined();
    expect(cfg.outbounds.some((o: any) => o.tag === 'out-vlessn01')).toBe(true);
  });

  it('混合:代理条目零变化(单入站/无 dns.rule),仅端点有 dns.rule + 双入站', () => {
    const cfg = gen([vless('vlessn01'), wg('wgnode01', ['172.16.0.2/32'])], [21001, 21003], {
      wgnode01: 21004,
    });
    expect(cfg.dns.rules.map((r: any) => r.inbound[0])).toEqual(['http-in-wgnode01']); // 只端点有 dns.rule
    expect(cfg.inbounds.find((i: any) => i.tag === 'http-in-vlessn01').listen_port).toBe(21001);
    expect(cfg.inbounds.map((i: any) => i.tag).sort()).toEqual([
      'http-in-l-wgnode01',
      'http-in-vlessn01',
      'http-in-wgnode01',
    ]);
  });
});
