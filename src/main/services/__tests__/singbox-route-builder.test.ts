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
  probeDirectPort: null,
  probeProxyPort: null,
  updateInPort: null,
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

describe('buildRouteConfig — 出口接口自动检测', () => {
  it.each([
    ['tun', true],
    ['systemProxy', false],
    ['manual', false],
  ] as const)('%s 模式 → auto_detect_interface=%s', (proxyModeType, expected) => {
    const rc = buildRouteConfig(cfg([], { proxyModeType }), new Map(), deps([]));
    expect(rc.auto_detect_interface).toBe(expected);
  });

  it('macOS TUN 已解析实际上游时改用 default_interface，且两种绑定方式不同时开启', () => {
    const rc = buildRouteConfig(
      cfg([], { proxyModeType: 'tun' }),
      new Map(),
      deps([], { defaultInterface: 'utun4' })
    );
    expect(rc.auto_detect_interface).toBe(false);
    expect(rc.default_interface).toBe('utun4');
  });

  it('非 TUN 不接受 default_interface，继续服从系统逐目标路由', () => {
    const rc = buildRouteConfig(
      cfg([], { proxyModeType: 'systemProxy' }),
      new Map(),
      deps([], { defaultInterface: 'utun4' })
    );
    expect(rc.auto_detect_interface).toBe(false);
    expect(rc.default_interface).toBeUndefined();
  });
});

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

  it('TS 节点 force-route 含两族 tailnet 段（v4 100.64/10 + v6 fd7a::/48，块 0c 不按族裁剪）', () => {
    const ts = tsNode('t1', 'TS');
    const rc = buildRouteConfig(cfg([ts], { proxyMode: 'smart' }), idMap([ts]), deps([tsEp('TS')]));
    const r = meshRule(rc, 'TS');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('100.64.0.0/10');
    expect(r.ip_cidr).toContain('fd7a:115c:a1e0::/48'); // v6 tailnet force-route（否则 v6 peer 去 exit）
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

describe('buildRouteConfig — ICMP 路由（恒 direct，静态不随出口）', () => {
  it('① 无任何 protocol:icmp 规则（死规则已删）', () => {
    const n = proxyNode();
    const rc = buildRouteConfig(cfg([n], { proxyMode: 'smart' }), idMap([n]), deps([]));
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

  it('③d 选中 WG 全隧道节点 → network:icmp → direct（ICMP 恒直连，不再经出口）', () => {
    const wg = wgNode('w1', 'WG', ['10.8.0.0/24']); // allowInternet 缺省=on，非 system → 承载 0/0
    const rc = buildRouteConfig(cfg([wg], { proxyMode: 'smart' }), idMap([wg]), deps([wgEp('WG')]));
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.action).toBe('route');
    expect(r.outbound).toBe('direct');
  });

  it('③e 选中 Tailscale 全隧道节点 → network:icmp → direct（ICMP 恒直连，不再经出口）', () => {
    const ts = tsNode('t1', 'TS'); // allowInternet 缺省=on，非 system → 承载 0/0
    const rc = buildRouteConfig(cfg([ts], { proxyMode: 'smart' }), idMap([ts]), deps([tsEp('TS')]));
    const r = icmpRule(rc);
    expect(r).toBeDefined();
    expect(r.outbound).toBe('direct');
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

// 节点 IP-literal 直连排除规则（防回流死循环）：address 为 IP 字面量的节点拼成 ip_cidr direct 放行。
describe('buildRouteConfig — 节点 IP 直连排除（CIDR 形状）', () => {
  // 汇集所有「action=route、outbound=direct、非 network 规则」的 ip_cidr（节点排除与 bootstrap-DNS 等多条直连规则均含 ip_cidr）。
  const directCidrs = (rc: any): string[] =>
    (rc.rules || [])
      .filter(
        (r: any) =>
          r.outbound === 'direct' &&
          r.action === 'route' &&
          Array.isArray(r.ip_cidr) &&
          !Array.isArray(r.network)
      )
      .flatMap((r: any) => r.ip_cidr as string[]);
  const ipNode = (id: string, address: string): ServerConfig =>
    ({ id, name: id, protocol: 'vless', address, port: 443 }) as unknown as ServerConfig;

  it('IPv4 字面量节点 → ip_cidr 含 <addr>/32', () => {
    const n = ipNode('s1', '1.2.3.4');
    const rc = buildRouteConfig(cfg([n]), idMap([n]), deps([]));
    expect(directCidrs(rc)).toContain('1.2.3.4/32');
  });

  it('裸 IPv6 字面量节点 → ip_cidr 含 <addr>/128', () => {
    const n = ipNode('s1', '2001:db8::1');
    const rc = buildRouteConfig(cfg([n]), idMap([n]), deps([]));
    expect(directCidrs(rc)).toContain('2001:db8::1/128');
  });

  // R3-2：带方括号 address（Clash YAML 导入 / 表单输入未脱括号）须脱括号，否则 '[::1]/128' 是非法 CIDR。
  it('带方括号 IPv6 节点 → 脱方括号后 <addr>/128（不拼出 [::1]/128 非法 CIDR）', () => {
    const n = ipNode('s1', '[::1]');
    const rc = buildRouteConfig(cfg([n]), idMap([n]), deps([]));
    const cidrs = directCidrs(rc);
    expect(cidrs).toContain('::1/128');
    expect(cidrs).not.toContain('[::1]/128');
  });

  // R4-1：IPv4-mapped IPv6 字面量节点（target() 与 isIpv6Host 同口径当 IPv6）→ /128 排除，不漏排为域名。
  it('IPv4-mapped IPv6 字面量节点 → ip_cidr 含 <addr>/128（不漏排）', () => {
    const n = ipNode('s1', '::ffff:1.2.3.4');
    const rc = buildRouteConfig(cfg([n]), idMap([n]), deps([]));
    expect(directCidrs(rc)).toContain('::ffff:1.2.3.4/128');
  });

  // R4-3：lanResolverForDns 经 hostToExcludeCidr 族自适应拼 CIDR（IPv4 → /32），非硬编码 /32。
  it('lanResolverForDns（IPv4）→ ip_cidr 含 <ip>/32（族自适应 helper）', () => {
    const n = ipNode('s1', '1.2.3.4');
    const rc = buildRouteConfig(
      cfg([n]),
      idMap([n]),
      deps([], { lanResolverForDns: '192.168.1.1' })
    );
    expect(directCidrs(rc)).toContain('192.168.1.1/32');
  });
  it('lanResolverForDns（IPv6）→ ip_cidr 含 <ip>/128（族自适应 helper）', () => {
    const n = ipNode('s1', '1.2.3.4');
    const rc = buildRouteConfig(cfg([n]), idMap([n]), deps([], { lanResolverForDns: 'fd00::1' }));
    expect(directCidrs(rc)).toContain('fd00::1/128');
  });
});

describe('buildRouteConfig — issue #147 race 上游直连放行（§E.1，防 TUN 回环）', () => {
  const n = {
    id: 's1',
    name: 'N1',
    protocol: 'vless',
    address: '1.2.3.4',
    port: 443,
  } as unknown as ServerConfig;
  // C 段 bootstrap-direct 规则：direct + 含内置 DNS IP 223.5.5.5。
  const bootstrapRule = (rc: any): any =>
    (rc.rules || []).find(
      (r: any) =>
        r.action === 'route' &&
        r.outbound === 'direct' &&
        Array.isArray(r.ip_cidr) &&
        r.ip_cidr.some((c: string) => c.startsWith('223.5.5.5'))
    );

  it('自定义 race 上游 IP → C 段含其 /32；port 仅 53/443（DoT 二期未实现，不开 853，review #5）', () => {
    const rc = buildRouteConfig(cfg([n]), idMap([n]), deps([], { raceUpstreamIps: ['1.1.1.1'] }));
    const r = bootstrapRule(rc);
    expect(r.ip_cidr).toContain('1.1.1.1/32');
    expect(r.port).toEqual(expect.arrayContaining([53, 443]));
    expect(r.port).not.toContain(853);
  });

  it('无自定义上游（[] / 未传）→ port 不含 853（snapshot 零变化）', () => {
    expect(
      bootstrapRule(buildRouteConfig(cfg([n]), idMap([n]), deps([], { raceUpstreamIps: [] }))).port
    ).not.toContain(853);
    expect(bootstrapRule(buildRouteConfig(cfg([n]), idMap([n]), deps([]))).port).not.toContain(853);
  });
});

describe('buildRouteConfig — update-in 钉死路由（Phase 2）', () => {
  const node = proxyNode();
  // 找 update-in 规则：inbound 含 'update-in' 的 route 规则。
  const updateInRule = (rc: any): any =>
    (rc.rules || []).find((r: any) => Array.isArray(r.inbound) && r.inbound.includes('update-in'));

  it('smart：update-in → proxy-selector（强制经代理）', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'smart' }),
      idMap([node]),
      deps([], { updateInPort: 21003 })
    );
    const r = updateInRule(rc);
    expect(r).toBeDefined();
    expect(r.action).toBe('route');
    expect(r.outbound).toBe('proxy-selector');
    expect(r.domain_suffix).toBeUndefined(); // 不限 domain
  });

  it('global：update-in → proxy-selector', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'global' }),
      idMap([node]),
      deps([], { updateInPort: 21003 })
    );
    expect(updateInRule(rc).outbound).toBe('proxy-selector');
  });

  it('direct：update-in → direct（不偷代理）', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'direct' }),
      idMap([node]),
      deps([], { updateInPort: 21003 })
    );
    expect(updateInRule(rc).outbound).toBe('direct');
  });

  it('updateInPort 缺失（null）→ 无 update-in 规则', () => {
    const rc = buildRouteConfig(cfg([node], { proxyMode: 'smart' }), idMap([node]), deps([]));
    expect(updateInRule(rc)).toBeUndefined();
  });

  it('off-mesh（关外网组网节点选中）+ smart：update-in → direct（随 userExitTag 回退，避功能流量黑洞）', () => {
    const wg = wgNode('w1', 'WG', ['10.8.0.0/24'], { allowInternet: false });
    const rc = buildRouteConfig(
      cfg([wg], { proxyMode: 'smart' }),
      idMap([wg]),
      deps([], { updateInPort: 21003 })
    );
    // 此场景下用户常规出口 userExitTag 已回退 direct；update-in 跟随，不黑洞到 off-mesh 节点。
    expect(updateInRule(rc).outbound).toBe('direct');
  });
});

