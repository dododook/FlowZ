/**
 * 代理 Outbound 构造（sing-box 1.12.x / 1.13.x）—— 从 ProxyManager 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 2）。
 * 纯函数簇、零实例状态：只读入参 server / idToTagMap / nodeResolverTag，被 config-gen（generateOutbounds）
 * 与测速（buildSpeedTestOutbound）共用。逐协议字段映射 + TLS/Reality/传输层 + PR-6 抗封后处理。
 */

import type { ServerConfig, UserConfig, InvalidNodeInfo } from '../../shared/types';
import type { SingBoxOutbound, SingBoxEndpoint } from './singbox-config-types';
import { resourceManager } from './ResourceManager';
import {
  isEndpointProtocol,
  meshNodeCarriesFullTunnel,
  meshUsesSystemInterface,
  wireguardPeerAllowedIps,
  isMeshNodeUnroutable,
  TS_SYSTEM_INTERFACE_NAME,
  WG_SYSTEM_INTERFACE_NAME,
} from '../../shared/endpoint-routes';
import { parseWsEarlyData } from '../../shared/ws-early-data';
import { normalizeDuration } from '../../shared/duration';
import { validateTlsSpoof } from '../../shared/tls-spoof';
import { isIpLiteral } from '../../shared/dns';
import { tailscaleStateDir } from './tailscale-state';
import {
  effectiveCustomRules,
  effectiveAppRules,
  getNodeResolverTag,
  getDomesticResolverTag,
} from './singbox-config-helpers';
import { isDirectSelection, resolveGlobalExitTag } from '../../shared/direct-selection';

/**
 * 协议的 TLS 是否「在 QUIC 内自管」（hy2/tuic）：无 TCP ClientHello → 不挂 uTLS / tls.engine / fragment / spoof。
 * 三处 QUIC 门控（tls.engine、uTLS、fragment 排除集）共用单一谓词，杜绝重抄 `!== 'hysteria2' && !== 'tuic'` 漂移。
 */
function isQuicManagedTls(protocol: string): boolean {
  const p = protocol.toLowerCase();
  return p === 'hysteria2' || p === 'tuic';
}

/**
 * TLS 系统原生栈引擎（tls.engine）是否应在当前平台下发：windows(Schannel) 仅 win32、apple(Network.framework)
 * 仅 darwin。go / 空 / 未知一律返回 false（go 是核心默认跨平台 Go 栈，无需显式下发）。
 * 平台兜底（第二道闸）：跨平台导入的配置——如 Mac 节点 engine='apple' 导入 Windows——经此降级，
 * 非对应平台返回 false → 调用方落 Go 栈，防原样下发 apple/windows 在非对应平台致核 FATAL。
 * 抽纯函数（传 platform 参数）以便单测，免在测试里 mock process.platform。
 */
export function shouldEmitTlsEngine(
  engine: string | undefined,
  platform: NodeJS.Platform
): boolean {
  if (engine === 'windows') return platform === 'win32';
  if (engine === 'apple') return platform === 'darwin';
  return false;
}

/** 组网节点「不承载全隧道」的原因短语，供诊断 warn 复用。 */
function meshNonFullTunnelReason(): string {
  // 与 meshNodeCarriesFullTunnel 对齐:全隧道能力 = 允许外网,与接入模式正交(system 不再禁,出口路由托管)。
  // 故唯一不承载原因 = 关外网。
  return '已关闭外网访问';
}

/** 节点是否可用：naive 需要 libcronet 核心库，缺库时不可用（会被跳过、分流/选中回退到 selector）。 */
export function isNodeUsable(server: ServerConfig): boolean {
  if (server.protocol.toLowerCase() === 'naive' && !resourceManager.hasCronetLib()) {
    return false;
  }
  return true;
}

/**
 * selector default 被剔除后的兜底：rule-sel 回 proxy-selector（嵌套），proxy-selector 落剩余首节点（MED-1）。
 * proxy-selector 成员被剔光（remainingOutbounds 空）时无有效成员可选 → 返 undefined（不伪造默认掩盖「无节点」）；
 * 该退化态由调用方 buildOutbounds「proxy-selector 空 → throw 没有可用的代理节点出站」守卫拦截，不会下发非法
 * config。返回类型如实标 `string | undefined`，避免签名谎称恒返 string。
 */
export function prunedSelectorDefault(
  tag: string | undefined,
  remainingOutbounds: string[]
): string | undefined {
  return tag?.startsWith('rule-sel-') ? 'proxy-selector' : remainingOutbounds[0];
}

/**
 * WireGuard endpoint 构造（sing-box 1.11+ 顶层 endpoints[]）。config-gen 与测速共用。
 *
 * #58：peer.address 为【域名】时（如 WARP engage.cloudflareclient.com）必须给 endpoint 顶层 dial 级
 * domain_resolver，否则 sing-box 1.14 起域名无确定解析上游 → 拨号解析失败/超时（实测：WARP 测速超时，
 * Dalutone IP-server 正常）。与 buildProxyOutbound 的 outbound.domain_resolver 同口径。调用方传解析器
 * tag（config-gen：getNodeResolverTag(config,'dial')；测速：'dns-direct'）。
 * IP 字面量 server 不需 DNS 解析 → 不下发该字段（保持配置精简，且 IP 路径本就不受影响）。
 */
export function buildWireGuardEndpoint(
  server: ServerConfig,
  tag: string,
  domainResolverTag?: string
): SingBoxEndpoint {
  const s = server.wireguardSettings;
  if (!s || !s.privateKey || !s.peerPublicKey || !s.localAddress?.length) {
    throw new Error('WireGuard 配置缺少 privateKey/peerPublicKey/localAddress');
  }
  // Layer A：allowInternet=on→specific ∪ {0/0,::/0}；off→specific；off/system+无具体段→null。
  // null 表示空 allowed_ips（FATAL），调用方应已用 isMeshNodeUnroutable 预拦不发射；此处兜底抛错（防直调，如测速）。
  const allowedIps = wireguardPeerAllowedIps(server);
  if (allowedIps === null) {
    throw new Error(
      'WireGuard 节点无可路由网段（关外网 或 system 内核接口 且无具体段）：空 allowed_ips 会致 sing-box FATAL'
    );
  }
  // 域名 server 才需 domain_resolver（IP 字面量直拨、无需解析）。endpoint 级显式优于仅靠
  // route.default_domain_resolver——后者的「单 DNS server 时可省略」豁免更脆弱，且 1.14 deprecation 走向是
  // 域名 dial 必须显式 resolver。peer 级 domain_resolver 内核不接受（实测 FATAL unknown field），故放 endpoint 顶层。
  const needsResolver = !!domainResolverTag && !isIpLiteral(server.address);
  const usesSystemInterface = meshUsesSystemInterface(server);
  return {
    type: 'wireguard',
    tag,
    ...(needsResolver ? { domain_resolver: domainResolverTag } : {}),
    // Phase 2：reverseMesh=true → system:true（真内核 WG 接口，反向可达 / 全隧道出口）；缺省 false=userspace gVisor。
    // 全隧道时 allowed_ips 含 0/0（wireguardPeerAllowedIps）→ sing-box 按 allowed_ips 装接口作用域 0/0 路由、内核接口出口。
    // system:true 需 helper 提权，由连接闸门/校验确保仅 helper 活跃时该节点 reverseMesh 才成立（见 server-completeness）。
    // WG 内核接口名 = `name`（sing-box 1.14 wireguard endpoint 字段；TS 端点用 `system_interface_name`，两协议
    // 对应键不同——sing-box check 实证：WG 端点下 interface_name/system_interface_name 均 FATAL `unknown field`，
    // 唯 `name` 通过）：固定名供出口托管/清理定位。
    system: usesSystemInterface,
    // 固定名仅非 macOS 下发（macOS utun 名动态、不接受自定义名）；macOS 按 localAddress 反查接口。
    ...(usesSystemInterface && process.platform !== 'darwin'
      ? { name: WG_SYSTEM_INTERFACE_NAME }
      : {}),
    mtu: s.mtu && s.mtu > 0 ? s.mtu : 1408,
    address: s.localAddress,
    private_key: s.privateKey,
    peers: [
      {
        address: server.address,
        port: server.port,
        public_key: s.peerPublicKey,
        allowed_ips: allowedIps,
        ...(s.preSharedKey ? { pre_shared_key: s.preSharedKey } : {}),
        // keepalive 缺省强制 25s：WireGuard 是无连接 UDP，client 多在 NAT 后，无 keepalive 则 NAT 映射超时
        // → 入向不可达、隧道静默断连。故未显式设置时兜 25s 维持映射，避免断连（用户可在表单调大）。
        persistent_keepalive_interval:
          s.persistentKeepalive && s.persistentKeepalive > 0 ? s.persistentKeepalive : 25,
        ...(s.reserved?.length === 3 ? { reserved: s.reserved } : {}),
      },
    ],
  };
}

