/**
 * sing-box 1.12.x / 1.13.x 配置类型定义 —— 从 ProxyManager 抽出（SingBoxConfigBuilder 抽取 Phase 2 地基）。
 * 纯类型声明、零行为；ProxyManager + 后续 SingBoxConfigBuilder 共用。
 */

export interface SingBoxLogConfig {
  level: string;
  timestamp: boolean;
  output?: string;
  disabled?: boolean;
}

export interface SingBoxDnsServer {
  tag: string;
  type?: string;
  server?: string;
  server_port?: number;
  /** DoH path, e.g. "/dns-query" */
  path?: string;
  /** Bootstrap resolver tag: required when server is a domain name (sing-box 1.12+ new format) */
  domain_resolver?: string;
  detour?: string;
  // Tailscale DNS server（1.14；P4b，sing-box check 实证 alpha.32）：type:"tailscale" 须引用一个
  // tailscale endpoint 的 tag（endpoint 必填，缺失则 FATAL）。accept_search_domain=短名/MagicDNS/split-DNS；
  // accept_default_resolvers=额外接受 tailnet 推送的默认解析器。
  endpoint?: string;
  accept_search_domain?: boolean;
  accept_default_resolvers?: boolean;
  // neighbor_domain（1.14；P6 LAN 网关，Listable[string]）：local DNS server 对这些后缀的单标签短名走邻居
  // 解析（主机名→IP）。每条**须以 '.' 开头**（内核 init `entry must start with '.'`）；仅 Linux/macOS 生效。
  // 实证：resources/linux/sing-box(1.14-alpha.32) check —— 接受数组/单串，'.' 匹配任意单标签名。
  neighbor_domain?: string[];
  // Legacy / compat fields (not emitted in new format)
  address?: string;
  address_resolver?: string;
  // FakeIP specific
  inet4_range?: string;
  inet6_range?: string;
}

export interface SingBoxDnsRule {
  rule_set?: string;
  query_type?: string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  // source_mac_address / source_hostname（1.14；P6 LAN 网关，Listable[string]）：按源设备 MAC / DHCP 主机名
  // 分流 DNS。仅 Linux/macOS。sing-box check 实证 alpha.32（须配 default_domain_resolver）。
  source_mac_address?: string[];
  source_hostname?: string[];
  // preferred_by（1.14；P4b，Listable[string]）：把「某 DNS server 视为首选名」的域名（search domain /
  // MagicDNS 名）路由给它——替代硬编码 tailnet 后缀。须配 action:"route" + server 指向同一 tailscale server。
  preferred_by?: string[];
  action?: string;
  // preferred_by 规则下 server 可省（由 action 决定），故放宽为可选。
  server?: string;
}

export interface SingBoxFakeIPConfig {
  enabled: boolean;
  inet4_range?: string;
  inet6_range?: string;
}

export interface SingBoxDnsConfig {
  servers: SingBoxDnsServer[];
  rules?: SingBoxDnsRule[];
  final?: string;
  strategy?: string;
  fakeip?: SingBoxFakeIPConfig;
  // 关 FakeIP 时注入：用 DNS 解析结果反查域名补无 SNI/ECH 流量的路由匹配（不改节点收 IP 事实）。
  reverse_mapping?: boolean;
  // P2b 乐观 DNS 缓存（sing-box 1.14 顶层 dns.optimistic，boolean）：过期先返旧值后台刷新。仅 true 时下发。
  // schema 实证：resources/linux/sing-box(1.14-alpha.32) check —— dns.optimistic 接受 boolean，server 级 optimistic 报 unknown field。
  optimistic?: boolean;
  // P2c DNS 查询超时（sing-box 1.14 顶层 dns.timeout，Go duration 字符串，如 "5s"/"500ms"）：治理慢上游。仅 >0 时下发。
  // schema 实证：dns.timeout 须带单位字符串（裸数字 / 空串 FATAL；server 级 timeout 报 unknown field）。
  timeout?: string;
}

