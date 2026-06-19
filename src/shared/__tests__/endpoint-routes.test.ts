import {
  endpointForcedRouteCidrs,
  TAILNET_CGNAT,
  meshAllowsInternet,
  wireguardPeerAllowedIps,
  isMeshNodeUnroutable,
  meshSelectedExitFallsBackToDirect,
  meshShadowedCidrs,
} from '../endpoint-routes';
import type { ServerConfig, UserConfig } from '../types';

const wg = (allowedIPs?: string[], allowInternet?: boolean): ServerConfig =>
  ({
    id: 'w',
    name: 'w',
    protocol: 'wireguard',
    address: '1.2.3.4',
    port: 51820,
    wireguardSettings: {
      privateKey: 'k',
      peerPublicKey: 'p',
      localAddress: ['10.0.0.2/32'],
      allowedIPs,
      ...(allowInternet === undefined ? {} : { allowInternet }),
    },
  }) as any;

const ts = (routes?: string[], allowInternet?: boolean): ServerConfig =>
  ({
    id: 't',
    name: 't',
    protocol: 'tailscale',
    tailscaleSettings: { routes, ...(allowInternet === undefined ? {} : { allowInternet }) },
  }) as any;

describe('endpointForcedRouteCidrs', () => {
  it('WG: 去掉 catch-all(0/0,::/0)，保留具体段', () => {
    expect(endpointForcedRouteCidrs(wg(['0.0.0.0/0', '::/0', '10.10.10.0/24']))).toEqual([
      '10.10.10.0/24',
    ]);
  });
  it('WG: 仅 0/0 → 空（全量代理由 selector/final 接管，不进 force-route）', () => {
    expect(endpointForcedRouteCidrs(wg(['0.0.0.0/0', '::/0']))).toEqual([]);
  });
  it('WG: 空 allowedIPs → 空', () => {
    expect(endpointForcedRouteCidrs(wg())).toEqual([]);
  });
  it('TS: 自动含 tailnet 段 + routes', () => {
    expect(endpointForcedRouteCidrs(ts(['192.168.50.0/24']))).toEqual([
      TAILNET_CGNAT,
      '192.168.50.0/24',
    ]);
  });
  it('TS: 无 routes → 仅 tailnet 段（达 tailnet peer 的必需路由）', () => {
    expect(endpointForcedRouteCidrs(ts())).toEqual([TAILNET_CGNAT]);
  });
  it('trim/去空/去重', () => {
    expect(endpointForcedRouteCidrs(wg([' 10.10.10.0/24 ', '10.10.10.0/24', '', '  ']))).toEqual([
      '10.10.10.0/24',
    ]);
  });
  it('非 endpoint 协议 → 空', () => {
    expect(endpointForcedRouteCidrs({ protocol: 'vless' } as any)).toEqual([]);
  });
});

describe('meshAllowsInternet（allowInternet 缺省 true，向后兼容）', () => {
  it('WG 缺字段 → true', () => expect(meshAllowsInternet(wg())).toBe(true));
  it('WG allowInternet=true → true', () => expect(meshAllowsInternet(wg([], true))).toBe(true));
  it('WG allowInternet=false → false', () => expect(meshAllowsInternet(wg([], false))).toBe(false));
  it('TS 缺字段 → true', () => expect(meshAllowsInternet(ts())).toBe(true));
  it('TS allowInternet=false → false', () => expect(meshAllowsInternet(ts([], false))).toBe(false));
  it('非组网协议 → 恒 true', () =>
    expect(meshAllowsInternet({ protocol: 'vless' } as any)).toBe(true));
});

describe('wireguardPeerAllowedIps（Layer A）', () => {
  it('on(缺省) + 空 → 仅全网段两族', () => {
    expect(wireguardPeerAllowedIps(wg())).toEqual(['0.0.0.0/0', '::/0']);
  });
  it('on + 具体段 → 具体段 ∪ 全网段（两族全给，不裁剪）', () => {
    expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24']))).toEqual([
      '10.8.0.0/24',
      '0.0.0.0/0',
      '::/0',
    ]);
  });
  it('on + 具体段已含 catch-all → 去重不重复 0/0', () => {
    expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24', '0.0.0.0/0', '::/0']))).toEqual([
      '10.8.0.0/24',
      '0.0.0.0/0',
      '::/0',
    ]);
  });
  it('off + 具体段 → 仅具体段', () => {
    expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24'], false))).toEqual(['10.8.0.0/24']);
  });
  it('off + 仅 catch-all → null（空 allowed_ips=FATAL，不可发射）', () => {
    expect(wireguardPeerAllowedIps(wg(['0.0.0.0/0', '::/0'], false))).toBeNull();
  });
  it('off + 空 → null', () => {
    expect(wireguardPeerAllowedIps(wg([], false))).toBeNull();
  });
});