/**
 * 生成代理 Outbound 配置（sing-box 1.12.x / 1.13.x 兼容格式）
 */
export function buildProxyOutbound(
  server: ServerConfig,
  idToTagMap: Map<string, string>,
  // #57：节点域名 dial 解析器 tag，由调用方传 getNodeResolverTag(config,'dial')。
  // 缺省 dns-bootstrap（AliDNS IP-DoH）= 现状，兼容无 config 上下文的兜底调用。
  nodeResolverTag: string = 'dns-bootstrap'
): SingBoxOutbound {
  // sing-box 要求协议类型必须是小写
  const protocol = server.protocol.toLowerCase();
  const tlsProtocols = ['trojan', 'anytls', 'hysteria2', 'tuic'];

  // 自定义协议（raw-JSON 透传）：原样下发用户的 outbound 对象，仅【强制覆盖 tag】（防撞/防注入），
  // 语义与能否启用由 sing-box check（启动 gate / 表单 probe）判定，FlowZ 不解析 type。
  if (protocol === 'custom') {
    // 强制覆盖 tag、剥离 detour：内层 detour 会绕过 FlowZ 的代理链环检测（仅走 server.detour）且 sing-box check
    // 测不出 detour 环 → 运行时拨号死循环。FlowZ 经 detour 字段统一管理链路，自定义透传不携带内层 detour。
    const { detour: _drop, ...userOutbound } = (server.customSettings?.outbound || {}) as Record<
      string,
      unknown
    >;
    return {
      ...userOutbound,
      tag: idToTagMap.get(server.id) || `proxy-${server.id}`,
    } as unknown as SingBoxOutbound;
  }

  const outbound: SingBoxOutbound = {
    type: protocol,
    tag: idToTagMap.get(server.id) || `proxy-${server.id}`,
    // issue #147：server 恒用原域名——交内核 resolveDialer 运行时解析多 A → DialSerial 逐个 IP 重试（取代旧
    // resolve-ahead 烧单 IP，那会令 destination.IsDomain()=false、关闭内核多 IP 容错，见设计 §1.1）。
    // 多上游 race / 抗单点由 domain_resolver 指向的本地 race server 承担（getNodeResolverTag）。
    server: server.address,
    server_port: server.port,
    // 代理节点域名经引导解析（默认 dns-bootstrap=AliDNS IP-DoH），免疫 UDP 53 限速/劫持，
    // 避免节点解析失败导致全断流；同时防止 dns-local 死循环导致的连接挂起。
    // #57：节点域名解析器档位可改为 dns-node(DNSPod)/dns-local(系统 DNS)，dial 与 rule1 同档（统一 tag）。
    domain_resolver: nodeResolverTag,
  };

  // vless/vmess UDP 封装：默认 xudp；可经 server.packetEncoding 覆盖（兼容拒收 xudp 的旧核心/服务端，
  // 否则 UDP 断流且无从调整）。显式设为空串则省略该字段（不下发 packet_encoding，由核心用其默认）。
  const packetEncoding = server.packetEncoding ?? 'xudp';

  // VLESS 特定配置
  if (protocol === 'vless') {
    outbound.uuid = server.uuid;
    if (server.flow) {
      outbound.flow = server.flow;
    }
    if (packetEncoding) {
      outbound.packet_encoding = packetEncoding;
    }
  }

  // VMess 特定配置
  if (protocol === 'vmess') {
    outbound.uuid = server.uuid;
    outbound.security = server.vmessSecurity || 'auto';
    outbound.alter_id = server.alterId || 0;
    if (packetEncoding) {
      outbound.packet_encoding = packetEncoding;
    }
  }

  // Trojan 特定配置
  if (protocol === 'trojan') {
    outbound.password = server.password;
  }

  // Hysteria2 特定配置
  if (protocol === 'hysteria2') {
    outbound.password = server.password;

    // 带宽限制
    if (server.hysteria2Settings?.upMbps) {
      outbound.up_mbps = server.hysteria2Settings.upMbps;
    }
    if (server.hysteria2Settings?.downMbps) {
      outbound.down_mbps = server.hysteria2Settings.downMbps;
    }

    // 混淆配置（salamander / gecko）。gecko 额外支持随机填充包长 min/max_packet_size（仅 gecko 有意义，
    // salamander 忽略 → 仅 gecko 时下发，避免无效字段）。两类型均需 password（sing-box check：缺则 "missing obfs password"）。
    const obfs = server.hysteria2Settings?.obfs;
    if (obfs?.type && obfs?.password) {
      outbound.obfs = {
        type: obfs.type,
        password: obfs.password,
      };
      if (obfs.type === 'gecko') {
        if (typeof obfs.minPacketSize === 'number' && obfs.minPacketSize > 0) {
          outbound.obfs.min_packet_size = obfs.minPacketSize;
        }
        if (typeof obfs.maxPacketSize === 'number' && obfs.maxPacketSize > 0) {
          outbound.obfs.max_packet_size = obfs.maxPacketSize;
        }
      }
    }

    // BBR 拥塞控制 profile（standard / aggressive / conservative）。空 = 核心默认拥塞控制。
    if (server.hysteria2Settings?.bbrProfile) {
      outbound.bbr_profile = server.hysteria2Settings.bbrProfile;
    }

    // 网络类型 (tcp/udp)
    if (server.hysteria2Settings?.network) {
      outbound.network = server.hysteria2Settings.network;
    }
  }

  // Snell 特定配置（sing-box 1.14.0-alpha.38+ 官方 outbound；不走 TLS 块——不在 tlsProtocols，勿加 tls/alpn）。
  // version 是主开关：obfs_*（仅 v4）与 mode（仅 v6）互斥，按 version 条件下发；默认值（obfs none/mode default）
  // 不下发，保持配置精简且与核默认一致。
  if (protocol === 'snell') {
    const s = server.snellSettings;
    outbound.version = s?.version; // 4|6（completeness 闸门已保证存在）
    outbound.psk = server.password; // psk 复用 password 字段（同 trojan/hysteria2 惯例）
    if (s?.userkey) {
      outbound.userkey = s.userkey;
    }
    if (s?.reuse) {
      outbound.reuse = true;
    }
    if (s?.network) {
      outbound.network = s.network; // 省略 = both
    }
    if (s?.version === 4) {
      if (s.obfsMode && s.obfsMode !== 'none') {
        outbound.obfs_mode = s.obfsMode;
        outbound.obfs_host = s.obfsHost || 'bing.com';
      }
    } else if (s?.version === 6) {
      if (s.mode && s.mode !== 'default') {
        outbound.mode = s.mode;
      }
    }
  }

  // AnyTLS 特定配置
  if (protocol === 'anytls') {
    outbound.password = server.password;
    // AnyTLS 的 TLS 永远开启，这里不需要额外处理，类型检查结尾部分统一生成
    // AnyTLS 会话参数。时长字段统一经 normalizeDuration 收敛：表单可能录入裸毫秒整数（如 "5000"），
    // 原样下发会触发 sing-box ParseDuration "missing unit" → 整代理 FATAL。已带单位值幂等透传，空值不下发。
    const checkInterval = normalizeDuration(server.anyTlsSettings?.idleSessionCheckInterval);
    if (checkInterval) {
      outbound.idle_session_check_interval = checkInterval;
    }
    const idleTimeout = normalizeDuration(server.anyTlsSettings?.idleSessionTimeout);
    if (idleTimeout) {
      outbound.idle_session_timeout = idleTimeout;
    }
    if (server.anyTlsSettings?.minIdleSession !== undefined) {
      outbound.min_idle_session = server.anyTlsSettings.minIdleSession;
    }
  }

  // Shadowsocks 特定配置
  if (protocol === 'shadowsocks') {
    if (!server.shadowsocksSettings) {
      throw new Error(`Shadowsocks server ${server.name} missing settings`);
    }
    outbound.method = server.shadowsocksSettings.method;
    outbound.password = server.shadowsocksSettings.password;
    if (server.shadowsocksSettings.plugin) {
      outbound.plugin = server.shadowsocksSettings.plugin;
      outbound.plugin_opts = server.shadowsocksSettings.pluginOptions;
    }
  }

  // TUIC 特定配置
  if (protocol === 'tuic') {
    outbound.uuid = server.uuid;
    outbound.password = server.password;

    if (server.tuicSettings) {
      if (server.tuicSettings.congestionControl) {
        outbound.congestion_control = server.tuicSettings.congestionControl;
      }
      if (server.tuicSettings.udpRelayMode) {
        outbound.udp_relay_mode = server.tuicSettings.udpRelayMode;
      }
      if (server.tuicSettings.zeroRttHandshake !== undefined) {
        outbound.zero_rtt_handshake = server.tuicSettings.zeroRttHandshake;
      }
      // heartbeat 经 normalizeDuration 收敛：表单录入裸毫秒整数会致 sing-box ParseDuration FATAL；带单位幂等。
      const heartbeat = normalizeDuration(server.tuicSettings.heartbeat);
      if (heartbeat) {
        outbound.heartbeat = heartbeat;
      }
    }
  }

  // NaiveProxy 特定配置
  if (protocol === 'naive') {
    outbound.username = server.username;
    outbound.password = server.password;

    // NaiveProxy specific configuration
    // sing-box 的 naive outbound 由 Cronet 自管 TLS，仅支持 server_name / certificate /
    // certificate_path / ech。下发 alpn 或 insecure:true 会让 sing-box 拒启：
    //   FATAL: initialize outbound: alpn is not supported on naive outbound
    //   FATAL: initialize outbound: insecure is not supported on naive outbound
    // 故这里只下发 server_name（用户在节点上设置的 alpn / allowInsecure 对 naive 无效，忽略）。
    // 参考：https://sing-box.sagernet.org/configuration/outbound/naive/ （TLS 字段限制）
    //       SagerNet/sing-box protocol/naive/outbound.go (v1.13.x) ~L47 的 ALPN/insecure 校验
    outbound.tls = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || server.address,
    };

    // HTTP/3：naive 经 quic:true 走 h3(QUIC/UDP) 拨号传输，对应服务端 `--listen=quic://`。
    // 注意这只改变"拨号传输"：naive 仍只过 TCP（HTTP CONNECT）、不能中继客户端 UDP（除非
    // udp_over_tcp，FlowZ 不下发）。客户端 QUIC 若走到 naive，由 blockQuic（udp443 reject 逼回退 TCP）
    // 或 sing-box 出站层（"UDP is not supported by outbound"）处理；该拨号本身受 fwmark 保护、
    // 绕过 route 规则，不被 reject 误杀（已实测）。
    if (server.naiveSettings?.useHttp3) {
      outbound.quic = true;
    }
  }

  // SOCKS 特定配置
  if (protocol === 'socks') {
    if (server.username) outbound.username = server.username;
    if (server.password) outbound.password = server.password;
    // 默认 SOCKS 版本
    (outbound as any).version = '5';
  }

  // HTTP 特定配置
  if (protocol === 'http') {
    if (server.username) outbound.username = server.username;
    if (server.password) outbound.password = server.password;

    // HTTP outbound headers mapping can be added if needed via server.httpSettings.headers
    if (server.httpSettings?.headers) {
      if (!outbound.transport) outbound.transport = { type: 'http' };
      outbound.transport.headers = server.httpSettings.headers;
    }
    if (server.httpSettings?.path) {
      if (!outbound.transport) outbound.transport = { type: 'http' };
      outbound.transport.path = server.httpSettings.path;
    }
  }

  // SSH 特定配置
  if (protocol === 'ssh') {
    const ssh = server.sshSettings || {};
    if (ssh.user) outbound.user = ssh.user;
    if (ssh.password) outbound.password = ssh.password;
    if (ssh.privateKey) outbound.private_key = ssh.privateKey;
    if (ssh.privateKeyPath) outbound.private_key_path = ssh.privateKeyPath;
    if (ssh.privateKeyPassphrase) outbound.private_key_passphrase = ssh.privateKeyPassphrase;
    if (ssh.hostKey && ssh.hostKey.length > 0) outbound.host_key = ssh.hostKey;
    if (ssh.hostKeyAlgorithms && ssh.hostKeyAlgorithms.length > 0)
      outbound.host_key_algorithms = ssh.hostKeyAlgorithms;
    if (ssh.clientVersion) outbound.client_version = ssh.clientVersion;
    // 算法协商可选项（P3d）：sing-box 字段名 cipher / mac / kex_algorithm（已 check 实证）。空数组不下发。
    if (ssh.cipher && ssh.cipher.length > 0) outbound.cipher = ssh.cipher;
    if (ssh.mac && ssh.mac.length > 0) outbound.mac = ssh.mac;
    if (ssh.kexAlgorithm && ssh.kexAlgorithm.length > 0) outbound.kex_algorithm = ssh.kexAlgorithm;

    // SSH outbound 不需要 TLS 和传输层配置，直接返回
    return outbound;
  }

  // TLS 配置 (非 Naive 协议，因为 Naive 已在前一段处理了 tls 结构)
  if (
    protocol !== 'naive' &&
    (server.security === 'tls' || server.tlsSettings || tlsProtocols.includes(protocol))
  ) {
    // 为 Trojan 设置默认 ALPN ["http/1.1"] 以提高兼容性
    let finalAlpn = server.tlsSettings?.alpn;
    if (!finalAlpn && protocol === 'trojan') {
      finalAlpn = ['http/1.1'];
    }

    outbound.tls = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || server.address,
      insecure: server.tlsSettings?.allowInsecure || false,
      alpn: finalAlpn,
    };

    // TLS 栈引擎（P3c，sing-box 1.14 tls.engine）：windows(Schannel)/apple(Network.framework) 用系统原生栈，
    // ClientHello 指纹更真。仅对 TCP-TLS 协议下发——Hy2/TUIC 走 QUIC 自带 TLS1.3，系统 TCP-TLS 栈不适用，
    // 表单也不对它们暴露此项。'go'/空 = 跨平台 Go TLS（核心默认），无需显式下发。windows/apple 在非对应平台
    // 运行时 FATAL → shouldEmitTlsEngine 按当前平台门控（表单过滤之外的第二道闸，兜跨平台导入的配置）。
    const tlsEngine = server.tlsSettings?.engine;
    if (!isQuicManagedTls(protocol) && shouldEmitTlsEngine(tlsEngine, process.platform)) {
      outbound.tls.engine = tlsEngine;
    }

    // uTLS 仅适用于基于 TCP 的协议，Hysteria2 和 TUIC 使用 QUIC (UDP) 不支持 uTLS
    const fingerprint = server.tlsSettings?.fingerprint;

    // 默认行为：VLESS 等协议默认开启 chrome 指纹，Trojan 默认不开启（none）以通过标准 TLS 握手
    let finalFingerprint = fingerprint;
    if (!finalFingerprint) {
      if (protocol === 'vless' || protocol === 'anytls') {
        finalFingerprint = 'chrome';
      } else {
        finalFingerprint = 'none';
      }
    }

    if (!isQuicManagedTls(protocol) && finalFingerprint !== 'none') {
      outbound.tls.utls = {
        enabled: true,
        fingerprint: finalFingerprint,
      };
    }

    // ALPN 仅在支持的协议上设置
    if (server.tlsSettings?.alpn) {
      outbound.tls.alpn = server.tlsSettings.alpn;
    }
  }

  // Reality 配置
  if (server.security === 'reality' && server.realitySettings) {
    outbound.tls = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || undefined,
      insecure: server.tlsSettings?.allowInsecure || false,
      utls: {
        enabled: true,
        fingerprint: server.tlsSettings?.fingerprint || 'chrome',
      },
      reality: {
        enabled: true,
        public_key: server.realitySettings.publicKey,
        short_id: server.realitySettings.shortId || '',
      },
    };
  }

  // 传输层配置（不适用于 hysteria2、anytls、naive）
  if (
    protocol !== 'hysteria2' &&
    protocol !== 'anytls' &&
    protocol !== 'naive' &&
    server.network &&
    server.network !== 'tcp'
  ) {
    outbound.transport = generateTransportConfig(server);
  }

  // PR-6 抗封增强（ECH / TLS 分片 / Multiplex / Hy2 端口跳跃）统一后处理
  applyAntiCensorshipOptions(outbound, server);

  return outbound;
}