export interface SingBoxInbound {
  type: string;
  tag: string;
  listen?: string;
  listen_port?: number;
  // TUN 模式
  interface_name?: string;
  address?: string[];
  mtu?: number;
  auto_route?: boolean;
  // auto_redirect（1.10+）：Linux 用 nftables 改善 TUN 路由/性能。P6 LAN 网关按 MAC 过滤设备进 TUN 时**必发**
  // （include/exclude_mac_address 内核硬限界=Linux + auto_route + auto_redirect，缺则 init FATAL）。
  auto_redirect?: boolean;
  strict_route?: boolean;
  stack?: string;
  sniff?: boolean; // sing-box 1.14 已移 inbound 级 sniff；保留字段仅为旧单测断言兼容，生成时不下发
  route_exclude_address?: string[];
  // include/exclude_mac_address（1.14；P6 LAN 网关，Listable[string]，互斥）：按 MAC 限/排设备进 TUN。
  // **仅 Linux + auto_route + auto_redirect**；脏 MAC → check/启动 FATAL。构建期门控见 buildInbounds。
  include_mac_address?: string[];
  exclude_mac_address?: string[];
  platform?: {
    http_proxy?: {
      enabled: boolean;
      server: string;
      server_port: number;
    };
  };
}

export interface SingBoxOutbound {
  type: string;
  tag: string;
  detour?: string; // 代理链
  server?: string;
  server_port?: number;
  override_address?: string;
  // Shadowsocks
  method?: string;
  password?: string;
  username?: string;
  plugin?: string;
  plugin_opts?: string;
  // VLESS / VMess
  uuid?: string;
  security?: string; // vmess specific
  alter_id?: number; // vmess specific
  flow?: string;
  packet_encoding?: string;
  // Trojan and Hysteria2
  // password?: string; // Shared with SS
  // Hysteria2 specific
  up_mbps?: number;
  down_mbps?: number;
  obfs?: {
    type: string;
    password: string;
    // gecko obfs 随机填充包长（sing-box 1.14）
    min_packet_size?: number;
    max_packet_size?: number;
  };
  // Hysteria2 BBR 拥塞控制 profile（sing-box 1.14）：standard / aggressive / conservative
  bbr_profile?: string;
  network?: string;
  // naive specific: 走 HTTP/3 (QUIC) 传输
  quic?: boolean;
  // TUIC specific
  congestion_control?: string;
  udp_relay_mode?: string;
  zero_rtt_handshake?: boolean;
  heartbeat?: string;
  // ShadowTLS specific
  version?: number;
  // AnyTLS specific
  idle_session_check_interval?: string;
  idle_session_timeout?: string;
  min_idle_session?: number;
  // TLS
  tls?: {
    enabled: boolean;
    server_name?: string;
    insecure?: boolean;
    alpn?: string[];
    // TLS 栈引擎（sing-box 1.14）：go（默认/省略）/ windows(Schannel) / apple(Network.framework)
    engine?: string;
    // TLS spoof（sing-box 1.14 抗审查）：spoof=伪造 ClientHello 的 SNI（字符串，非空才生效）；
    // spoof_method=方法（wrong-ack/wrong-md5/wrong-timestamp）。内核：spoof_method 非空时 spoof 必须非空。
    spoof?: string;
    spoof_method?: string;
    utls?: {
      enabled: boolean;
      fingerprint: string;
    };
    reality?: {
      enabled: boolean;
      public_key: string;
      short_id: string;
    };
    ech?: { enabled: boolean; config?: string[] };
    fragment?: boolean;
  };
  // Transport
  transport?: {
    type: string;
    path?: string;
    host?: string | string[];
    method?: string;
    headers?: Record<string, string | string[]>;
    service_name?: string;
    max_early_data?: number;
    early_data_header_name?: string;
  };
  // Multiplex 多路复用
  multiplex?: {
    enabled: boolean;
    protocol?: string;
    max_connections?: number;
    min_streams?: number;
    padding?: boolean;
  };
  // Hysteria2 端口跳跃
  server_ports?: string[];
  hop_interval?: string;
  // DNS resolver for outbound server domain
  domain_resolver?: string;
  // UDP over TCP (UoT)
  udp_over_tcp?: {
    enabled: boolean;
    version: number;
  };
  // Direct outbound: UDP fragmentation (also used to mark outbound as "non-empty" for sing-box 1.13+ validation)
  udp_fragment?: boolean;
  // SSH specific
  user?: string;
  private_key?: string;
  private_key_path?: string;
  private_key_passphrase?: string;
  host_key?: string[];
  host_key_algorithms?: string[];
  client_version?: string;
  // SSH 算法协商（sing-box 1.14）：cipher / mac / kex_algorithm
  cipher?: string[];
  mac?: string[];
  kex_algorithm?: string[];
  // selector specific（用于 clash_api 热切换节点：default=当前选中，interrupt_exist_connections=切换时是否中断现有连接）
  outbounds?: string[];
  default?: string;
  interrupt_exist_connections?: boolean;
}

