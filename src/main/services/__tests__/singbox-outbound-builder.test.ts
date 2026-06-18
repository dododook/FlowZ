/**
 * singbox-outbound-builder 共享端点/选择器 helper 单测。
 * buildProxyOutbound 由 protocol-parser/config-snapshot 集成覆盖；此处锁 step9 抽入的 WG endpoint 构造默认值
 * （keepalive=25 / allowed_ips 全量 / mtu 兜底）与 isNodeUsable naive 门控（resourceManager spy）。
 */
import {
  buildWireGuardEndpoint,
  isNodeUsable,
  prunedSelectorDefault,
} from '../singbox-outbound-builder';
import { resourceManager } from '../ResourceManager';
import type { ServerConfig } from '../../../shared/types';

const wgServer = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 'w1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'cHJpdmtleQ==',
      peerPublicKey: 'cHVia2V5',
      localAddress: ['10.0.0.2/32'],
    },
    ...over,
  }) as unknown as ServerConfig;

describe('buildWireGuardEndpoint', () => {
  it('最小配置 → keepalive 兜 25s / allowed_ips 全量 / mtu 兜 1408 / system:false', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG');
    expect(ep.type).toBe('wireguard');
    expect(ep.tag).toBe('WG');
    expect(ep.system).toBe(false);
    expect(ep.mtu).toBe(1408);
    const peer = ep.peers![0];
    expect(peer.persistent_keepalive_interval).toBe(25);
    expect(peer.allowed_ips).toEqual(['0.0.0.0/0', '::/0']);
    expect(peer.pre_shared_key).toBeUndefined();
  });

  it('显式 keepalive/preSharedKey/mtu/reserved 原样下发；allowInternet 缺省 on → 具体段并入全网段', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          allowedIPs: ['192.168.50.0/24'],
          preSharedKey: 'psk',
          persistentKeepalive: 15,
          mtu: 1280,
          reserved: [1, 2, 3],
        },
      } as unknown as Partial<ServerConfig>),
      'WG2'
    );
    expect(ep.mtu).toBe(1280);
    const peer = ep.peers![0];
    // allowInternet 缺省 true（向后兼容）→ allowed_ips = 具体段 ∪ {0/0,::/0}（Layer A，两族全给）。
    expect(peer.allowed_ips).toEqual(['192.168.50.0/24', '0.0.0.0/0', '::/0']);
    expect(peer.pre_shared_key).toBe('psk');
    expect(peer.persistent_keepalive_interval).toBe(15);
    expect(peer.reserved).toEqual([1, 2, 3]);
  });

  it('allowInternet=off + 具体段 → allowed_ips 仅具体段（剥离全网段）', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          allowedIPs: ['10.8.0.0/24', '0.0.0.0/0', '::/0'],
          allowInternet: false,
        },
      } as unknown as Partial<ServerConfig>),
      'WG3'
    );
    expect(ep.peers![0].allowed_ips).toEqual(['10.8.0.0/24']);
  });

  it('allowInternet=off + 无具体段 → 抛错（空 allowed_ips=FATAL，调用方预拦不发射）', () => {
    expect(() =>
      buildWireGuardEndpoint(
        wgServer({
          wireguardSettings: {
            privateKey: 'pk',
            peerPublicKey: 'pub',
            localAddress: ['10.0.0.3/32'],
            allowedIPs: ['0.0.0.0/0', '::/0'],
            allowInternet: false,
          },
        } as unknown as Partial<ServerConfig>),
        'WG4'
      )
    ).toThrow(/外网访问|allowed/i);
  });

  it('缺 privateKey/peerPublicKey/localAddress → 抛错', () => {
    expect(() =>
      buildWireGuardEndpoint(
        wgServer({
          wireguardSettings: { privateKey: '', peerPublicKey: '', localAddress: [] },
        } as unknown as Partial<ServerConfig>),
        'X'
      )
    ).toThrow(/WireGuard/);
  });
});

describe('isNodeUsable', () => {
  it('非 naive → 恒可用', () => {
    expect(isNodeUsable({ protocol: 'vless' } as ServerConfig)).toBe(true);
  });
  it('naive：有/无 libcronet 决定可用性（resourceManager.hasCronetLib spy）', () => {
    const spy = jest.spyOn(resourceManager, 'hasCronetLib');
    try {
      spy.mockReturnValue(false);
      expect(isNodeUsable({ protocol: 'naive' } as ServerConfig)).toBe(false);
      spy.mockReturnValue(true);
      expect(isNodeUsable({ protocol: 'naive' } as ServerConfig)).toBe(true);
    } finally {
      spy.mockRestore(); // try/finally：断言失败也恢复 spy，防泄漏污染同文件后续用例（对齐 config-snapshot/custom-rules）
    }
  });
});

describe('prunedSelectorDefault', () => {
  it('rule-sel-* → proxy-selector；其它 → 剩余首成员', () => {
    expect(prunedSelectorDefault('rule-sel-x', ['a', 'proxy-selector'])).toBe('proxy-selector');
    expect(prunedSelectorDefault('proxy-selector', ['a', 'b'])).toBe('a');
  });
  it('proxy-selector 成员剔光（空数组）→ undefined（不伪造默认，退化态由 buildOutbounds 空守卫 throw 拦截）', () => {
    expect(prunedSelectorDefault('proxy-selector', [])).toBeUndefined();
    // rule-sel 恒嵌套回 proxy-selector，与成员是否剔空无关。
    expect(prunedSelectorDefault('rule-sel-y', [])).toBe('proxy-selector');
  });
});