/**
 * 生成传输层配置
 */
function generateTransportConfig(server: ServerConfig): SingBoxOutbound['transport'] {
  if (server.network === 'ws' && server.wsSettings) {
    // 0-RTT early-data：分享链/订阅常把约定写进 path（`?ed=<bytes>`[&eh=<header>]）；sing-box 不自动解析它
    // ——会把 `?` 编码成 %3F、整段当字面路径，且默认走 path 模式 → 与 xray 服务端的 /path 分流 + header 早数据
    // 约定错位、连不上（#57 L2 已实测 wire capture）。故在此把 ed/eh 拆成内核显式字段、path 去 ed/eh；
    // path 内无 ed 时回退既有显式字段（如 Clash 订阅的 max-early-data / early-data-header-name）。
    const ed = parseWsEarlyData(server.wsSettings.path || '/');
    return {
      type: 'ws',
      path: ed.path,
      headers: server.wsSettings.headers,
      max_early_data: ed.maxEarlyData ?? server.wsSettings.maxEarlyData,
      early_data_header_name: ed.earlyDataHeaderName ?? server.wsSettings.earlyDataHeaderName,
    };
  }

  if (server.network === 'grpc' && server.grpcSettings) {
    return {
      type: 'grpc',
      service_name: server.grpcSettings.serviceName || '',
    };
  }

  // HTTP/2 传输（v2ray http transport，需 TLS）：host 为 string[]、path 默认 '/'。
  // 不严格门控 httpSettings——任何 network=http 都生成 http 传输，避免回退裸 TCP（导入/表单两路统一）。
  // 'h2' 为旧表单遗留的 network 值（现已统一为 'http'）；兼容旧配置：不必重新编辑即生效。
  if (server.network === 'http' || (server.network as string) === 'h2') {
    return {
      type: 'http',
      host: server.httpSettings?.host,
      path: server.httpSettings?.path || '/',
      method: server.httpSettings?.method,
      headers: server.httpSettings?.headers,
    };
  }

  // httpupgrade：较 ws 更隐蔽的 HTTP Upgrade 传输（复用 ws 的 path / Host）
  if (server.network === 'httpupgrade') {
    return {
      type: 'httpupgrade',
      path: server.wsSettings?.path || '/',
      host: server.wsSettings?.headers?.['Host'] || server.tlsSettings?.serverName,
    };
  }

  return undefined;
}

