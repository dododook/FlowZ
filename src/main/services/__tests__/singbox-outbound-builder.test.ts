/**
 * singbox-outbound-builder 共享端点/选择器 helper 单测。
 * buildProxyOutbound 由 protocol-parser/config-snapshot 集成覆盖；此处锁 step9 抽入的 WG endpoint 构造默认值
 * （keepalive=25 / allowed_ips 全量 / mtu 兜底）与 isNodeUsable naive 门控（resourceManager spy）。
 */
// buildTailscaleEndpoint 调用 tailscaleStateDir(→ electron app.getPath) + mkdirSync。mock tailscale-state
// 把 state 目录指向 tmp，避免依赖 electron（与 tailscale-state.test 同款隔离思路，但只 mock 路径产出）。
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
const TS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-ts-ep-'));
jest.mock('../tailscale-state', () => ({
  tailscaleStateDir: (id: string) => `${require('os').tmpdir()}/flowz-ts-ep-state/${id}`,
}));

import {
  buildWireGuardEndpoint,
  buildTailscaleEndpoint,
  buildProxyOutbound,
  isNodeUsable,
  prunedSelectorDefault,
} from '../singbox-outbound-builder';
import { resourceManager } from '../ResourceManager';
import type { ServerConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fs.rmSync(TS_TMP, { recursive: true, force: true });
    fs.rmSync(`${os.tmpdir()}/flowz-ts-ep-state`, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

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

  it('Phase2 reverseMesh=true → system:true + allowed_ips 仅具体段（结论A：即便 allowInternet 缺省 on 也不注入 0/0）', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          allowedIPs: ['10.8.0.0/24'],
          reverseMesh: true,
        },
      } as unknown as Partial<ServerConfig>),
      'WGS'
    );
    expect(ep.system).toBe(true);
    expect(ep.peers![0].allowed_ips).toEqual(['10.8.0.0/24']);
  });

  it('Phase2 reverseMesh=true + 无具体段 → 抛错（system specific-only 为空=FATAL）', () => {
    expect(() =>
      buildWireGuardEndpoint(
        wgServer({
          wireguardSettings: {
            privateKey: 'pk',
            peerPublicKey: 'pub',
            localAddress: ['10.0.0.3/32'],
            reverseMesh: true,
          },
        } as unknown as Partial<ServerConfig>),
        'WGS2'
      )
    ).toThrow(/allowed/i);
  });

  // #58：域名 server 的 WG endpoint 需 dial 级 domain_resolver（1.14 域名拨号无确定解析上游 → WARP 测速超时）。
  it('域名 server + domainResolverTag → endpoint 顶层 emit domain_resolver', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG', 'dns-direct');
    expect(ep.domain_resolver).toBe('dns-direct');
  });

  it('不传 domainResolverTag → 不下发 domain_resolver（保持旧行为 / 主配置依赖 route 默认）', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG');
    expect(ep.domain_resolver).toBeUndefined();
  });

  it('IPv4 字面量 server + domainResolverTag → 不下发 domain_resolver（IP 直拨无需 DNS 解析）', () => {
    const ep = buildWireGuardEndpoint(wgServer({ address: '162.159.192.1' }), 'WG', 'dns-direct');
    expect(ep.domain_resolver).toBeUndefined();
  });

  it('IPv6 字面量 server + domainResolverTag → 不下发 domain_resolver', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({ address: '2606:4700:d0::a29f:c001' }),
      'WG',
      'dns-direct'
    );
    expect(ep.domain_resolver).toBeUndefined();
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

  // #86-122 复审硬化 #1：表单/导入可能录入裸毫秒整数（数字或纯数字串），原样下发会触发 sing-box
  // ParseDuration "missing unit" → 整代理 FATAL。经 normalizeDuration 补 ms 单位，证明裸整数不再致 FATAL。
  it('anytls：裸整数 idle（数字 5000 / 字符串 "8000"）→ 归一化补 ms 单位（防 ParseDuration FATAL）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'anytls',
        password: 'p',
        security: 'tls',
        anyTlsSettings: {
          idleSessionCheckInterval: 5000 as unknown as string, // 表单裸数字
          idleSessionTimeout: '8000', // 纯数字串
        },
      }),
      tags
    ) as any;
    expect(ob.idle_session_check_interval).toBe('5000ms');
    expect(ob.idle_session_timeout).toBe('8000ms');
  });

  it('tuic：裸整数 heartbeat（数字 10000）→ 归一化为 "10000ms"（防 ParseDuration FATAL）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'tuic',
        uuid: 'u',
        password: 'p',
        tuicSettings: { heartbeat: 10000 as unknown as string },
      }),
      tags
    ) as any;
    expect(ob.heartbeat).toBe('10000ms');
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

  // P3d：SSH cipher/mac/kex_algorithm。字段名以 sing-box check 实证为准（cipher/mac/kex_algorithm，
  // 非 ciphers/macs/key_exchange——后两者 sing-box decode FATAL "unknown field"）。
  it('ssh：cipher/mac/kexAlgorithm → cipher/mac/kex_algorithm（sing-box 实证字段名）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'ssh',
        port: 22,
        sshSettings: {
          user: 'root',
          cipher: ['aes128-gcm@openssh.com', 'chacha20-poly1305@openssh.com'],
          mac: ['hmac-sha2-256'],
          kexAlgorithm: ['curve25519-sha256'],
        },
      }),
      tags
    ) as any;
    expect(ob.cipher).toEqual(['aes128-gcm@openssh.com', 'chacha20-poly1305@openssh.com']);
    expect(ob.mac).toEqual(['hmac-sha2-256']);
    expect(ob.kex_algorithm).toEqual(['curve25519-sha256']);
  });

  it('ssh：cipher/mac/kexAlgorithm 空数组不下发（向后兼容）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'ssh',
        port: 22,
        sshSettings: { user: 'root', cipher: [], mac: [], kexAlgorithm: [] },
      }),
      tags
    ) as any;
    expect(ob.cipher).toBeUndefined();
    expect(ob.mac).toBeUndefined();
    expect(ob.kex_algorithm).toBeUndefined();
  });

  // P3b：Hysteria2 obfs（salamander/gecko）+ min/max_packet_size（仅 gecko）+ bbr_profile。
  it('hysteria2：salamander obfs → obfs.type=salamander，不下发 min/max_packet_size', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: {
          obfs: { type: 'salamander', password: 'o', minPacketSize: 100, maxPacketSize: 1200 },
        },
      }),
      tags
    ) as any;
    expect(ob.obfs.type).toBe('salamander');
    expect(ob.obfs.password).toBe('o');
    // salamander 忽略包长字段：即便表单残留也不下发（避免无效字段）
    expect(ob.obfs.min_packet_size).toBeUndefined();
    expect(ob.obfs.max_packet_size).toBeUndefined();
  });

  it('hysteria2：gecko obfs → obfs.type=gecko + min/max_packet_size 下发', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: {
          obfs: { type: 'gecko', password: 'o', minPacketSize: 100, maxPacketSize: 1200 },
        },
      }),
      tags
    ) as any;
    expect(ob.obfs.type).toBe('gecko');
    expect(ob.obfs.min_packet_size).toBe(100);
    expect(ob.obfs.max_packet_size).toBe(1200);
  });

  it('hysteria2：obfs 缺 password → 不下发整个 obfs（sing-box: missing obfs password）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: { obfs: { type: 'gecko' } },
      }),
      tags
    ) as any;
    expect(ob.obfs).toBeUndefined();
  });

  it('hysteria2：bbrProfile → bbr_profile（standard/aggressive/conservative）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: { bbrProfile: 'aggressive' },
      }),
      tags
    ) as any;
    expect(ob.bbr_profile).toBe('aggressive');
  });

  it('hysteria2：未设 obfs/bbrProfile → 均不下发（向后兼容）', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'hysteria2', password: 'pw', security: 'tls', hysteria2Settings: {} }),
      tags
    ) as any;
    expect(ob.obfs).toBeUndefined();
    expect(ob.bbr_profile).toBeUndefined();
  });

  // P3c：TLS engine。仅对 TCP-TLS 协议下发；'go'/空省略；Hy2/TUIC（QUIC）即便设了也不下发。
  it('tls engine：trojan engine=windows → tls.engine=windows', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com', engine: 'windows' },
      }),
      tags
    ) as any;
    expect(ob.tls.engine).toBe('windows');
  });

  it('tls engine：engine=go 或未设 → 省略（用核心默认 Go TLS）', () => {
    const goOb = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com', engine: 'go' },
      }),
      tags
    ) as any;
    expect(goOb.tls.engine).toBeUndefined();
    const noneOb = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com' },
      }),
      tags
    ) as any;
    expect(noneOb.tls.engine).toBeUndefined();
  });

  it('tls engine：hysteria2(QUIC) 即便设 engine 也不下发（QUIC 自带 TLS1.3）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com', engine: 'apple' },
      }),
      tags
    ) as any;
    expect(ob.tls?.engine).toBeUndefined();
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

