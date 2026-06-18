import {
  endpointForcedRouteCidrs,
  TAILNET_CGNAT,
  meshAllowsInternet,
  wireguardPeerAllowedIps,
  isMeshNodeUnroutable,
  meshGlobalFinalFallsBackToDirect,
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

describe('meshGlobalFinalFallsBackToDirect（D4）', () => {
  const cfg = (server: ServerConfig, proxyMode: string): UserConfig =>
    ({ proxyMode, servers: [server], selectedServerId: server.id }) as any;
  it('global + 选中 off WG → true', () => {
    expect(meshGlobalFinalFallsBackToDirect(cfg(wg([], false), 'global'))).toBe(true);
  });
  it('global + 选中 off TS → true', () => {
    expect(meshGlobalFinalFallsBackToDirect(cfg(ts([], false), 'global'))).toBe(true);
  });
  it('global + 选中 on WG → false', () => {
    expect(meshGlobalFinalFallsBackToDirect(cfg(wg([], true), 'global'))).toBe(false);
  });
  it('smart + 选中 off WG → false（仅 global 兜底）', () => {
    expect(meshGlobalFinalFallsBackToDirect(cfg(wg([], false), 'smart'))).toBe(false);
  });
  it('global + 选中非组网节点 → false', () => {
    const v = { id: 'v', protocol: 'vless' } as any;
    expect(meshGlobalFinalFallsBackToDirect(cfg(v, 'global'))).toBe(false);
  });
});
