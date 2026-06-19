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

// B 组：节点表单新增的可选协议设置经 buildProxyOutbound 正确下发为 sing-box 字段。
// （tailscale exitNodeAllowLanAccess 属 endpoint 构造、依赖 electron stateDir，不在此单测，由类型检查 + 集成覆盖。）
describe('buildProxyOutbound — 可选协议设置下发（B 组编辑项）', () => {
  const tags = new Map<string, string>();
  const node = (over: Partial<ServerConfig>): ServerConfig =>
    ({
      id: 'n',
      name: 'N',
      address: 'node.example.com',
      port: 443,
      ...over,
    }) as unknown as ServerConfig;

  it('tuic：zeroRttHandshake/heartbeat → zero_rtt_handshake/heartbeat', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'tuic',
        uuid: 'u',
        password: 'p',
        tuicSettings: { udpRelayMode: 'native', zeroRttHandshake: true, heartbeat: '12s' },
      }),
      tags
    ) as any;
    expect(ob.zero_rtt_handshake).toBe(true);
    expect(ob.heartbeat).toBe('12s');
  });

  it('tuic：zeroRttHandshake=false 显式下发；heartbeat 空则省略', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'tuic',
        uuid: 'u',
        password: 'p',
        tuicSettings: { zeroRttHandshake: false },
      }),
      tags
    ) as any;
    expect(ob.zero_rtt_handshake).toBe(false);
    expect(ob.heartbeat).toBeUndefined();
  });

  it('anytls：idle 三参数 → idle_session_*/min_idle_session（min=0 也下发）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'anytls',
        password: 'p',
        security: 'tls',
        anyTlsSettings: {
          idleSessionCheckInterval: '30s',
          idleSessionTimeout: '60s',
          minIdleSession: 0,
        },
      }),
      tags
    ) as any;
    expect(ob.idle_session_check_interval).toBe('30s');
    expect(ob.idle_session_timeout).toBe('60s');
    expect(ob.min_idle_session).toBe(0);
  });

  it('ssh：hostKeyAlgorithms/clientVersion → host_key_algorithms/client_version', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'ssh',
        port: 22,
        sshSettings: {
          user: 'root',
          hostKeyAlgorithms: ['ssh-ed25519', 'rsa-sha2-256'],
          clientVersion: 'SSH-2.0-OpenSSH_9.0',
        },
      }),
      tags
    ) as any;
    expect(ob.host_key_algorithms).toEqual(['ssh-ed25519', 'rsa-sha2-256']);
    expect(ob.client_version).toBe('SSH-2.0-OpenSSH_9.0');
  });

  it('未设置这些可选项 → 不下发（向后兼容）', () => {
    const tuic = buildProxyOutbound(
      node({ protocol: 'tuic', uuid: 'u', password: 'p', tuicSettings: {} }),
      tags
    ) as any;
    expect(tuic.zero_rtt_handshake).toBeUndefined();
    expect(tuic.heartbeat).toBeUndefined();
    const ssh = buildProxyOutbound(
      node({ protocol: 'ssh', port: 22, sshSettings: { user: 'root' } }),
      tags
    ) as any;
    expect(ssh.host_key_algorithms).toBeUndefined();
    expect(ssh.client_version).toBeUndefined();
    const anytls = buildProxyOutbound(
      node({ protocol: 'anytls', password: 'p', security: 'tls', anyTlsSettings: {} }),
      tags
    ) as any;
    expect(anytls.idle_session_check_interval).toBeUndefined();
    expect(anytls.min_idle_session).toBeUndefined();
  });
});

// H2(http)/gRPC 传输：generateTransportConfig 之前漏 http 分支 → network=http 静默降级裸 TCP（表单 + 导入两路皆坏）。
// 此处锁 http 分支生成真 http 传输、grpc 照常、tcp 无 transport。
describe('buildProxyOutbound — http(H2)/gRPC 传输生成', () => {
  const tags = new Map<string, string>();
  const node = (over: Partial<ServerConfig>): ServerConfig =>
    ({
      id: 'n',
      name: 'N',
      address: 'node.example.com',
      port: 443,
      ...over,
    }) as unknown as ServerConfig;

  it('http(H2)：httpSettings → transport {type:http, host[], path}', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        network: 'http',
        httpSettings: { path: '/h2', host: ['a.com', 'b.com'] },
      }),
      tags
    );
    expect(ob.transport).toEqual({ type: 'http', host: ['a.com', 'b.com'], path: '/h2' });
  });

  it('http 无 httpSettings：仍生成 http 传输（path 默认 /），不回退裸 TCP', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'vless', uuid: 'u', security: 'tls', network: 'http' }),
      tags
    );
    expect(ob.transport?.type).toBe('http');
    expect(ob.transport?.path).toBe('/');
  });

  it('grpc：grpcSettings → transport {type:grpc, service_name}', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'p',
        security: 'tls',
        network: 'grpc',
        grpcSettings: { serviceName: 'GunSvc' },
      }),
      tags
    );
    expect(ob.transport).toEqual({ type: 'grpc', service_name: 'GunSvc' });
  });

  it('network=tcp：无 transport', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'vless', uuid: 'u', security: 'tls', network: 'tcp' }),
      tags
    );
    expect(ob.transport).toBeUndefined();
  });

  it("legacy 'h2'（旧表单遗留 network 值）→ 兼容生成 http 传输（非裸 TCP）", () => {
    const ob = buildProxyOutbound(
      {
        id: 'n',
        name: 'N',
        address: 'node.example.com',
        port: 443,
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        network: 'h2',
      } as unknown as ServerConfig,
      tags
    );
    expect(ob.transport?.type).toBe('http');
  });
});