/**
 * PR-6 抗封增强统一后处理：ECH、每节点 TLS 分片、Multiplex(reality+vision 跳过)、Hy2 端口跳跃。
 * 放在 outbound 构建完成后统一处理，避免散落到各协议的 tls/transport 构建点。
 */
function applyAntiCensorshipOptions(outbound: SingBoxOutbound, server: ServerConfig): void {
  const protocolLower = server.protocol.toLowerCase();

  // fragment 仅对「标准 sing-box TCP-TLS 栈」有意义，以下协议必须排除（否则死配置或直接启动 FATAL）：
  //   · hy2/tuic：TLS 在 QUIC 内、无 TCP ClientHello（死配置）；
  //   · naive：TLS 由 Cronet 自管，naive 出站直接拒绝 fragment 字段（实测
  //     "fragment is not supported on naive outbound" → 启动 FATAL），无论 h2/h3。
  // 注：ECH 不受此限——QUIC 与 naive(Cronet) 均原生支持 ECH。
  const fragmentUnsupported = isQuicManagedTls(protocolLower) || protocolLower === 'naive';

  // ECH（隐藏 SNI）+ 每节点 TLS 分片（抗 SNI-DPI）：需已有 tls 块
  if (outbound.tls) {
    if (server.tlsSettings?.ech) {
      // 可选 ECHConfigList：填了下发 tls.ech.config（PEM 按行拆数组）；留空则 sing-box 从 DNS(HTTPS RR) 自取。
      const echCfg = server.tlsSettings.echConfig?.trim();
      const echLines = echCfg
        ? echCfg
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
      outbound.tls.ech =
        echLines.length > 0 ? { enabled: true, config: echLines } : { enabled: true };
    }
    if (server.tlsSettings?.fragment && !fragmentUnsupported) outbound.tls.fragment = true;

    // TLS spoof（P3a 抗审查，sing-box 1.14）：spoofMethod + spoofSni 成对非空才启用——下发 tls.spoof=spoofSni
    //（伪造 ClientHello 的「诱饵 SNI」）+ tls.spoof_method。五重门控（任一不满足即不 emit，否则内核 FATAL / 行为无效）：
    //   1. arch：ARM64 不支持（内核仅 amd64 实现）；
    //   2. 协议：仅标准 TCP-TLS 栈（排除 hy2/tuic 的 QUIC 内 TLS、naive 的 Cronet 自管 TLS），与 fragment 同集；
    //   3. 诱饵 SNI 必须是域名：IP 字面量内核拒（`spoof requires TLS ClientHello with SNI`）；
    //   4. **诱饵 SNI 必须不同于真 server_name**：内核 FATAL `spoof must differ from server_name`（已真核实证）；
    //   5. 方法合法（wrong-ack/wrong-md5/wrong-timestamp）；
    //   6. **真 server_name 本身非 IP 字面量**：节点 address 为 IP 且未填 serverName 时 server_name 回退为 IP，真握手无 SNI →
    //      内核 init 报 `spoof requires TLS ClientHello with SNI` 致整配置 FATAL。由 validateTlsSpoof 收口（传 serverSni 即校验）。
    // 注：提权（CAP_NET_RAW+NET_ADMIN / root / 管理员）是运行期生效条件，不影响配置合法性 → 此处不门控，
    //    UI 已提示需提权；缺权时内核启动期报权限错（非配置 FATAL），属用户环境问题。
    const spoofMethod = server.tlsSettings?.spoofMethod;
    const spoofSni = server.tlsSettings?.spoofSni?.trim();
    const realSni = outbound.tls.server_name;
    // 门控（方法/arch/诱饵非空/诱饵非 IP/协议 TCP-TLS/诱饵≠真 server_name/真 server_name 非 IP）经 validateTlsSpoof
    // 单一真值，与 route action spoof（singbox-custom-rules）共用同一份。
    if (
      validateTlsSpoof(spoofSni, spoofMethod, process.arch, isIpLiteral, {
        protocol: protocolLower,
        serverSni: realSni,
      })
    ) {
      outbound.tls.spoof = spoofSni;
      outbound.tls.spoof_method = spoofMethod;
    }
  }

  // Multiplex（vless/trojan/vmess/shadowsocks）；vision flow(xtls-rprx-vision) 自带流分帧、与 mux
  // 不兼容（与是否 reality 无关，普通 TLS+vision 同样不兼容）→ 跳过
  const mux = server.multiplexSettings;
  const hasVisionFlow = (server.flow || '').toLowerCase().includes('vision');
  if (
    mux?.enabled &&
    ['vless', 'trojan', 'vmess', 'shadowsocks'].includes(protocolLower) &&
    !hasVisionFlow
  ) {
    outbound.multiplex = {
      enabled: true,
      protocol: mux.protocol || 'h2mux',
      ...(mux.maxConnections ? { max_connections: mux.maxConnections } : {}),
      ...(mux.minStreams ? { min_streams: mux.minStreams } : {}),
      ...(mux.padding ? { padding: true } : {}),
    };
  }

  // Hysteria2 端口跳跃（serverPorts 为逗号分隔的范围串，如 "20000:30000"，支持多段）
  if (protocolLower === 'hysteria2' && server.hysteria2Settings?.serverPorts) {
    const ports = server.hysteria2Settings.serverPorts
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ports.length > 0) {
      outbound.server_ports = ports;
      if (server.hysteria2Settings.hopInterval) {
        outbound.hop_interval = server.hysteria2Settings.hopInterval;
      }
    }
  }
}