describe('buildRouteConfig — §15 主核测速探测池', () => {
  const hasProbeIn = (r: { inbound?: string | string[] }, tag: string): boolean =>
    Array.isArray(r.inbound) ? r.inbound.includes(tag) : r.inbound === tag;

  it('probePoolPorts → K 条 probe-in-k → probe-selector-k 钉死路由（紧随 A2、先于分流 hijack-dns）', () => {
    const rc = buildRouteConfig(
      cfg([]),
      idMap([]),
      deps([], { probePoolPorts: [1, 2, 3], probeDirectPort: 21001, probeProxyPort: 21002 })
    );
    for (let k = 0; k < 3; k++) {
      const rule = rc.rules.find((r) => hasProbeIn(r, `probe-in-${k}`));
      expect(rule).toBeTruthy();
      expect(rule!.action).toBe('route');
      expect(rule!.outbound).toBe(`probe-selector-${k}`);
    }
    const poolIdx = rc.rules.findIndex((r) => hasProbeIn(r, 'probe-in-0'));
    const hijackIdx = rc.rules.findIndex((r) => r.action === 'hijack-dns');
    expect(poolIdx).toBeGreaterThanOrEqual(0);
    expect(hijackIdx).toBeGreaterThan(poolIdx); // 先于分流
  });

  it('无 probePoolPorts → 零 probe-in-k 路由（回退临时核）', () => {
    const rc = buildRouteConfig(cfg([]), idMap([]), deps([]));
    expect(
      rc.rules.some(
        (r) => Array.isArray(r.inbound) && r.inbound.some((i) => i.startsWith('probe-in-'))
      )
    ).toBe(false);
  });
});