export interface SingBoxWireGuardPeer {
  address: string;
  port: number;
  public_key: string;
  pre_shared_key?: string;
  allowed_ips: string[];
  persistent_keepalive_interval?: number;
  reserved?: number[];
}

// sing-box endpoint（1.11+）：独立于 outbound 的顶层 endpoints[] 元素，其 tag 可被 route/selector 当 outbound 引用。
// WireGuard + Tailscale（默认用户态：WG system=false / TS system_interface=false，零提权）。
export interface SingBoxEndpoint {
  type: string;
  tag: string;
  // Dial Fields（endpoint 顶层继承）：sing-box 1.14 起，server 用域名的 endpoint 需 dial 级 domain_resolver
  // （或 route.default_domain_resolver），否则域名解析无确定上游。WG peer.address 为域名时显式下发，
  // 与 buildProxyOutbound 的 outbound.domain_resolver 同口径（IP server 不需 DNS 解析，故不下发）。
  domain_resolver?: string;
  // WireGuard
  system?: boolean;
  mtu?: number;
  address?: string[];
  private_key?: string;
  listen_port?: number;
  peers?: SingBoxWireGuardPeer[];
  udp_timeout?: string;
  workers?: number;
  // Tailscale（账号制 mesh；默认 tsnet 用户态。system_interface=Phase 2 反向 mesh）
  auth_key?: string;
  state_directory?: string;
  control_url?: string;
  hostname?: string;
  exit_node?: string;
  exit_node_allow_lan_access?: boolean;
  accept_routes?: boolean;
  ephemeral?: boolean;
  advertise_routes?: string[];
  system_interface?: boolean;
  // 固定内核接口名（仅 system=true 时下发）：出口托管按此名装/清 exit 拆半默认路由 + 精确定位。
  // TS 端点用 system_interface_name；WG 端点用 `name`（两协议对应键不同——sing-box 1.14 check 实证：WG 端点下
  // interface_name/system_interface_name 均 FATAL `unknown field`，唯 `name` 通过）。
  system_interface_name?: string;
  name?: string;
  // 1.14 新增（P4a，sing-box check 实证 alpha.32）：
  //  advertise_tags = Listable[string]（ACL 标签，向 tailnet 广告本机标签；按标签授权场景）。
  //  ssh_server = badoption（bool 或 {enabled:bool}，唯一合法键 enabled）：节点跑 Tailscale SSH（tailnet:22，ACL 控权）。
  //               FlowZ 以 bool 下发（最简形式，等价 {enabled:true}）。
  //  relay_server_port = int（作 peer relay 收入站中继的监听端口；唯一的 relay_server_* 字段，无 relay_server 开关）。
  advertise_tags?: string[];
  ssh_server?: boolean;
  relay_server_port?: number;
}

