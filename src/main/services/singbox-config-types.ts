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
  server: string;
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
  strict_route?: boolean;
  stack?: string;
  sniff?: boolean;
  sniff_override_destination?: boolean; // Keep for interface compatibility if needed by types, but won't be used for 1.13+
  route_exclude_address?: string[];
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
  };
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
  process_name?: string | string[];
  process_path?: string | string[];
  process_name_not?: string | string[]; // sing-box 1.13+
  inbound?: string | string[]; // sing-box 1.13+
  action?: string; // logical 子规则为纯 matcher 无 action；default/logical 外层显式设 'route'
  outbound?: string;
  sniffer?: string[];
  rewrite_target?: boolean; // sing-box 1.12+
  timeout?: string;
  domain_resolver?: string; // sing-box 1.13+: 指定该规则使用的 DNS 解析器
  override_address?: string; // sing-box 1.13+: 在规则层强制修改目标地址
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
    store_rdrc?: boolean;
  };
}

export interface SingBoxConfig {
  log: SingBoxLogConfig;
  dns?: SingBoxDnsConfig;
  inbounds: SingBoxInbound[];
  outbounds: SingBoxOutbound[];
  endpoints?: SingBoxEndpoint[];
  route?: SingBoxRouteConfig;
  experimental?: SingBoxExperimental & {
    clash_api?: {
      external_controller: string;
      external_ui?: string;
      secret?: string;
      external_ui_download_url?: string;
      external_ui_download_detour?: string;
      default_mode?: string;
      cache_file?: string;
    };
  };
}
