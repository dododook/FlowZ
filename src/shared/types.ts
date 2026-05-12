/**
 * 共享类型定义
 * 用于主进程和渲染进程之间的数据传输
 */

// ============================================================================
// 基础类型
// ============================================================================

export type ProxyMode = 'global' | 'smart' | 'direct';
export type ProxyModeType = 'systemProxy' | 'tun' | 'manual';
export type Protocol =
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'shadowsocks'
  | 'anytls'
  | 'tuic'
  | 'vmess'
  | 'naive'
  | 'socks'
  | 'http';
export type Network = 'tcp' | 'ws' | 'grpc' | 'http';
export type Hysteria2Network = 'tcp' | 'udp';
export type Security = 'none' | 'tls' | 'reality';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type RuleAction = 'proxy' | 'direct' | 'block';
export type TunStack = 'system' | 'gvisor' | 'mixed';

// ============================================================================
// 服务器配置
// ============================================================================

export interface TlsSettings {
  serverName?: string;
  allowInsecure?: boolean;
  alpn?: string[];
  fingerprint?: string;
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

// Hysteria2 混淆设置
export interface Hysteria2ObfsSettings {
  type?: 'salamander';
  password?: string;
}

// Hysteria2 协议设置
export interface Hysteria2Settings {
  upMbps?: number;
  downMbps?: number;
  obfs?: Hysteria2ObfsSettings;
  network?: Hysteria2Network;
}

// TUIC 协议设置
export interface TuicSettings {
  congestionControl?: 'bbr' | 'cubic' | 'new_reno';
  udpRelayMode?: 'native' | 'quic';
  zeroRttHandshake?: boolean;
  heartbeat?: string;
}

// Shadowsocks 协议设置
export interface ShadowsocksSettings {
  method: string;
  password: string;
  plugin?: string;
  pluginOptions?: string;
}

// AnyTLS 协议设置
export interface AnyTlsSettings {
  idleSessionCheckInterval?: string; // e.g. '30s'
  idleSessionTimeout?: string; // e.g. '30s'
  minIdleSession?: number; // default 0
}

// Shadow-TLS 插件设置（套在 SS/其他协议外层，版本固定 v3）
export interface ShadowTlsSettings {
  password: string; // Shadow-TLS v3 密码
  sni: string; // 伪装的目标域名
  fingerprint?: string; // uTLS 指纹，默认 chrome
  port?: number; // Shadow-TLS 监听/转发的真实端口 (可选)
}

// ============================================================================
// 订阅配置
// ============================================================================

export interface SubscriptionConfig {
  id: string;
  name: string;
  url: string;
  autoUpdate: boolean;
  lastUpdated?: string;
  createdAt: string;
  // 订阅流量/到期信息（从 Subscription-UserInfo header 解析）
  userInfo?: {
    upload?: number; // 已上传字节
    download?: number; // 已下载字节
    total?: number; // 总流量字节
    expire?: number; // 到期时间（Unix timestamp）
  };
}

export interface ServerConfig {
  id: string;
  name: string;
  protocol: Protocol;
  address: string;
  port: number;

  // 代理链（前置代理）ID
  detour?: string;

  // 关联的订阅ID
  subscriptionId?: string;

  // VLESS 特定
  uuid?: string;
  encryption?: string;
  flow?: string;

  // Trojan 和 Hysteria2 通用
  password?: string;

  // Naive 特定
  username?: string;

  // VMess 特定
  alterId?: number;
  vmessSecurity?: string;

  // Hysteria2 特定
  hysteria2Settings?: Hysteria2Settings;

  // TUIC 特定
  tuicSettings?: TuicSettings;

  // AnyTLS 特定
  anyTlsSettings?: AnyTlsSettings;

  // Shadowsocks 特定
  shadowsocksSettings?: ShadowsocksSettings;

  // Shadow-TLS 插件（可附加在任意协议上，常用于 SS2022）
  shadowTlsSettings?: ShadowTlsSettings;

  // 传输层配置
  network?: Network;
  security?: Security;

  // TLS 配置
  tlsSettings?: TlsSettings;

  // Reality 配置
  realitySettings?: RealitySettings;

  // 传输层特定配置
  wsSettings?: WebSocketSettings;
  grpcSettings?: GrpcSettings;
  httpSettings?: HttpSettings;

