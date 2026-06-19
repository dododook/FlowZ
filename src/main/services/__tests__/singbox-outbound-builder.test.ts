/**
 * singbox-outbound-builder 共享端点/选择器 helper 单测。
 * buildProxyOutbound 由 protocol-parser/config-snapshot 集成覆盖；此处锁 step9 抽入的 WG endpoint 构造默认值
 * （keepalive=25 / allowed_ips 全量 / mtu 兜底）与 isNodeUsable naive 门控（resourceManager spy）。
 */
import {
  buildWireGuardEndpoint,
  buildProxyOutbound,
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

  it('显式 keepalive/allowedIPs/preSharedKey/mtu/reserved → 原样下发', () => {
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
    expect(peer.allowed_ips).toEqual(['192.168.50.0/24']);
    expect(peer.pre_shared_key).toBe('psk');
    expect(peer.persistent_keepalive_interval).toBe(15);
    expect(peer.reserved).toEqual([1, 2, 3]);
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

// #57 resolve-ahead：buildProxyOutbound 的 resolvedHosts 仅改 outbound.server，绝不动 SNI/server_name。
describe('buildProxyOutbound — resolve-ahead（resolvedHosts → outbound.server）', () => {
  const DOMAIN = 'node.example.com';
  const IP = '203.0.113.7';
  const idMap = new Map<string, string>();
  const RESOLVED: ReadonlyMap<string, string> = new Map([[DOMAIN, IP]]);
  const srv = (over: Partial<ServerConfig>): ServerConfig =>
    ({ id: 'x', name: 'X', address: DOMAIN, port: 443, ...over }) as unknown as ServerConfig;

  it('命中：server=IP，但 tls.server_name 仍= 显式 SNI（不被 IP 覆盖）', () => {
    const ob = buildProxyOutbound(
      srv({
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        tlsSettings: { serverName: 'sni.example.net' },
      }),
      idMap,
      'dns-bootstrap',
      RESOLVED
    );
    expect(ob.server).toBe(IP);
    expect(ob.tls?.server_name).toBe('sni.example.net');
    expect(ob.domain_resolver).toBe('dns-bootstrap'); // 档位 tag 保留（回退路径仍用）
  });

  it('命中且无显式 SNI：server=IP，但 tls.server_name 回退【原域名】而非 IP（核心断言）', () => {
    const ob = buildProxyOutbound(
      srv({ protocol: 'trojan', password: 'pw', security: 'tls' }),
      idMap,
      'dns-bootstrap',
      RESOLVED
    );
    expect(ob.server).toBe(IP);
    expect(ob.tls?.server_name).toBe(DOMAIN);
  });

  it('reality 无 SNI：server=IP，server_name 仍 undefined（不被 IP 顶替）', () => {
    const ob = buildProxyOutbound(
      srv({
        protocol: 'vless',
        uuid: 'u',
        security: 'reality',
        realitySettings: { publicKey: 'pk', shortId: 'sid' },
      }),
      idMap,
      'dns-bootstrap',
      RESOLVED
    );
    expect(ob.server).toBe(IP);
    expect(ob.tls?.server_name).toBeUndefined();
  });

  it('naive：server=IP，tls.server_name 回退原域名', () => {
    const ob = buildProxyOutbound(
      srv({ protocol: 'naive', username: 'u', password: 'p' }),
      idMap,
      'dns-bootstrap',
      RESOLVED
    );
    expect(ob.server).toBe(IP);
    expect(ob.tls?.server_name).toBe(DOMAIN);
  });

  it('未命中（map 无此域名）/ 不传 resolvedHosts → server 保持原域名（现状）', () => {
    const base = srv({ protocol: 'trojan', password: 'pw', security: 'tls' });
    expect(buildProxyOutbound(base, idMap, 'dns-bootstrap', new Map()).server).toBe(DOMAIN);
    expect(buildProxyOutbound(base, idMap, 'dns-bootstrap').server).toBe(DOMAIN);
  });

  it('IP 字面量节点不在 map → server 原样（前置层不会把 IP 当 key）', () => {
    const ipNode = srv({
      address: '198.51.100.9',
      protocol: 'trojan',
      password: 'pw',
      security: 'tls',
    });
    expect(buildProxyOutbound(ipNode, idMap, 'dns-bootstrap', RESOLVED).server).toBe(
      '198.51.100.9'
    );
  });
});