// ---- generateOutbounds 本体 + selector/Tailscale 簇（SingBoxConfigBuilder 抽取 Phase 2 step 10）----

/** rule-sel 载体：ruleKey→(selectorTag,memberTag) 供 generateSingBoxConfig 回填 currentRuleTargetMap 热切换定位。 */
export interface PendingRuleSelector {
  ruleKey: string;
  selectorTag: string;
  memberTag: string;
  targetServerId?: string;
}

/** 注入依赖：generateOutbounds 原读/写的实例态（gateInvalidNodes Map 就地改 / log 回调）。 */
export interface OutboundsDeps {
  gateInvalidNodes: Map<string, InvalidNodeInfo>;
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string) => void;
  // Phase 2：本次启动 sing-box 是否会以提权运行（内核接口可创建）= TUN 模式 + helper。缺省 undefined/false
  // （preflight/speedtest/snapshot/系统代理路径）→ reverseMesh 节点不发射（system:true 需提权，否则启动 FATAL）。
  systemInterfaceAvailable?: boolean;
}

/**
 * 构造 Tailscale endpoint（sing-box 1.12+ 顶层 endpoints[]）。账号制 mesh，无 server address/port。
 * 默认 tsnet 用户态（system_interface 省略=false，零提权）；auth_key 可选（无则核日志出登录 URL）。
 */
export function buildTailscaleEndpoint(server: ServerConfig, tag: string): SingBoxEndpoint {
  const ts = server.tailscaleSettings || {};
  const stateDir = tailscaleStateDir(server.id);
  try {
    require('fs').mkdirSync(stateDir, { recursive: true });
  } catch {
    /* best-effort；目录建失败时 sing-box 自身会报错 */
  }
  const ep: SingBoxEndpoint = { type: 'tailscale', tag, state_directory: stateDir };
  const authKey = ts.authKey?.trim();
  if (authKey) ep.auth_key = authKey;
  const controlUrl = ts.controlUrl?.trim();
  if (controlUrl) ep.control_url = controlUrl;
  const hostname = ts.hostname?.trim();
  if (hostname) ep.hostname = hostname;
  // exit_node 仅在节点「承载全隧道」时下发：关外网→不下发。**TS 的 exit_node 与 system 模式正交**——exit_node
  // 是 tailnet 层概念（选 peer 经 tailnet 出），不落 0/0 OS 默认路由，故不触发结论A 的 0/0 冲突，system:true 下也下发
  // （与 WG 0/0 受 system 约束不同；见 meshNodeCarriesFullTunnel 协议口径 + docs/design/mesh-mode-exit-redesign.md）。
  // 节点仍承载 tailnet/routes 段（force-route）。system_interface 由下方 meshUsesSystemInterface 单独下发。
  const exitNode = meshNodeCarriesFullTunnel(server) ? ts.exitNode?.trim() : undefined;
  if (exitNode) {
    ep.exit_node = exitNode;
    if (ts.exitNodeAllowLanAccess) ep.exit_node_allow_lan_access = true;
  }
  if (ts.acceptRoutes) ep.accept_routes = true;
  if (ts.ephemeral) ep.ephemeral = true;
  const adv = (ts.advertiseRoutes || []).map((c) => c.trim()).filter(Boolean);
  if (adv.length) ep.advertise_routes = adv;
  // P4a 新字段（全可选；sing-box check 实证 1.14-alpha.32）：
  //  advertise_tags（Since 1.12.0）：ACL 标签数组（按标签授权 tailnet）；空清单不下发。
  //  sshServer（ssh_server，Since 1.13.0）：true → ssh_server:true（badoption bool 形式，等价 {enabled:true}）；节点跑 Tailscale SSH。
  //  relayServerPort：>0 → relay_server_port（peer relay 入站中继监听端口）。
  const advTags = (ts.advertiseTags || []).map((tg) => tg.trim()).filter(Boolean);
  if (advTags.length) ep.advertise_tags = advTags;
  if (ts.sshServer) ep.ssh_server = true;
  if (typeof ts.relayServerPort === 'number' && ts.relayServerPort > 0) {
    ep.relay_server_port = ts.relayServerPort;
  }
  // Phase 2：reverseMesh=true → system_interface=true（真 TUN，反向可达/作 subnet router）；需 helper 提权，
  // 由连接闸门/校验确保仅 helper 活跃时成立。缺省省略=tsnet 用户态、零提权。
  // 下发固定 system_interface_name：① 出口托管(MeshExitRouteManager)按此名在内核接口装 exit 拆半默认路由
  //（sing-box 只装 tailnet+子网、不装 exit 0/0，真机实证）；② 起停/清理按名精确定位。见 mesh-exit-route.ts。
  if (meshUsesSystemInterface(server)) {
    ep.system_interface = true;
    // macOS 内核 utun 名由内核动态分配、不接受自定义名（设了可能 FATAL）→ 仅非 macOS 下发固定名；
    // macOS 出口托管按接口地址（tailnet 100.x）反查接口名，不依赖固定名（用户实证 utunXX 动态）。
    if (process.platform !== 'darwin') ep.system_interface_name = TS_SYSTEM_INTERFACE_NAME;
  }
  return ep;
}

/**
 * rule-sel selector 生成：所有 proxy 规则（custom + app）各建独立 selector（anti-drift 热切换）。
 * pendingRuleSelectors 为 buildOutbounds 传入的载体（push 收集），由 generateSingBoxConfig 回填 currentRuleTargetMap。
 */
