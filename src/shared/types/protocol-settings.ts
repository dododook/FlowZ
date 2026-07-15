export type Hysteria2Network = 'tcp' | 'udp';

export interface TlsSettings {
  serverName?: string;
  allowInsecure?: boolean;
  alpn?: string[];
  fingerprint?: string;
  ech?: boolean; // Encrypted Client Hello（隐藏 SNI）；sing-box tls.ech.enabled
  echConfig?: string; // 可选 ECHConfigList(PEM)；空=sing-box 从 DNS(HTTPS RR type65) 自取，填=下发 tls.ech.config
  fragment?: boolean; // TLS ClientHello 分片，抗 SNI-DPI；sing-box tls.fragment
  // TLS 栈引擎（P3c，sing-box 1.14 tls.engine）：'go'=跨平台 Go TLS（默认，省略=等价 go）；
  // 'windows'=Schannel（仅 Windows）；'apple'=Network.framework（仅 Apple）。系统原生栈让 ClientHello 指纹更真，
  // 但 windows/apple 在非对应平台运行时 FATAL → 表单仅对 TCP-TLS 协议（非 QUIC）暴露，且按平台过滤可选值。
  engine?: 'go' | 'windows' | 'apple';
  // TLS spoof（P3a 抗审查，sing-box 1.14 tls.spoof/spoof_method）：真握手前发伪造 ClientHello 骗 SNI 过滤中间盒。
  // spoofMethod 非空 + spoofSni 非空（成对）才启用 → tls.spoof=spoofSni（伪造 ClientHello 的「诱饵 SNI」）、
  // tls.spoof_method=spoofMethod。方法仅 wrong-ack/wrong-md5/wrong-timestamp（sing-box check 实证）。
  // **硬限界（已 sing-box 真核 check 实证，见 shared/tls-spoof.ts）**：需提权、ARM64 不支持、诱饵 SNI 须为域名（拒 IP 字面量）、
  //   且**诱饵 SNI 必须不同于真 server_name**（内核 FATAL `spoof must differ from server_name`）。
  //   表单按 arch 门控置灰；构建期对 IP 字面量、等于 server_name、QUIC/naive 协议不 emit。
  spoofSni?: string;
  spoofMethod?: 'wrong-ack' | 'wrong-md5' | 'wrong-timestamp';
}

export interface RealitySettings {
  publicKey: string;
  shortId?: string;
}

export interface WebSocketSettings {
  path?: string;
  headers?: Record<string, string>;
  maxEarlyData?: number;
  earlyDataHeaderName?: string;
}

export interface GrpcSettings {
  serviceName?: string;
  multiMode?: boolean;
}

export interface HttpSettings {
  host?: string[];
  path?: string;
  method?: string;
  headers?: Record<string, string[]>;
}

// Hysteria2 混淆类型（sing-box 1.14 新增 gecko，与 salamander 并列）。gecko 经 min/max_packet_size 调随机填充长度。
export type Hysteria2ObfsType = 'salamander' | 'gecko';

export interface Hysteria2ObfsSettings {
  type?: Hysteria2ObfsType;
  password?: string;
  // gecko obfs 随机填充包长（P3b，sing-box obfs.min_packet_size / max_packet_size）。仅 gecko 有意义；
  // salamander 忽略。留空用核心默认。
  minPacketSize?: number;
  maxPacketSize?: number;
}

// Hysteria2 BBR 拥塞控制 profile（P3b，sing-box 1.14 bbr_profile）。仅这三个合法值（已 sing-box check 实证：
// 其它值 → "unsupported BBR profile"）；留空 = 核心默认拥塞控制。
export type Hysteria2BbrProfile = 'standard' | 'aggressive' | 'conservative';

export interface Hysteria2Settings {
  upMbps?: number;
  downMbps?: number;
  obfs?: Hysteria2ObfsSettings;
  network?: Hysteria2Network;
  serverPorts?: string; // 端口跳跃范围，如 "20000:30000"；sing-box server_ports
  hopInterval?: string; // 端口跳跃间隔，如 "30s"；sing-box hop_interval
  bbrProfile?: Hysteria2BbrProfile; // BBR 拥塞控制 profile；sing-box bbr_profile
}

// Snell 协议版本（sing-box 1.14.0-alpha.38+ 官方 outbound）：4=v4（obfs 系）/ 6=v6（mode 系），主开关。
export type SnellVersion = 4 | 6;

// Snell 协议设置（psk 复用 ServerConfig.password，同 trojan/hysteria2 惯例；snell 不走 TLS 块）。
// obfs*（仅 v4）与 mode（仅 v6）互斥——表单按 version 条件渲染，提交时 normalize 清对侧字段防脏下发。
export interface SnellSettings {
  version: SnellVersion; // 必填；决定 obfs（v4）/ mode（v6）分支
  obfsMode?: 'none' | 'http'; // 仅 v4；默认 none（不下发 obfs_*）
  obfsHost?: string; // 仅 v4 + obfsMode=http；默认 bing.com
  mode?: 'default' | 'unshaped' | 'unsafe-raw'; // 仅 v6；默认 default（不下发）
  reuse?: boolean; // 连接复用（v2 CONNECT）；默认 false
  network?: 'tcp' | 'udp'; // 省略 = both
  userkey?: string; // 多用户服务器鉴权 key；敏感，已进 diagnostic-redact 黑名单
}