describe('isMeshNodeUnroutable', () => {
  it('WG off + 无具体段 → true（不可发射）', () => {
    expect(isMeshNodeUnroutable(wg([], false))).toBe(true);
  });
  it('WG off + 有具体段 → false', () => {
    expect(isMeshNodeUnroutable(wg(['10.8.0.0/24'], false))).toBe(false);
  });
  it('WG on → false', () => expect(isMeshNodeUnroutable(wg([], true))).toBe(false));
  it('TS off + 无 routes → false（仍达 tailnet，恒可发射）', () => {
    expect(isMeshNodeUnroutable(ts([], false))).toBe(false);
  });
});

describe('meshSelectedExitFallsBackToDirect（D4/D7：global+smart 同兜底）', () => {
  const cfg = (server: ServerConfig, proxyMode: string): UserConfig =>
    ({ proxyMode, servers: [server], selectedServerId: server.id }) as any;
  it('global + 选中 off WG → true', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false), 'global'))).toBe(true);
  });
  it('global + 选中 off TS → true', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(ts([], false), 'global'))).toBe(true);
  });
  it('global + 选中 on WG → false', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], true), 'global'))).toBe(false);
  });
  // D7 修复：smart 现也兜底（原 false 留下海外黑洞）
  it('smart + 选中 off WG → true（D7：smart 同兜底）', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false), 'smart'))).toBe(true);
  });
  it('smart + 选中 off+具体段 WG → true（off 即兜底，与有无 specific 无关）', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg(['10.8.0.0/24'], false), 'smart'))).toBe(true);
  });
  it('smart + 选中 on WG → false', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], true), 'smart'))).toBe(false);
  });
  it('direct + 选中 off WG → false（direct 本就 final=direct，不适用）', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false), 'direct'))).toBe(false);
  });
  it('选中非组网节点 → false', () => {
    const v = { id: 'v', protocol: 'vless' } as any;
    expect(meshSelectedExitFallsBackToDirect(cfg(v, 'global'))).toBe(false);
    expect(meshSelectedExitFallsBackToDirect(cfg(v, 'smart'))).toBe(false);
  });
});

describe('meshShadowedCidrs（同网段首声明者占有）', () => {
  const wgNode = (id: string, allowedIPs: string[]): ServerConfig =>
    ({
      id,
      name: id,
      protocol: 'wireguard',
      address: '1.2.3.4',
      port: 51820,
      wireguardSettings: {
        privateKey: 'k',
        peerPublicKey: 'p',
        localAddress: ['10.0.0.2/32'],
        allowedIPs,
      },
    }) as any;

  it('两节点同段 → 后者该段被覆盖', () => {
    const a = wgNode('a', ['10.8.0.0/24']);
    const b = wgNode('b', ['10.8.0.0/24', '192.168.9.0/24']);
    const m = meshShadowedCidrs([a, b]);
    expect(m.has('a')).toBe(false); // 首声明者不被覆盖
    expect(m.get('b')).toEqual(['10.8.0.0/24']); // 仅重复段被覆盖，独有段不计
  });

  it('无重叠 → 空 map', () => {
    const a = wgNode('a', ['10.8.0.0/24']);
    const b = wgNode('b', ['192.168.9.0/24']);
    expect(meshShadowedCidrs([a, b]).size).toBe(0);
  });

  it('catch-all 不参与（force-route 已剔）', () => {
    const a = wgNode('a', ['0.0.0.0/0', '::/0']);
    const b = wgNode('b', ['0.0.0.0/0', '::/0']);
    expect(meshShadowedCidrs([a, b]).size).toBe(0);
  });

  it('顺序决定归属：调换则被覆盖方互换', () => {
    const a = wgNode('a', ['10.8.0.0/24']);
    const b = wgNode('b', ['10.8.0.0/24']);
    expect(meshShadowedCidrs([a, b]).get('b')).toEqual(['10.8.0.0/24']);
    expect(meshShadowedCidrs([b, a]).get('a')).toEqual(['10.8.0.0/24']);
  });
});