// buildTailscaleEndpoint — P4a 新字段（advertise_tags / ssh_server / relay_server_port）。
// schema 经 resources/linux/sing-box check（1.14-alpha.32）实证：
//  advertise_tags=Listable[string]；ssh_server=badoption(bool|{enabled})，FlowZ 以 bool 下发；
//  relay_server_port=int（唯一 relay_server_* 字段，无 relay_server 开关）。
const tsServer = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 'ts1',
    name: 'TS',
    protocol: 'tailscale',
    tailscaleSettings: {},
    ...over,
  }) as unknown as ServerConfig;

describe('buildTailscaleEndpoint — P4a 新字段', () => {
  it('基础 endpoint：type/tag/state_directory，无可选字段时不下发 P4a 字段', () => {
    const ep = buildTailscaleEndpoint(tsServer(), 'TS');
    expect(ep.type).toBe('tailscale');
    expect(ep.tag).toBe('TS');
    expect(ep.state_directory).toContain('ts1');
    expect(ep.advertise_tags).toBeUndefined();
    expect(ep.ssh_server).toBeUndefined();
    expect(ep.relay_server_port).toBeUndefined();
  });

  it('advertise_tags：过滤空白后下发数组；全空 → 不下发', () => {
    const ep = buildTailscaleEndpoint(
      tsServer({ tailscaleSettings: { advertiseTags: [' tag:server ', '', 'tag:exit'] } }),
      'TS'
    );
    expect(ep.advertise_tags).toEqual(['tag:server', 'tag:exit']);

    const empty = buildTailscaleEndpoint(
      tsServer({ tailscaleSettings: { advertiseTags: ['', '  '] } }),
      'TS'
    );
    expect(empty.advertise_tags).toBeUndefined();
  });

  it('ssh_server：true → ssh_server:true（bool 形式）；false/缺省 → 不下发', () => {
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { sshServer: true } }), 'TS').ssh_server
    ).toBe(true);
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { sshServer: false } }), 'TS').ssh_server
    ).toBeUndefined();
  });

  it('relay_server_port：正整数下发；0 / 负数 / 非数字 → 不下发', () => {
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { relayServerPort: 8080 } }), 'TS')
        .relay_server_port
    ).toBe(8080);
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { relayServerPort: 0 } }), 'TS')
        .relay_server_port
    ).toBeUndefined();
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { relayServerPort: -1 } }), 'TS')
        .relay_server_port
    ).toBeUndefined();
  });
});