// 供 vless/trojan/vmess/shadowsocks 使用；注意 reality+vision(xtls-rprx-vision) 不兼容
export interface MultiplexSettings {
  enabled?: boolean;
  protocol?: 'smux' | 'yamux' | 'h2mux'; // 默认 h2mux
  maxConnections?: number;
  minStreams?: number;
  padding?: boolean; // 流量填充，增强抗特征
}

export interface TuicSettings {
  congestionControl?: 'bbr' | 'cubic' | 'new_reno';
  udpRelayMode?: 'native' | 'quic';
  zeroRttHandshake?: boolean;
  heartbeat?: string;
}

export interface NaiveSettings {
  useHttp3?: boolean; // 使用 HTTP/3 (QUIC) 传输；sing-box naive outbound 的 quic 字段
}

export interface ShadowsocksSettings {
  method: string;
  password: string;
  plugin?: string;
  pluginOptions?: string;
}

export interface AnyTlsSettings {
  idleSessionCheckInterval?: string; // e.g. '30s'
  idleSessionTimeout?: string; // e.g. '30s'
  minIdleSession?: number; // default 0
}

export interface SshSettings {
  user?: string; // SSH 用户名，默认 root
  password?: string; // 密码认证
  privateKey?: string; // 内联私钥内容
  privateKeyPath?: string; // 私钥文件路径，如 $HOME/.ssh/id_rsa
  privateKeyPassphrase?: string; // 私钥密码
  hostKey?: string[]; // 主机公钥（留空接受所有）
  hostKeyAlgorithms?: string[]; // 主机密钥算法
  clientVersion?: string; // 客户端版本字符串
  // SSH 算法协商可选项（P3d，sing-box outbound cipher / mac / kex_algorithm）。对接老/特定 SSH 服务端时覆盖默认算法集。
  // 留空 = 用 golang.org/x/crypto/ssh 默认。字段名以 sing-box check 实证为准（cipher/mac/kex_algorithm，非 ciphers/macs/key_exchange）。
  cipher?: string[]; // 对称加密算法；sing-box cipher
  mac?: string[]; // 消息认证码算法；sing-box mac
  kexAlgorithm?: string[]; // 密钥交换算法；sing-box kex_algorithm
}

// Shadow-TLS 插件设置（套在 SS/其他协议外层，版本固定 v3）
export interface ShadowTlsSettings {
  password: string; // Shadow-TLS v3 密码
  sni: string; // 伪装的目标域名
  fingerprint?: string; // uTLS 指纹，默认 chrome
  port?: number; // Shadow-TLS 监听/转发的真实端口 (可选)
}

/**
 * WireGuard endpoint 设置（sing-box 1.11+ endpoint；默认 gVisor 用户态栈、零额外提权）。
 * 单 peer 模型：peer 的 endpoint 用 ServerConfig.address/port 承载（与其他协议一致），其余 peer 参数在此。
 */
export interface WireGuardSettings {
  privateKey: string; // 本地私钥（base64）
  localAddress: string[]; // 本地隧道地址（wg-quick [Interface].Address），如 ['10.0.0.2/32','fd00::2/128']
  peerPublicKey: string; // 对端公钥（base64）
  preSharedKey?: string; // 可选预共享密钥（base64）
  allowedIPs?: string[]; // 「具体路由段」(对端内网/子网)；全网段 0/0,::/0 由 allowInternet 接管（缺 catch-all 时仅承载列表段）
  // 是否允许此节点作外网出口（缺省 true=向后兼容+新建默认开）。true→peer.allowed_ips 含 0/0,::/0（全隧道）；
  // false→仅 allowedIPs 具体段（不当默认出网；若无具体段则空 allowed_ips=FATAL，生成期不发射该节点）。
  allowInternet?: boolean;
  // 是否「始终路由其内网段(组网)」（缺省 true=向后兼容+新建默认开=网段恒可达）。false=「仅出网」：allowedIPs 具体段
  // 仅在此节点被选中为主出口、或被自定义规则/应用分流显式指向（targetServerId）时才 force-route，其余不强加给全局。
  // **只 gate route.rules（force-route），不影响 peer.allowed_ips**（隧道仍接受这些段，故选中时网段照样可达）。
  alwaysRouteSubnets?: boolean;
  persistentKeepalive?: number; // 保活间隔（秒）
  reserved?: number[]; // 3 字节 reserved（Cloudflare WARP 等需要）
  mtu?: number; // 缺省 1408
  // Phase 2：反向 mesh（system=真内核 WG 接口，提供「被组网访问/作 subnet router」反向可达）；默认 false=userspace
  // gVisor 栈。true 时 peer.allowed_ips 恒 specific-only（去 0/0，结论A：内核接口永不当全局出口），需 helper/提权。
  reverseMesh?: boolean;
  // Cloudflare WARP 设备凭据（仅 WARP 注册产出的节点填；普通 WG 节点无）。deviceId+token 是注册时一次性返回、
  // 事后无法再取的「自删凭据」——删除此节点时据它发 DELETE /reg/{deviceId} 注销远端匿名设备（见 WARP 设计 §设备移除）。
  // token 与 privateKey 同信任类（device-scoped、客户端所有），随 config 落盘 + 经诊断脱敏（SECRET_KEYS 含 token）。
  warpDevice?: { deviceId: string; token: string };
}