  // 元数据
  createdAt?: string;
  updatedAt?: string;
}

// ============================================================================
// 路由规则
// ============================================================================

export interface DomainRule {
  id: string;
  domains: string[];
  ipCidr?: string[]; // IP CIDR 规则
  action: RuleAction;
  enabled: boolean;
  /** 绕过 FakeIP，使用真实 DNS 解析（解决 QUIC 等协议兼容性问题） */
  bypassFakeIP?: boolean;
  /** 目标代理服务器 ID (仅当 action === 'proxy' 时有效) */
  targetServerId?: string;
  /** 规则备注说明 */
  remarks?: string;
}

// ============================================================================
// TUN 模式配置
// ============================================================================

export interface TunModeConfig {
  mtu: number;
  stack: TunStack;
  autoRoute: boolean;
  strictRoute: boolean;
  interfaceName?: string;
  inet4Address?: string;
  inet6Address?: string;
}

// DNS 配置
export interface DnsConfig {
  domesticDns: string; // 国内 DNS，默认 https://doh.pub/dns-query
  foreignDns: string; // 海外 DNS，默认 https://dns.google/dns-query
  enableFakeIp: boolean; // 是否启用 FakeIP（TUN 模式）
  /** 使用系统解析（含 hosts）的域名，每行一条。支持完整域名、*.example.com 后缀通配、.example.com */
  localDevDomains?: string[];
}

// 自定义规则集（从 URL 导入）
export interface CustomRuleSet {
  id: string;
  name: string;
  url: string; // 规则集 URL（.srs 或 .json）
  action: 'proxy' | 'direct' | 'block';
  enabled: boolean;
  addedAt: string;
}

// 应用分流规则（实验性）- 映射到内置 geosite 规则集
export interface AppRule {
  /** 应用 ID，对应 APP_PRESETS 中的 id 或 customAppPresets 中的 id */
  appId: string;
  /** 流量策略 */
  action: RuleAction;
  /** 是否启用 */
  enabled: boolean;
  /** 目标代理服务器 ID (仅当 action === 'proxy' 时有效) */
  targetServerId?: string;
}

/** 自定义应用分流预设（用户手动添加） */
export interface CustomAppPreset {
  id: string;
  name: string;
  emoji: string;
  /** 图标 URL（Qure Color 等彩色图标集的应用图标） */
  iconUrl?: string;
  geositeTags: string[];
  geoipTags?: string[];
}

// ============================================================================
// 用户配置
// ============================================================================

export interface UserConfig {
  // 订阅配置
  subscriptions?: SubscriptionConfig[];

  // 服务器配置
  servers: ServerConfig[];
  selectedServerId: string | null;

  // 代理模式
  proxyMode: ProxyMode;
  proxyModeType: ProxyModeType;

  // TUN 模式配置
  tunConfig: TunModeConfig;

  // 路由规则
  customRules: DomainRule[];

  // 应用设置
  autoStart: boolean;
  silentStart: boolean;
  autoConnect: boolean;
  minimizeToTray: boolean;
  autoCheckUpdate: boolean;
  autoLightweightMode: boolean;
  autoUpdateSubscriptionOnStart: boolean; // 启动时自动更新订阅
  rememberWindowSize?: boolean; // 记忆调整后的窗口大小
  enableIPv6?: boolean; // 启用系统全局 IPv6 解析及路由 (不建议开启)
  autoPrivacyMode?: boolean; // 自动进入隐私模式
  privacyPassword?: string; // 隐私模式解锁密码
  autoSwitchNode?: boolean; // 节点故障时自动切换到可用节点

  // 窗口尺寸（仅在 rememberWindowSize 启用时使用）
  windowBounds?: { width: number; height: number };

  // DNS 配置
  dnsConfig?: DnsConfig;

  // 自定义规则集
  customRuleSets?: CustomRuleSet[];

  // 应用分流规则（实验性）
  appRules?: AppRule[];

  // 用户自定义的应用分流预设
  customAppPresets?: CustomAppPreset[];

  // 端口配置
  socksPort: number;
  httpPort: number;
  mixedPort?: number; // 混合端口（可选，同时支持 HTTP 和 SOCKS5，0 或 undefined 表示禁用）
  allowLan?: boolean; // 局域网共享代理（允许其他设备连接）
  bypassLAN?: boolean; // 绕过局域网（将内网 IP 设置为直连）
  bypassProcesses?: string[]; // 排除进程（指定进程直连，不走代理）

  // 日志设置
  logLevel: LogLevel;

  // UI 设置
  uiTheme?: 'light' | 'dark' | 'system';
}

// ============================================================================
// 代理状态
// ============================================================================

export interface ProxyStatus {
  running: boolean;
  pid?: number;
  startTime?: Date;
  uptime?: number;
  error?: string;
  currentServer?: ServerConfig;
}

// ============================================================================
// 系统代理状态
// ============================================================================

export interface SystemProxyStatus {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  bypassList?: string[];
}

// ============================================================================
// 日志条目
// ============================================================================

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  stack?: string;
}

// ============================================================================
// 流量统计
// ============================================================================

export interface TrafficStats {
  uploadSpeed: number;
  downloadSpeed: number;
  totalUpload: number;
  totalDownload: number;
}

// ============================================================================
// API 响应
// ============================================================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// ============================================================================
// 连接状态
// ============================================================================

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export interface ConnectionStateInfo {
  state: ConnectionState;
  message?: string;
  error?: string;
}

// ============================================================================
// 自启动状态
// ============================================================================

export interface AutoStartStatus {
  enabled: boolean;
  path?: string;
}

// ============================================================================
// 平台信息
// ============================================================================

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  isAdmin: boolean;
}