// P3a：outbound TLS spoof（sing-box 1.14 tls.spoof/spoof_method，抗审查）。
// spoofMethod + spoofSni（诱饵 SNI，须不同于真 server_name）成对启用 → tls.spoof=spoofSni + tls.spoof_method。
// 五重门控：arch(非 ARM64) + 协议(TCP-TLS) + 诱饵 SNI 非空 + 非 IP 字面量 + 不同于真 server_name + 方法合法。
// 本机 process.arch=x64（支持），ARM64 路径单独 mock process.arch 验证。
describe('buildProxyOutbound — TLS spoof（P3a 抗审查）', () => {
  // CI 修复：spoof 门控读 process.arch（ARM64 不支持，内核仅 amd64 实现）。正向用例统一 mock x64，使其与 CI runner
  // 实际 arch 无关（macOS runner = arm64，否则正向用例误判失败）；下方 ARM64 负向用例在体内自 mock arm64 再还原。
  const REAL_ARCH = process.arch;
  beforeAll(() => Object.defineProperty(process, 'arch', { value: 'x64', configurable: true }));
  afterAll(() => Object.defineProperty(process, 'arch', { value: REAL_ARCH, configurable: true }));
  const tags = new Map<string, string>();
  const node = (over: Partial<ServerConfig>): ServerConfig =>
    ({ id: 'n', name: 'N', address: 'node.example.com', port: 443, ...over }) as ServerConfig;

  it('诱饵 SNI（不同于真 SNI）+ 合法方法 → tls.spoof=诱饵 + tls.spoof_method（trojan）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'real.example.com',
          spoofSni: 'decoy.microsoft.com',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags
    ) as any;
    expect(ob.tls.server_name).toBe('real.example.com');
    expect(ob.tls.spoof).toBe('decoy.microsoft.com'); // 诱饵，非真 SNI
    expect(ob.tls.spoof_method).toBe('wrong-ack');
  });

  it('诱饵 SNI == 真 server_name → 不下发（内核 FATAL `spoof must differ from server_name`）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        tlsSettings: {
          serverName: 'same.example.com',
          spoofSni: 'same.example.com',
          spoofMethod: 'wrong-timestamp',
        },
      }),
      tags
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('诱饵 SNI 为 IP 字面量 → 不下发（内核拒 `spoof requires TLS ClientHello with SNI`）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'real.example.com',
          spoofSni: '203.0.113.9',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('有方法但诱饵 SNI 留空 → 不下发（成对才生效）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'real.example.com', spoofMethod: 'wrong-ack' },
      }),
      tags
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('hysteria2(QUIC) 即便成对设置也不下发（无 TCP ClientHello）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'a.com',
          spoofSni: 'decoy.microsoft.com',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags
    ) as any;
    expect(ob.tls?.spoof).toBeUndefined();
    expect(ob.tls?.spoof_method).toBeUndefined();
  });

  it('未设 spoofMethod → 不下发（向后兼容）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com' },
      }),
      tags
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('ARM64（mock process.arch=arm64）→ 不下发 spoof（内核仅 amd64 实现）', () => {
    const orig = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      const ob = buildProxyOutbound(
        node({
          protocol: 'trojan',
          password: 'pw',
          security: 'tls',
          tlsSettings: {
            serverName: 'real.example.com',
            spoofSni: 'decoy.microsoft.com',
            spoofMethod: 'wrong-ack',
          },
        }),
        tags
      ) as any;
      expect(ob.tls.spoof).toBeUndefined();
      expect(ob.tls.spoof_method).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'arch', { value: orig, configurable: true });
    }
  });
});