export interface SingBoxRouteRule {
  protocol?: string;
  network?: string[];
  rule_set?: string | string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  domain_regex?: string[];
  geosite?: string[];
  ip_cidr?: string[];
  source_ip_cidr?: string[];
  port?: number | number[];
  port_range?: string[];
  source_port?: number | number[];
  source_port_range?: string[];
  // source_mac_address / source_hostname（1.14；P6 LAN 网关，Listable[string]）：按源设备 MAC / DHCP 主机名
  // 分流。仅 Linux/macOS（win32 内核不支持→构建期不发射，见 singbox-custom-rules）。sing-box check 实证 alpha.32。
  source_mac_address?: string[];
  source_hostname?: string[];
  process_name?: string | string[];
  process_path?: string | string[];
  process_name_not?: string | string[]; // sing-box 1.13+
  inbound?: string | string[]; // sing-box 1.13+
  action?: string; // logical 子规则为纯 matcher 无 action；default/logical 外层显式设 'route'
  outbound?: string;
  // preferred_by（1.11+；route rule matcher）：按 outbound/endpoint tag 反查其 PreferredAddress/PreferredDomain
  //（WG=peer allowed_ips Lookup / TS=routePrefixes + MagicDNS）命中即路由到该 outbound。块 0c 试点用它让 endpoint
  // 自声明归位、替代手动 ip_cidr（限非全隧道节点；全隧道含 0/0 会令 PreferredAddress 恒 true 抢全局，仍走 ip_cidr）。
  preferred_by?: string[];
  sniffer?: string[];
  rewrite_target?: boolean; // sing-box 1.12+
  timeout?: string;
  domain_resolver?: string; // sing-box 1.13+: 指定该规则使用的 DNS 解析器
  override_address?: string; // sing-box 1.13+: 在规则层强制修改目标地址
  // TLS spoof（sing-box 1.14 route action rule）：per-rule 抗审查 spoof，挂在 action:'route' 规则上。
  // tls_spoof=伪造 ClientHello 的 SNI（字符串，非空才生效），tls_spoof_method=方法（wrong-ack/wrong-md5/wrong-timestamp）。
  // 内核：tls_spoof_method 非空时 tls_spoof 必须非空（否则 FATAL）；方法非法 → `tls_spoof: unknown method`。
  tls_spoof?: string;
  tls_spoof_method?: string;
  // logical 规则（多条件跨维度 OR / AND）：type:'logical' + mode + rules(纯 matcher 子规则，无 action/outbound)
  type?: string;
  mode?: string;
  rules?: SingBoxRouteRule[];
}

export interface SingBoxRuleSet {
  tag: string;
  type: string;
  format: string;
  path?: string;
  url?: string;
  download_detour?: string;
  // remote rule_set 更新周期；不填 sing-box 用隐式默认，显式设定避免长期不更新 / 频繁拉取
  update_interval?: string;
}

export interface SingBoxRouteConfig {
  rule_set?: SingBoxRuleSet[];
  rules: SingBoxRouteRule[];
  default_domain_resolver?: string;
  auto_detect_interface?: boolean;
  final?: string;
}

export interface SingBoxExperimental {
  cache_file?: {
    enabled: boolean;
    path: string;
    store_fakeip?: boolean;
    store_dns?: boolean; // sing-box 1.14：取代 1.13 的 store_rdrc（全量 DNS 缓存持久化）
  };
}

// sing-box 1.14 services[]（管理 API）：daemon.StartedService gRPC（h2c，反射）。
// Tailscale 状态订阅(SubscribeTailscaleStatus)/原生登出(TailscaleLogout) 经此（见 singbox-api-client.ts）。
export interface SingBoxApiService {
  type: 'api';
  listen: string;
  listen_port: number;
  secret?: string;
  // sing-box 1.14 官方面板（opt-in）：enabled 时于 listen_port 的 /dashboard/ serve。
  // 仅 config.singboxDashboard 开时注入 → 关闭时核绝不出网拉资源（默认不出网）。
  // path（dashboard #55）：指向**随包内置/运行时下载覆盖**目录 → 核「serving user-provided files，auto-update disabled」，
  //   零联网下载、打开即时、离线可用（实证 1.14-alpha.32：dashboard:{enabled,path} → /dashboard/ HTTP 200 本地 serve）。
  //   省略 path 时核回落联网下载（异常打包/无内置时的兜底）。external_ui 等字段属 experimental.clash_api，非本 service。
  dashboard?: { enabled: boolean; path?: string };
}

export interface SingBoxConfig {
  log: SingBoxLogConfig;
  dns?: SingBoxDnsConfig;
  inbounds: SingBoxInbound[];
  outbounds: SingBoxOutbound[];
  endpoints?: SingBoxEndpoint[];
  route?: SingBoxRouteConfig;
  experimental?: SingBoxExperimental;
  // sing-box 1.14 管理 API（仅 1.14 核注入）。clash_api 已彻底移除，管理面统一走此 gRPC service。
  services?: SingBoxApiService[];
}