function generateRuleSelectors(
  config: UserConfig,
  idToTagMap: Map<string, string>,
  nodeTags: string[],
  outbounds: SingBoxOutbound[],
  pendingRuleSelectors: PendingRuleSelector[]
): void {
  const existingTags = new Set(outbounds.map((o) => o.tag).filter((t): t is string => !!t));
  const interrupt = config.interruptConnectionsOnSwitch === true;
  // (selectorTag, memberTag) 收集，供 generateSingBoxConfig 末尾回填 currentRuleTargetMap。
  pendingRuleSelectors.length = 0;

  // rule-sel 恒存在（所有 proxy 规则，无论 targetServerId 有无）：members 含 proxy-selector（嵌套全局），
  // default=target 节点（有）或 proxy-selector（无=跟全局）。使「节点↔默认」= rule-sel default 变化（PUT 热切换），
  // 非 outbound 结构变（重启）。anti-drift 仍保留：固定节点规则 default=节点，不随全局漂。
  const emit = (ruleKey: string, selectorTag: string, targetServerId: string | undefined) => {
    // tag 防撞：节点名可能恰好叫 rule-sel-xxx → 加 (n) 后缀（与 getUniqueTag 同形）
    let tag = selectorTag;
    let n = 1;
    while (existingTags.has(tag)) {
      tag = `${selectorTag} (${n})`;
      n++;
    }
    existingTags.add(tag);
    const targetTag = targetServerId ? idToTagMap.get(targetServerId) : undefined;
    // default：target 有效→节点 tag；target 无/无效→proxy-selector（跟全局，嵌套）
    const defaultTag = targetTag && nodeTags.includes(targetTag) ? targetTag : 'proxy-selector';
    outbounds.push({
      type: 'selector',
      tag,
      outbounds: [...nodeTags, 'proxy-selector'],
      default: defaultTag,
      interrupt_exist_connections: interrupt,
    });
    pendingRuleSelectors.push({
      ruleKey,
      selectorTag: tag,
      memberTag: defaultTag,
      targetServerId,
    });
  };

  for (const rule of effectiveCustomRules(config)) {
    if (!rule.enabled) continue;
    if (rule.action !== 'proxy') continue;
    emit(`custom:${rule.id}`, `rule-sel-${rule.id}`, rule.targetServerId);
  }
  for (const appRule of effectiveAppRules(config)) {
    if (!appRule.enabled) continue;
    if (appRule.action !== 'proxy') continue;
    // appRule 按 appId 去重（effectiveAppRules），用 appId 作 key；selectorTag 加 app- 前缀避免与 customRule 混淆。
    emit(`app:${appRule.appId}`, `rule-sel-app-${appRule.appId}`, appRule.targetServerId);
  }
}

/**
 * 生成 outbounds（节点出站 + selector + rule-sel + direct/block/shadow-tls + detour 死引用预校验）。
 * 注入 gateInvalidNodes/log；返回 outbounds + 两载体 pendingEndpoints/pendingRuleSelectors
 * （由 generateSingBoxConfig 回写 this.*，供顶层 endpoints[] 注入与 hotSwitch/clash_api 回读）。
 */
