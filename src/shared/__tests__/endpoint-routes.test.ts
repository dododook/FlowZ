import { endpointForcedRouteCidrs, TAILNET_CGNAT } from '../endpoint-routes';
import type { ServerConfig } from '../types';

const wg = (allowedIPs?: string[]): ServerConfig =>
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
    },
  }) as any;

const ts = (routes?: string[]): ServerConfig =>
  ({ id: 't', name: 't', protocol: 'tailscale', tailscaleSettings: { routes } }) as any;

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