// Tailscale（sing-box endpoint，账号制 mesh，无 server address/port——连控制面）。Phase 1 userspace。
export interface TailscaleSettings {
  authKey?: string; // pre-auth key（可选；无则核日志出 `Waiting for authentication: <url>` 交互登录）
  // 是否允许此节点作外网出口（缺省 true=向后兼容+新建默认开）。WG 等价物：true→可下发 exit_node（全隧道）；
  // false→即便填了 exitNode 也不下发，仅承载 tailnet/routes 段（不当默认出网）。
  allowInternet?: boolean;
  // 是否「始终路由其内网段/tailnet(组网)」（缺省 true=向后兼容）。false=「仅出网」：tailnet 100.64.0.0/10 + routes 段
  // 仅在此节点被选中为主出口、或被规则显式指向时才 force-route。纯 exit-node 用法（只借此出网、不想 tailnet 恒路由）受益。
  alwaysRouteSubnets?: boolean;
  exitNode?: string; // 出口节点 name/IP（选它当全局代理时填；空=仅通 tailnet 内网/accept_routes 段）
  exitNodeAllowLanAccess?: boolean; // 用 exit node 时本地 LAN 仍直连
  acceptRoutes?: boolean; // 接受其它节点广告的子网路由（访问 tailnet 内网段）
  // 经此 Tailscale 节点路由的子网（CIDR）= WG allowedIPs 的等价物（FlowZ force-route 源）。
  // 与 advertiseRoutes 不同：advertiseRoutes 是「本机对外广告」，routes 是「把这些段的流量送进此节点」。
  // FlowZ userspace 下自动含 tailnet 段 100.64.0.0/10 + 这里填的 advertised 子网。需配 acceptRoutes 才真正接收。
  routes?: string[];
  controlUrl?: string; // 默认 controlplane.tailscale.com；Headscale 自建控制面填此
  hostname?: string; // 节点名（默认系统主机名）
  ephemeral?: boolean; // 临时节点（离线即注销）
  advertiseRoutes?: string[]; // 本机作子网路由器对外广告的段
  reverseMesh?: boolean; // Phase 2：反向 mesh（system_interface=真 TUN，被组网访问）；默认 false=userspace
  // P4a endpoint 新字段（1.14，全可选；sing-box check 实证 alpha.32）：
  advertiseTags?: string[]; // 向 tailnet 广告的 ACL 标签（如 tag:server）；按标签授权场景
  sshServer?: boolean; // 节点跑 Tailscale SSH（tailnet:22，ACL 控权）→ endpoint.ssh_server:true
  relayServerPort?: number; // 作 peer relay 收入站中继的监听端口 → endpoint.relay_server_port
  // P4b 按名解析（仅选中此 mesh 节点为主出口时生效，详见 singbox-dns-builder）：
  // resolveByName=true → 注入 tailscale DNS server(accept_search_domain) + preferred_by 规则，
  //   让 tailnet 短名/MagicDNS 名自动归位到此节点解析（与 doh.pub/google 并存，仅 tailnet 域走它）。
  resolveByName?: boolean; // 启用 tailnet 按名解析（短名 + preferred_by 强联动）
  acceptDefaultResolvers?: boolean; // 额外接受 tailnet 推送的默认 DNS 解析器（可选；resolveByName 开时才有意义）
}

// 自定义协议（raw-JSON 透传）：用户直接填一份 sing-box outbound/endpoint JSON，FlowZ 不解析语义、只注入 tag。
// 供第三方内核协议（如 snell）使用——「内核即权威」：能否启用由 sing-box check probe / 启动 gate 判定，FlowZ 不维护
// type 白名单。address/port 由 JSON 内部携带，不用 ServerConfig.address/port。
export interface CustomSettings {
  outbound: Record<string, unknown>; // 用户填的 outbound/endpoint 对象（须含字符串 type）；tag 由 FlowZ 生成期强制覆盖
  isEndpoint?: boolean; // 该 type 属 sing-box endpoints[]（如类 wireguard/tailscale 的第三方实现）而非 outbounds[]
  secretKeys?: string[]; // 该 JSON 里属密钥的键名（诊断报告脱敏用：redactDeep 据此叠加打码）。无值层启发式，未声明则仅靠通用密钥黑名单兜底（psk/password/uuid 等），建议填全自定义密钥键
}