export function buildOutbounds(
  selectedServer: ServerConfig | null,
  config: UserConfig,
  idToTagMap: Map<string, string>,
  deps: OutboundsDeps
): {
  outbounds: SingBoxOutbound[];
  pendingEndpoints: SingBoxEndpoint[];
  pendingRuleSelectors: PendingRuleSelector[];
} {
  const pendingEndpoints: SingBoxEndpoint[] = [];
  const pendingRuleSelectors: PendingRuleSelector[] = [];
  const outbounds: SingBoxOutbound[] = [];
  // endpoint（WireGuard 等）单独收进 pendingEndpoints（顶层 endpoints[]），但其 tag 仍与节点出站 tag 一同
  // 进入 nodeTags → proxy-selector / rule-sel / route，与普通节点一视同仁（clash_api 热切换已实测兼容）。
  pendingEndpoints.length = 0;
  const nodeTags: string[] = [];
  let systemWgCount = 0; // 多 System WG 唯一内核接口名计数（防多个 system:true WG 都叫 flowz-wg 撞名致核 FATAL）。

  if (config) {
    // 生成【全部】节点的 Outbound：selector 需要列出所有可切换节点；detour 前置节点亦在 config.servers
    // 中，一并生成、通过 detour 字段链接。单个节点配置异常不应拖垮整体配置，逐节点 try/catch 跳过。
    // （app/custom 分流规则指向的固定节点 tag 不变，仍直接命中其节点出站，不经 selector。）
    for (const server of config.servers) {
      const tag = idToTagMap.get(server.id) || `proxy-${server.id}`;
      if (nodeTags.includes(tag)) continue; // 去重（含 endpoint）
      // 不可用节点跳过：naive 缺 libcronet 时，sing-box 启动会预初始化全部出站、缺库的 naive 会让
      // 整个代理启动 FATAL（连非 naive 节点也用不了）。跳过后，路由层对该节点 tag 的死引用会在
      // generateSingBoxConfig 末尾被统一修正为 selector（见 H2 修复）。
      if (!isNodeUsable(server)) {
        deps.log('warn', `跳过不可用节点「${server.name}」：NaiveProxy 缺少 libcronet 核心库`);
        continue;
      }
      // 启动前配置校验 gate 已标记为非法的节点：跳过、不进 outbounds/selector（防 onRetry 重生成复活）。
      // 路由层对其 tag 的死引用由 generateSingBoxConfig 末尾 fixRouteDeadReferences 统一修正为 selector。
      if (deps.gateInvalidNodes.has(server.id)) {
        continue;
      }
      // Phase 2：reverseMesh(system:true 内核接口)需提权——仅 TUN 模式 + helper 下可行。非提权路径（系统代理 /
      // preflight / 测速）**不再跳过、改为降级 gVisor 发射**：userspace 栈零提权可跑 → 该节点在系统代理模式下仍可用
      //（作 gVisor 出口），与 UI「非 TUN 时接入模式显示/按 gVisor」一致（修：非 TUN 下 endpoint 不生成、节点不可用）。
      // system:true 仅在 systemInterfaceAvailable(TUN+helper)时下发；下方按此 flag 把已构造的 endpoint 改回 gVisor。
      const downgradeMeshToGvisor =
        meshUsesSystemInterface(server) && !deps.systemInterfaceAvailable;
      if (downgradeMeshToGvisor) {
        deps.log(
          'info',
          `组网节点「${server.name}」：当前非 TUN 模式，按 gVisor（用户态栈）发射（System 内核接口需 TUN + 提权 helper）`
        );
      }
      // WireGuard：endpoint（非 outbound）。建进 pendingEndpoints，tag 仍入 nodeTags 参与选择器/路由。
      if (server.protocol.toLowerCase() === 'wireguard') {
        // 关外网且无可路由网段 → 空 allowed_ips 会致整份配置 FATAL（D2 实测）。生成期拦截不发射、tag 不入
        // nodeTags（走 isNodeUsable 同款不可用路径，路由层死引用由 fixRouteDeadReferences 兜底）。
        if (isMeshNodeUnroutable(server)) {
          deps.log(
            'warn',
            `跳过组网节点「${server.name}」：已关闭外网访问且无可路由网段（无外网访问权限）`
          );
          continue;
        }
        try {
          // #58：域名 server 的 WG endpoint 需 dial 级 domain_resolver，与普通协议同档（getNodeResolverTag dial）。
          const ep = buildWireGuardEndpoint(server, tag, getNodeResolverTag(config, 'dial'));
          if (downgradeMeshToGvisor) {
            ep.system = false; // 非 TUN：降级 userspace gVisor 栈（零提权可跑）
            delete ep.name; // gVisor 无内核接口名
          } else if (ep.name) {
            // 多个 system:true WG 唯一内核接口名：首个保留 flowz-wg（常见单节点不变），其余追加序号——否则两张
            // 内核接口都叫 flowz-wg → sing-box 建第二张时撞名 FATAL（整核起不来）。序号计数保证唯一（与 id 无关，
            // 避免 id 前缀碰撞）；flowz-wg-N 仍落在 helper ifaceAllowed 的 flowz- 白名单内。MeshExitRouteManager 只
            // 托管 flowz-ts，不依赖 flowz-wg 名，故重命名安全。
            if (systemWgCount > 0) ep.name = `flowz-wg-${systemWgCount}`;
            systemWgCount++;
          }
          pendingEndpoints.push(ep);
          nodeTags.push(tag);
          // 不承载全隧道但有具体段（关外网 或 Phase2 system 内核接口）：节点可用、仅承载列表网段（不当默认
          // 出网）。warn 进诊断报告，便于排查「选它却不出网」。
          if (!meshNodeCarriesFullTunnel(server)) {
            const why = meshNonFullTunnelReason();
            deps.log(
              'warn',
              `组网节点「${server.name}」${why}：仅路由其指定网段，不承载默认出网流量`
            );
          }
        } catch (e: any) {
          deps.log(
            'warn',
            `生成 WireGuard endpoint 失败，已跳过: ${server.name} (${e?.message ?? e})`
          );
        }
        continue;
      }
      // Tailscale：endpoint（账号制 mesh）。always-emit（与 WireGuard 一致，无门控）——每个配置的 TS 节点恒发射进
      // 主核：登录态由管理 API STATUS 流逐节点【持续】报告（需登录的显「需登录」角标，用户点角标按需登录解决，
      // 无需「选中才发射」）；全部在 selector/nodeTags 里 → 切换走 PUT 热切换不重启（对齐 WG）。未登录 endpoint 核
      // 不 FATAL（tsnet 等待授权）；主核 AUTH_URL 全量上报渲染端入 store（per-node），自动 toast 仅当前出口、非
      // 出口看角标按需点开（详见 detectTailscaleAuthUrl + 渲染端登录态）。登录态(loggedIn)真值只由 STATUS 流
      // （Running/Starting && !expired）给，不复用 state 目录为判据 → 不重蹈 #132。
      if (server.protocol.toLowerCase() === 'tailscale') {
        try {
          const ep = buildTailscaleEndpoint(server, tag);
          if (downgradeMeshToGvisor) {
            ep.system_interface = false; // 非 TUN：降级 tsnet 用户态栈（零提权）
            delete ep.system_interface_name;
          }
          pendingEndpoints.push(ep);
          nodeTags.push(tag);
          // P0b 后 meshNodeCarriesFullTunnel(TS) ⟺ !!exitNode，故「不承载全隧道但填了 exitNode」组合不可能存在
          // （原 warn 分支恒 false 死代码，已删）。TS 是否承载全隧道 = 是否配 exit_node，无需再单独 warn「忽略 exit_node」。
        } catch (e: any) {
          deps.log(
            'warn',
            `生成 Tailscale endpoint 失败，已跳过: ${server.name} (${e?.message ?? e})`
          );
        }
        continue;
      }
      // 自定义协议标记为 endpoint 类型（第三方类 wireguard/tailscale 实现）→ 进 endpoints[]；
      // 否则走下方普通 outbound 路径。tag 由 generateProxyOutbound/此处统一注入。
      if (server.protocol.toLowerCase() === 'custom' && server.customSettings?.isEndpoint) {
        const { detour: _d, ...epOutbound } = (server.customSettings.outbound || {}) as Record<
          string,
          unknown
        >;
        pendingEndpoints.push({
          ...(epOutbound as unknown as SingBoxEndpoint),
          tag,
        });
        nodeTags.push(tag);
        continue;
      }
      try {
        const ob = buildProxyOutbound(server, idToTagMap, getNodeResolverTag(config, 'dial'));
        ob.tag = tag;
        if (server.detour && config.servers.some((s) => s.id === server.detour)) {
          // 环检测：沿 detour 链行进，若回到本节点即成环 → 不设 detour，避免 sing-box 报循环引用启动失败
          const seen = new Set<string>([server.id]);
          let cur: string | undefined = server.detour;
          let looped = false;
          while (cur) {
            if (seen.has(cur)) {
              looped = true;
              break;
            }
            seen.add(cur);
            cur = config.servers.find((s) => s.id === cur)?.detour;
          }
          if (looped) {
            deps.log('warn', `检测到代理链成环，已跳过 detour: ${server.name}`);
          } else {
            const detourSrv = config.servers.find((s) => s.id === server.detour);
            if (detourSrv && isEndpointProtocol(detourSrv.protocol)) {
              // endpoint（WireGuard/Tailscale）不作为 outbound 的前置代理(detour)目标（dialer detour→endpoint 语义
              // 未定，且本节点会被下方 detour 死引用预校验误剔）。丢弃 detour（本节点仍直连可用）+ 警告。UI 亦不列
              // endpoint 为 detour 候选（route 规则指向 endpoint 仍合法，仅 detour 不合法——两者语义不同）。
              deps.log(
                'warn',
                `endpoint 节点（WireGuard/Tailscale）不支持作为前置代理(detour)目标，已忽略「${server.name}」的代理链`
              );
            } else {
              ob.detour = idToTagMap.get(server.detour);
            }
          }
        }
        outbounds.push(ob);
        nodeTags.push(tag);
      } catch (e: any) {
        deps.log('warn', `生成节点出站失败，已跳过: ${server.name} (${e?.message ?? e})`);
      }
    }

    // 全局 TLS 分片（PR-6）：开启后对所有已生成的 TCP-TLS 节点出站切分 ClientHello，抗 SNI-DPI。
    // 跳过 hy2/tuic（QUIC 内 TLS、无 TCP ClientHello，死配置）与 naive（Cronet 自管 TLS，拒绝
    // fragment 字段 → 启动 FATAL）。
    // 机制选型：用 outbound 的 `tls.fragment`（按 TCP 段切分代理自身 ClientHello）而非 route action
    // `route-options.tls_fragment`——后者作用于被嗅探出的流量（切内层），非代理自身握手入口。默认仅注入
    // fragment=true，不注入 fragment_fallback_delay（用核心默认 500ms）/record_fragment（保持纯开关）。
    if (config.tlsFragment) {
      for (const ob of outbounds) {
        if (ob.tls && ob.type !== 'hysteria2' && ob.type !== 'tuic' && ob.type !== 'naive') {
          ob.tls.fragment = true;
        }
      }
    }

    // selector：列出已生成的全部节点 tag，default 指向当前选中节点；interrupt_exist_connections 由用户
    // 开关决定（默认 false=优雅切换，现有连接保留至自然关闭）。clash_api `PUT /proxies/proxy-selector`
    // 据此热切换、无需重启 sing-box（详见 switchMode）。路由的 final 与「→代理」规则统一指向本 selector。
    // nodeTags 已在节点循环中按序累积（含 endpoint tag）；空=所有节点生成失败/不可用。
    // 全局直连哨兵（#73）：无真实选中节点，default=direct；direct 恒为 proxy-selector 成员，
    // 支持 clash_api 热切换「直连↔节点」不重启。proxifier 时即便 0 节点也不抛（纯直连合法）。
    const isDirect = isDirectSelection(config.selectedServerId);
    if (nodeTags.length === 0 && !isDirect) {
      throw new Error('没有可用的代理节点出站（所有节点配置生成失败）');
    }
    const selectedServerTag = resolveGlobalExitTag(config.selectedServerId, idToTagMap) || 'proxy';
    outbounds.push({
      type: 'selector',
      tag: 'proxy-selector',
      outbounds: [...nodeTags, 'direct'],
      default: isDirect
        ? 'direct'
        : nodeTags.includes(selectedServerTag)
          ? selectedServerTag
          : nodeTags[0],
      interrupt_exist_connections: config.interruptConnectionsOnSwitch === true,
    });

    // rule-sel：恒优化后「所有 proxy 规则」均生成独立 selector（无论 targetServerId 有无）。
    //   有 target → default=目标节点（anti-drift：固定规则不经共享 proxy-selector，热切全局节点后不漂走）；
    //   无 target → default=proxy-selector（跟全局，嵌套）。「节点↔默认」切换 = rule-sel default 变（PUT 热切换），
    //   非 outbound 结构变（重启）。members 复用 proxy-selector 的可用 nodeTags（已排除 naive 缺库 / gate-invalid /
    //   detour 死引用剔除的节点）；目标无效/被 gate 剔除/无 target → default 落 proxy-selector 兜底
    //   （rule-sel 仍建、不 FATAL，与 fixRouteDeadReferences 兜底语义一致）。
    // 仅 smart 生成：用户路由仅 smart 生效，global/direct 下 effectiveCustomRules/effectiveAppRules 为空 → 无 proxy 规则、无消费者。
    if ((config.proxyMode || 'smart').toLowerCase() === 'smart') {
      generateRuleSelectors(config, idToTagMap, nodeTags, outbounds, pendingRuleSelectors);
    }
  } else if (selectedServer) {
    // Fallback if config is missing (shouldn't happen)
    outbounds.push(
      buildProxyOutbound(selectedServer, idToTagMap, getNodeResolverTag(config, 'dial'))
    );
  }

  // 直连出站。domain_resolver：FakeIP 模式下国内内容（geosite-cn→direct）真实 IP 解析的唯一落点——direct 对 fakeip
  // 反查域名二次解析时用它（无则回退 route.default_domain_resolver=dns-bootstrap）。根治 §3.2（数据流确证）：显式指
  // getDomesticResolverTag（race on→dns-node-race 多上游国内 race / off→dns-bootstrap=现状），让国内内容享共用 race server。
  outbounds.push({
    type: 'direct',
    tag: 'direct',
    domain_resolver: getDomesticResolverTag(config, 'dns-bootstrap'),
  });

  // 阻断出站
  outbounds.push({
    type: 'block',
    tag: 'block',
  });

  // Shadow-TLS 后处理：如果主节点或任意辅助节点使用了 Shadow-TLS，
  // 为每个使用 Shadow-TLS 的节点插入内层 SS outbound
  const stlsOutbounds: SingBoxOutbound[] = [];
  for (const ob of outbounds) {
    // 根据 tag（节点名称）反查对应的 ServerConfig；selector/direct/block 等非节点出站匹配不到 → 跳过
    const srv = config?.servers.find((s) => idToTagMap.get(s.id) === ob.tag);
    if (srv?.shadowTlsSettings) {
      // 创建独立的外层 ShadowTLS outbound
      const stlsTag = `stls-out-${srv.id}`;
      const stlsOutbound: SingBoxOutbound = {
        type: 'shadowtls',
        tag: stlsTag,
        // issue #147：外层 shadowtls 是真正的 TCP 拨号目标（内层 SS 经 detour 指向它），server 恒用原域名，
        // 交内核运行时解析（取代 resolve-ahead 烧 IP）。server_name 仍用 shadowTlsSettings.sni（身份），不受影响。
        server: srv.address,
        // port `||` 非 falsy-zero bug：ShadowTLS 端口合法值 1-65535，0/未设 → 降级用主端口；
        // 改 `??` 反而会把非法 0 透传给核致 FATAL，故 `||` 才是正确选择。
        server_port: srv.shadowTlsSettings.port || srv.port,
        version: 3,
        password: srv.shadowTlsSettings.password,
        tls: {
          enabled: true,
          server_name: srv.shadowTlsSettings.sni || undefined,
          utls: {
            enabled: true,
            fingerprint: srv.shadowTlsSettings.fingerprint || 'chrome',
          },
        },
      };
      stlsOutbounds.push(stlsOutbound);

      // 主 outbound (原本的 shadowsocks) 必须作为应用的路由目标
      // 所以我们保留它为 proxy (shadowsocks)，但将其 detour 指向新增的 shadowtls outbound
      ob.detour = stlsTag;

      // 当配置了 detour 后，sing-box 通常期望主 outbound 的 server/port 被忽略
      // 但为了规范，我们可以保留 shadowsocks 的原参数或统一指向实际伪装的地址
      // 在 ShadowTLS 架构中，外层负责 TLS 握手连接真实服务器地址，内层 SS 则是被保护的流量
    }
  }
  outbounds.push(...stlsOutbounds);

  // detour 引用预校验（补 check 唯一盲区：start-stage 引用解析——check 过、run 时报
  // `dependency[X] not found for outbound[Y]` FATAL）。任何 outbound.detour 指向「生成集合内不存在的
  // tag」→ 剔除该引用方（**不删 detour 字段**，与 pruneTagsClosure 同隐私语义；选中节点则 throw），
  // 从 selector 删成员并记录 gateInvalidNodes；selector 剔空 throw。仅 config 存在时有 selector，需 guard。
  if (config) {
    const tagToServerId = (tag: string): string | undefined => {
      if (tag.startsWith('stls-out-')) return tag.slice('stls-out-'.length);
      for (const [id, t] of idToTagMap) {
        if (t === tag) return id;
      }
      return undefined;
    };
    const selector = outbounds.find((o) => o.tag === 'proxy-selector');
    const selectedTag = selectedServer ? idToTagMap.get(selectedServer.id) : undefined;
    let mutated = false;
    // 反复扫描：剔一个引用方可能让别的 detour 链断裂，收敛到不再有死引用。

    while (true) {
      const validTags = new Set(outbounds.map((o) => o.tag).filter((t): t is string => !!t));
      const dead = outbounds.find(
        (ob) => ob.detour !== undefined && !validTags.has(ob.detour) && ob.tag !== 'proxy-selector'
      );
      if (!dead) break;
      if (dead.tag === selectedTag) {
        throw new Error(
          `选中节点「${dead.tag}」的代理链依赖的前置节点不存在，无法启动，请更换节点后重试`
        );
      }
      // 删该引用方 outbound + selector 成员；记录 gateInvalidNodes。
      const removedTag = dead.tag;
      const sid = tagToServerId(removedTag);
      outbounds.splice(outbounds.indexOf(dead), 1);
      // 同步剔除所有 selector（proxy-selector + 各 rule-sel）的成员引用：rule-sel 的 members 与
      // proxy-selector 同源（generateRuleSelectors 复用 nodeTags 快照），节点被剔后须一并清理，否则
      // rule-sel 引用幽灵 tag → sing-box 启动 FATAL。default 命中被剔 → rule-sel 回 proxy-selector、
      // proxy-selector 落剩余首节点（MED-1，见 prunedSelectorDefault；不 FATAL）。
      const allSelectors = outbounds.filter(
        (o) => o.type === 'selector' && Array.isArray(o.outbounds)
      );
      for (const sel of allSelectors) {
        sel.outbounds = (sel.outbounds as string[]).filter((t) => t !== removedTag);
        if (sel.default === removedTag) {
          sel.default = prunedSelectorDefault(sel.tag, sel.outbounds as string[]);
        }
      }
      if (sid) {
        idToTagMap.delete(sid);
        if (!deps.gateInvalidNodes.has(sid)) {
          deps.gateInvalidNodes.set(sid, {
            id: sid,
            tag: removedTag,
            reason: '代理链依赖的前置节点不存在（detour 引用无效）',
          });
        }
      }
      deps.log('warn', `启动前配置校验：节点「${removedTag}」的 detour 引用无效，已剔除`);
      mutated = true;
    }
    if (
      mutated &&
      selector &&
      Array.isArray(selector.outbounds) &&
      selector.outbounds.length === 0
    ) {
      throw new Error('没有可用的代理节点出站（节点代理链依赖无效）');
    }
    // rule-sel 剔空（members 全被 detour 死引用剔除）：删该 selector outbound，对应 route 规则的
    // outbound（rule-sel-<id>）成死引用 → fixRouteDeadReferences 兜底改写为 proxy-selector，启动不 FATAL。
    if (mutated) {
      for (let i = outbounds.length - 1; i >= 0; i--) {
        const o = outbounds[i];
        if (
          o.type === 'selector' &&
          o.tag !== 'proxy-selector' &&
          o.tag &&
          o.tag.startsWith('rule-sel') &&
          Array.isArray(o.outbounds) &&
          o.outbounds.length === 0
        ) {
          outbounds.splice(i, 1);
        }
      }
    }
  }

  return { outbounds, pendingEndpoints, pendingRuleSelectors };
}
