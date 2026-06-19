/**
 * buildRouteConfig 专项单测 —— D-direct（direct 模式也生成组网 force-route）+ Phase2 system endpoint 路由。
 * 路由全量字节由 config-snapshot 集成锁；config-snapshot 无 direct+mesh 用例，故此处专项锁 D-direct 行为。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import type { ServerConfig, UserConfig } from '../../../shared/types';
import type { SingBoxEndpoint } from '../singbox-config-types';

const wgEp = (tag: string, system = false): SingBoxEndpoint => ({ type: 'wireguard', tag, system });
const tsEp = (tag: string, system = false): SingBoxEndpoint => ({ type: 'tailscale', tag, system });

const deps = (
  pendingEndpoints: SingBoxEndpoint[],
  over: Partial<RouteConfigDeps> = {}
): RouteConfigDeps => ({
  coreVersion: '1.13.0',
  probeDirectPort: null,
  probeProxyPort: null,
  lanResolverForDns: null,
  pendingEndpoints,
  log: () => {},
  onDegraded: () => {},
  ...over,
});

const wgNode = (id: string, name: string, allowedIPs: string[], over: any = {}): ServerConfig =>
  ({
    id,
    name,
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'pk',
      peerPublicKey: 'pub',
      localAddress: ['10.0.0.2/32'],
      allowedIPs,
      ...over,
    },
  }) as unknown as ServerConfig;

const tsNode = (id: string, name: string, over: any = {}): ServerConfig =>
  ({
    id,
    name,
    protocol: 'tailscale',
    tailscaleSettings: {
      routes: [],
      ...over,
    },
  }) as unknown as ServerConfig;

const cfg = (servers: ServerConfig[], over: Partial<UserConfig> = {}): UserConfig =>
  ({
    proxyMode: 'smart',
    servers,
    selectedServerId: servers[0]?.id,
    customRules: [],
    appRules: [],
    ...over,
  }) as unknown as UserConfig;

const idMap = (servers: ServerConfig[]): Map<string, string> =>
  new Map(servers.map((s) => [s.id, s.name]));

// 找到「组网 force-route」规则：action=route、outbound=节点 tag、带 ip_cidr。
const meshRule = (rc: any, tag: string): any =>
  (rc.rules || []).find(
    (r: any) => r.outbound === tag && r.action === 'route' && Array.isArray(r.ip_cidr)
  );

describe('buildRouteConfig — D-direct 组网 force-route', () => {
  const node = wgNode('w1', 'WG', ['10.8.0.0/24']);

  it('smart 模式：组网具体段 force-route 到节点自身 tag（基线）', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'smart' }),
      idMap([node]),
      deps([wgEp('WG')])
    );
    const r = meshRule(rc, 'WG');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('10.8.0.0/24');
  });

  it('D-direct：direct 模式也生成组网 force-route（修复前 direct 跳过 → 对端内网不可达）', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'direct' }),
      idMap([node]),
      deps([wgEp('WG')])
    );
    const r = meshRule(rc, 'WG');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('10.8.0.0/24');
  });

  it('system endpoint（reverseMesh）在 direct 模式同样 force-route（egress 仍经 route.rules）', () => {
    const sysNode = wgNode('w1', 'WGsys', ['10.9.0.0/24'], { reverseMesh: true });
    const rc = buildRouteConfig(
      cfg([sysNode], { proxyMode: 'direct' }),
      idMap([sysNode]),
      deps([wgEp('WGsys', true)])
    );
    const r = meshRule(rc, 'WGsys');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('10.9.0.0/24');
  });

  it('未发射的 endpoint（不在 pendingEndpoints）→ 不生成 force-route（防死引用）', () => {
    const rc = buildRouteConfig(cfg([node], { proxyMode: 'direct' }), idMap([node]), deps([]));
    expect(meshRule(rc, 'WG')).toBeUndefined();
  });
});

// 普通代理节点（vless）+ idMap：WebRTC 防泄露用例不依赖 endpoint，直接用简单节点。
const proxyNode = (id = 'p1', name = 'HK'): ServerConfig =>
  ({
    id,
    name,
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: 'u1',
  }) as ServerConfig;

// 找到 STUN 强制规则（protocol:'stun'）。
const stunRule = (rc: any): any => (rc.rules || []).find((r: any) => r.protocol === 'stun');

describe('buildRouteConfig — WebRTC 防泄露（webrtcLeakProtection）', () => {
  it('off / undefined → 不注入任何 protocol:stun 规则', () => {
    for (const over of [{}, { webrtcLeakProtection: 'off' as const }]) {
      const n = proxyNode();
      const rc = buildRouteConfig(cfg([n], { proxyMode: 'smart', ...over }), idMap([n]), deps([]));
      expect(stunRule(rc)).toBeUndefined();
      // 显式 stun sniffer 也不应注入（off 档）。
      expect(
        (rc.rules || []).some((r: any) => r.action === 'sniff' && Array.isArray(r.sniffer))
      ).toBe(false);
    }
  });

  it('proxy + smart（有节点）→ STUN route 到 proxy-selector，位置在 smart 自定义规则块之前', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(
      cfg([n], {
        proxyMode: 'smart',
        webrtcLeakProtection: 'proxy',
        customRules: [
          {
            id: 'cr1',
            type: 'domainSuffix',
            values: ['proxied.example'],
            action: 'proxy',
            enabled: true,
          },
        ] as any,
      }),
      idMap([n]),
      deps([])
    );
    const r = stunRule(rc);
    expect(r).toBeDefined();
    expect(r.action).toBe('route');
    expect(r.outbound).toBe('proxy-selector');
    // 位置断言：STUN 规则必须在自定义规则（outbound=rule-sel-cr1）之前。
    const stunIdx = (rc.rules || []).findIndex((r: any) => r.protocol === 'stun');
    const customIdx = (rc.rules || []).findIndex((r: any) => r.outbound === 'rule-sel-cr1');
    expect(customIdx).toBeGreaterThan(-1);
    expect(stunIdx).toBeLessThan(customIdx);
    // 稳健起见的显式 stun sniffer 已注入。
    expect(
      (rc.rules || []).some(
        (r: any) =>
          r.action === 'sniff' &&
          Array.isArray(r.sniffer) &&
          r.sniffer.includes('stun') &&
          Array.isArray(r.network) &&
          r.network.includes('udp')
      )
    ).toBe(true);
  });

  it('proxy + direct → 不注入（无代理路径）', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(
      cfg([n], { proxyMode: 'direct', webrtcLeakProtection: 'proxy' }),
      idMap([n]),
      deps([])
    );
    expect(stunRule(rc)).toBeUndefined();
  });

  it('proxy + global（有节点）→ STUN route 到 proxy-selector（注入冗余无害，锁定行为）', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(
      cfg([n], { proxyMode: 'global', webrtcLeakProtection: 'proxy' }),
      idMap([n]),
      deps([])
    );
    const r = stunRule(rc);
    expect(r).toBeDefined();
    expect(r.action).toBe('route');
    expect(r.outbound).toBe('proxy-selector');
  });

  it('block（任意模式）→ STUN reject', () => {
    for (const mode of ['smart', 'global', 'direct'] as const) {
      const n = proxyNode();
      const rc = buildRouteConfig(
        cfg([n], { proxyMode: mode, webrtcLeakProtection: 'block' }),
        idMap([n]),
        deps([])
      );
      const r = stunRule(rc);
      expect(r).toBeDefined();
      expect(r.action).toBe('reject');
      expect(r.outbound).toBeUndefined();
    }
  });

  it('与 blockQuic 共存：STUN 规则与 udp443 reject 互不覆盖、各自存在', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(
      cfg([n], { proxyMode: 'smart', webrtcLeakProtection: 'proxy', blockQuic: true }),
      idMap([n]),
      deps([])
    );
    // STUN 强制路由存在。
    const stun = stunRule(rc);
    expect(stun).toBeDefined();
    expect(stun.action).toBe('route');
    expect(stun.outbound).toBe('proxy-selector');
    // blockQuic 的末尾兜底 udp443 reject（network:['udp'] + port:[443] + action:'reject'，无 protocol）仍存在。
    const udp443 = (rc.rules || []).find(
      (r: any) =>
        r.action === 'reject' &&
        Array.isArray(r.network) &&
        r.network.includes('udp') &&
        Array.isArray(r.port) &&
        r.port.includes(443) &&
        r.protocol === undefined
    );
    expect(udp443).toBeDefined();
  });
});

// 找到 ICMP 兜底规则（network:['icmp'] + action:'route'）与已删的死规则（protocol:'icmp'）。
const icmpRule = (rc: any): any =>
  (rc.rules || []).find((r: any) => Array.isArray(r.network) && r.network.includes('icmp'));
const hasProtocolIcmp = (rc: any): boolean =>
  (rc.rules || []).some((r: any) => r.protocol === 'icmp');

describe('buildRouteConfig — ICMP 路由（跟随 final 出口）', () => {
  it('① 无任何 protocol:icmp 规则（死规则已删）', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(cfg([n], { proxyMode: 'smart' }), idMap([n]), deps([]));
    expect(hasProtocolIcmp(rc)).toBe(false);
  });

  it('② <1.13 核 → 无 network:icmp 规则（维持核默认）', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(
      cfg([n], { proxyMode: 'smart' }),
      idMap([n]),
      deps([], { coreVersion: '1.12.8' })
    );
    expect(icmpRule(rc)).toBeUndefined();
    expect(hasProtocolIcmp(rc)).toBe(false);
  });

  it('③a 选中普通代理 → network:icmp → direct（普通代理转不了 ICMP）', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(cfg([n], { proxyMode: 'smart' }), idMap([n]), deps([]));
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.action).toBe('route');
    expect(r.outbound).toBe('direct');
  });

  it('③b direct 模式 → network:icmp → direct', () => {
    const wg = wgNode('w1', 'WG', ['10.8.0.0/24']); // 即便选中 endpoint，direct 模式恒直连
    const rc = buildRouteConfig(
      cfg([wg], { proxyMode: 'direct' }),
      idMap([wg]),
      deps([wgEp('WG')])
    );
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.outbound).toBe('direct');
  });

  it('③c specific-only mesh（关外网组网节点选中为主）→ network:icmp → direct（userExitTag 已= direct）', () => {
    const wg = wgNode('w1', 'WG', ['10.8.0.0/24'], { allowInternet: false });
    const rc = buildRouteConfig(cfg([wg], { proxyMode: 'smart' }), idMap([wg]), deps([wgEp('WG')]));
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.outbound).toBe('direct');
  });

  it('③d 选中 WG 全隧道节点 → network:icmp → userExitTag(proxy-selector)', () => {
    const wg = wgNode('w1', 'WG', ['10.8.0.0/24']); // allowInternet 缺省=on，非 system → 承载 0/0
    const rc = buildRouteConfig(cfg([wg], { proxyMode: 'smart' }), idMap([wg]), deps([wgEp('WG')]));
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.action).toBe('route');
    expect(r.outbound).toBe('proxy-selector');
  });

  it('③e 选中 Tailscale 全隧道节点 → network:icmp → userExitTag(proxy-selector)', () => {
    const ts = tsNode('t1', 'TS'); // allowInternet 缺省=on，非 system → 承载 0/0
    const rc = buildRouteConfig(cfg([ts], { proxyMode: 'smart' }), idMap([ts]), deps([tsEp('TS')]));
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.outbound).toBe('proxy-selector');
  });

  it('④ mesh force-route 仍在、且排在 network:icmp 兜底之前', () => {
    const wg = wgNode('w1', 'WG', ['10.8.0.0/24']);
    const rc = buildRouteConfig(cfg([wg], { proxyMode: 'smart' }), idMap([wg]), deps([wgEp('WG')]));
    const forceRoute = meshRule(rc, 'WG');
    expect(forceRoute).toBeDefined();
    expect(forceRoute.ip_cidr).toContain('10.8.0.0/24');
    const forceIdx = (rc.rules || []).findIndex(
      (r: any) => r.outbound === 'WG' && r.action === 'route' && Array.isArray(r.ip_cidr)
    );
    const icmpIdx = (rc.rules || []).findIndex(
      (r: any) => Array.isArray(r.network) && r.network.includes('icmp')
    );
    expect(forceIdx).toBeGreaterThan(-1);
    expect(icmpIdx).toBeGreaterThan(-1);
    expect(forceIdx).toBeLessThan(icmpIdx);
  });
});
