/**
 * 共享类型定义
 * 用于主进程和渲染进程之间的数据传输
 */

import type {
  NaiveSettings,
  Hysteria2Settings,
  TuicSettings,
  WireGuardSettings,
  TailscaleSettings,
  CustomSettings,
  AnyTlsSettings,
  MultiplexSettings,
  ShadowsocksSettings,
  SshSettings,
  ShadowTlsSettings,
  TlsSettings,
  RealitySettings,
  WebSocketSettings,
  GrpcSettings,
  HttpSettings,
} from './types/protocol-settings';

import type { Rule, CustomRuleSet, RuleResource, AppRule, CustomAppPreset } from './types/rules';

// ============================================================================
// 协议设置子类型（re-export，保持所有现有 import 路径不变）
// ============================================================================

export type {
  Hysteria2Network,
  TlsSettings,
  RealitySettings,
  WebSocketSettings,
  GrpcSettings,
  HttpSettings,
  Hysteria2ObfsSettings,
  Hysteria2Settings,
  MultiplexSettings,
  TuicSettings,
  NaiveSettings,
  ShadowsocksSettings,
  AnyTlsSettings,
  SshSettings,
  ShadowTlsSettings,
  WireGuardSettings,
  TailscaleSettings,
  CustomSettings,
} from './types/protocol-settings';

// ============================================================================
// 路由规则子类型（re-export）
// ============================================================================

export type {
  RuleAction,
  LegacyDomainRule,
  RuleType,
  RuleCondition,
  Rule,
  SystemProcessInfo,
  CustomRuleSet,
  RuleResourceFormat,
  RuleResourceCategory,
  RuleResource,
  RuleResourceCatalogItem,
  RuleResourceListItem,
  RuleResourceRef,
  RuleResourceDeleteResult,
  RuleResourceDownloadItem,
  RuleResourceDownloadResult,
  RuleResourceProgress,
  RuleResourceCatalogResult,
  AppRule,
  CustomAppPreset,
} from './types/rules';

// ============================================================================
// 运行时状态子类型（re-export）
// ============================================================================

export type {
  ProxyStatus,
  ProxyErrorEvent,
  InvalidNodeInfo,
  ConnectionEntry,
  ConnectionsSnapshot,
  HelperStatus,
  SystemProxyStatus,
  LogEntry,
  TrafficStats,
  IpInfo,
  IpInfoSnapshot,
  ApiResponse,
  AutoStartStatus,
  PlatformInfo,
} from './types/runtime';

export { ProxyErrorCode, isProxyErrorCode } from './types/runtime';

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
  | 'http'
  | 'ssh'
  | 'wireguard'
  | 'tailscale'
  | 'custom';
export type Network = 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade';
export type Security = 'none' | 'tls' | 'reality';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type TunStack = 'system' | 'gvisor' | 'mixed';

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
  // 拉取订阅时的 User-Agent 覆盖（per-sub）。优先级：subscription.userAgent ?? config.subscriptionUserAgent ?? 默认。
  // 默认 `FlowZ/<版本>`（纯中性）。订阅对话框「自定义 User-Agent」输入框可设置本字段。
  userAgent?: string;
  // 订阅流量/到期信息（从 Subscription-UserInfo header 解析）
  userInfo?: {
    upload?: number; // 已上传字节
    download?: number; // 已下载字节
    total?: number; // 总流量字节
    expire?: number; // 到期时间（Unix timestamp）
  };
}

// ============================================================================
// 服务器配置
// ============================================================================

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

  // M1：节点归属的 Clash proxy-provider 名（仅经 proxy-providers 解析的节点有值；内联 proxies / 非 Clash
  // 订阅 / 迁移前存量为 undefined）。用于订阅 partial 失败时按 provider 精确 merge-only——只保留失败 provider
  // 名下的下架节点，成功 provider 的真下架正常删除。
  providerName?: string;

  // VLESS 特定
  uuid?: string;
  encryption?: string;
  flow?: string;

  // vless/vmess UDP 封装，默认 xudp，可设 '' 或 'packetaddr' 等
  packetEncoding?: string;

  // Trojan 和 Hysteria2 通用
  password?: string;

  // Naive 特定
  username?: string;
  naiveSettings?: NaiveSettings;

  // VMess 特定
  alterId?: number;
  vmessSecurity?: string;

  // Hysteria2 特定
  hysteria2Settings?: Hysteria2Settings;

  // TUIC 特定
  tuicSettings?: TuicSettings;

  // WireGuard 特定（sing-box endpoint）
  wireguardSettings?: WireGuardSettings;

  // Tailscale 特定（sing-box endpoint，账号制 mesh）
  tailscaleSettings?: TailscaleSettings;

  // 自定义协议（raw-JSON 透传，第三方内核用）
  customSettings?: CustomSettings;

  // AnyTLS 特定
  anyTlsSettings?: AnyTlsSettings;

  // Multiplex 多路复用（vless/trojan/vmess/ss；reality+vision 不兼容，生成侧 guard）
  multiplexSettings?: MultiplexSettings;

  // Shadowsocks 特定
  shadowsocksSettings?: ShadowsocksSettings;

  // SSH 特定
  sshSettings?: SshSettings;

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
  // ── P6 局域网网关（sing-box 1.14 LAN 设备识别簇，仅 Linux 生效，见 shared/neighbor.ts）──
  // TUN 按 MAC 过滤进入 TUN 的设备：'include'=仅 macFilterList 内的设备进 TUN / 'exclude'=排除它们。互斥。
  // 仅 Linux + auto_route + auto_redirect 支持；非法 MAC / 非 Linux 时构建期不发射（防 FATAL）。
  macFilterMode?: 'include' | 'exclude';
  macFilterList?: string[]; // EUI-48 MAC，仅在 macFilterMode 设定时消费
  // local DNS 邻居解析：对这些后缀的单标签短名（如 nas.lan）走局域网邻居解析（主机名→IP）。
  // 每条须以 '.' 开头（构建期归一化）；仅 Linux/macOS 生效。供「局域网设备短名访问」场景。
  neighborDomains?: string[];
}

// DNS 配置
export interface DnsConfig {
  domesticDns: string; // 国内 DNS，默认 https://doh.pub/dns-query
  foreignDns: string; // 海外 DNS，默认 https://dns.google/dns-query
  enableFakeIp: boolean; // 是否启用 FakeIP（systemProxy / TUN 统一生效，纯看此开关，见 usesFakeIp）
  // FakeIP 开关统一一次性迁移标记：存量旧默认 enableFakeIp:false 多非用户意图，
  // migrateFakeIpToggle 按迁移时刻 proxyModeType 写 effective 值（TUN/manual→true、systemProxy→保留）后置 true。
  // undefined=未迁移（旧配置）；迁移幂等，置 true 后永不再改写，避免覆盖用户后续手动改的值。
  fakeIpToggleMigrated?: boolean;
  // 节点域名解析器（#57）：决定代理节点域名的 dial/rule1 解析走哪个 resolver。
  // auto（缺省）=AliDNS IP-DoH（dns-bootstrap，零行为变化）/ dnspod=DNSPod IP-DoH（dns-node，1.12.12.12）/
  // system=系统 DNS（dns-local；TUN 下 rule ctx 仍强制 IP-DoH 防递归）。旧配置无此字段 → 视为 auto。
  nodeDomainResolver?: 'auto' | 'dnspod' | 'system';
  // 节点域名解析前置（#57 resolve-ahead）：缺省/true=开（默认）。开 → start 前在主进程用并发多上游 DoH
  // 把代理节点【服务器域名】预解析为 IP 写进 outbound.server（SNI/Host 仍保留原域名），使拨号不依赖运行时
  // 单点 DNS，规避节点域名解析失败导致全断流。解析失败的域名自动回退原域名（走既有 dns-bootstrap）。
  // 关 → 不预解析、保持现状（域名 + domain_resolver 引导解析）。旧配置无此字段 → 视为开。
  resolveNodeDomainsAhead?: boolean;
  // TUN 模式强制接管系统 DNS（SystemDnsManager）：缺省/true=开（默认）。on-link 的 LAN/ISP DNS 不进 TUN →
  // hijack-dns 看不到 → 需代理的域名走系统解析得到真实/错族 IP（双栈站 ERR_CONNECTION_CLOSED / 真 v6 泄漏）。
  // 开 → TUN 启动把系统 DNS 改为可路由的 8.8.8.8 使其经 TUN 被 hijack；停止/退出/崩溃还原。
  // 关 → 不接管（dns-local 恢复用原 LAN DNS、内网域名正常，但 TUN 下有上述泄漏风险），供有自定义/内网 DNS 的用户用。
  // 仅 TUN 模式生效；旧配置无此字段 → 视为开。详见 docs/design/dns-ipv6-takeover.md。
  takeoverSystemDns?: boolean;
  // P2b 乐观 DNS 缓存（sing-box 1.14 `dns.optimistic`）：缺省/false=关。开 → 缓存过期后先返回旧值、后台异步刷新，
  // 降低尾延迟（牺牲首条过期响应的新鲜度）。映射到顶层 dns.optimistic:true（仅 true 时下发，关时省略保字节）。
  optimisticCache?: boolean;
  // P2c DNS 查询超时（sing-box 1.14 `dns.timeout`，毫秒）：缺省/未设=用核默认（不下发）。>0 时下发 dns.timeout:"<n>ms"，
  // 治理慢上游不拖整体解析。sanitize 丢弃 ≤0 / 非有限 / 超合理范围（1..60000ms）的值（见 ConfigManager.validateConfig）。
  dnsTimeoutMs?: number;
}

// ============================================================================
// 地区分流（4.1.0）：智能分流的 geo 基线场景
// ============================================================================

/** 地区 ID：选用哪套地区 geo（cn/ir/ru）。 */
export type RegionId = 'cn' | 'ir' | 'ru';
/** 地区分流配置。undefined（存量/新装未改）= 默认中国大陆正向 = 今日智能分流行为（零迁移，见 shared/region-routing）。 */
export interface RegionRoutingConfig {
  enabled: boolean; // 总开关：true=按地区自动分流(本地直连·海外代理)；false=只用自定义规则
  region: RegionId; // 选用哪套地区 geo
  reverse: boolean; // 反向：本地走代理·海外直连（region=cn+reverse=回国）
}

// ============================================================================
// 远程实例（sing-box 1.14 远程控制，P5 Phase2）
// ============================================================================

/**
 * 远程 sing-box 实例（FlowZ 当客户端连远端 ≥1.14 核的管理 API）。
 * - host/port：远端 api service 监听地址（必填）。
 * - secret：远端 api service 的鉴权 secret（Bearer per-call）。**反向可读存**——Bearer 必须发原值，无法哈希；
 *   存于 config.json（0o600，与 clashApiSecret 同保护级）。**渲染端不回读明文**：UI 仅写（保存新值），列表只显
 *   「已设置/未设置」占位，CONFIG_GET 经 sanitize 不下发明文（见 ConfigManager.sanitizeRemoteSecretsForRenderer）。
 * - tls：远端走 TLS（远程强制启用，见 dashboard-remote.md §2.4）；ca=自签 PEM CA，skipVerify=跳过校验（不安全便利档）。
 * - dashboardUrl：可选，远端 /dashboard/ 的完整 URL（openExternal 用，留空则由 host/port 推 https）。
 */
export interface RemoteInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  secret?: string;
  tls?: {
    ca?: string;
    skipVerify?: boolean;
  };
  dashboardUrl?: string;
  // 渲染端只读：CONFIG_GET 经 stripRemoteSecrets 注入「是否已设置 secret」占位（明文不下发）。永不持久化（保存前被剔除）。
  hasSecret?: boolean;
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
  customRules: Rule[];

  // 地区分流（4.1.0）：智能分流 geo 基线场景。undefined=默认中国大陆正向(=今日行为，零迁移)。
  regionRouting?: RegionRoutingConfig;

  // 应用设置
  autoStart: boolean;
  silentStart: boolean;
  autoConnect: boolean;
  minimizeToTray: boolean;
  autoCheckUpdate: boolean;
  autoLightweightMode: boolean;
  autoUpdateSubscriptionOnStart: boolean; // 订阅自动更新总开关（启动补更陈旧订阅 + 运行期周期更新）
  subscriptionUpdateIntervalHours?: number; // 订阅自动更新周期/陈旧阈值（小时），默认 12
  subscriptionUpdateViaProxy?: boolean; // 订阅更新是否经代理（默认 false=直连，避免冷启动鸡生蛋 + 订阅地址被墙时再开）
  // 全局订阅 UA（被 per-sub subscription.userAgent 覆盖；均缺省时用 `FlowZ/<版本>`）。本期无 UI，手编生效。
  subscriptionUserAgent?: string;
  // 更新检查/规则资源等主进程请求是否经代理（默认 true=代理运行时借道，更新源全 GitHub、墙内借道更可靠）。
  // false → 主进程 defaultSession 走 {mode:'system'}。注：TUN 模式 OS 层捕获，false 不能完全直连（probe-direct 深修待真机）。
  mainSessionViaProxy?: boolean;
  rememberWindowSize?: boolean; // 记忆调整后的窗口大小
  enableIPv6?: boolean; // 启用系统全局 IPv6 解析及路由 (不建议开启)
  autoPrivacyMode?: boolean; // 自动进入隐私模式
  privacyPassword?: string; // 隐私模式解锁密码
  autoSwitchNode?: boolean; // 节点故障时自动切换到可用节点
  interruptConnectionsOnSwitch?: boolean; // 切换节点时中断现有连接、强制在新节点重建（默认 false=优雅切换，现有连接保留至自然关闭）

  // 窗口尺寸（仅在 rememberWindowSize 启用时使用）
  windowBounds?: { width: number; height: number };

  // DNS 配置
  dnsConfig?: DnsConfig;

  // 自定义规则集
  customRuleSets?: CustomRuleSet[];

  // 已下载的本地规则资源（.srs）
  ruleResources?: RuleResource[];

  // GitHub 加速前缀（规范化 'https://host[:port]/'；''/undefined=直连，默认）。仅规则资源下载用。
  ghProxyPrefix?: string;

  // 已下载规则资源自动更新总开关（默认 false）。本地 .srs sing-box 不会自更新，需 FlowZ 周期重下载。
  ruleResourceAutoUpdate?: boolean;
  // 自动更新间隔（小时）：6|12|24|72|168，默认 24
  ruleResourceUpdateIntervalHours?: number;
  // 内置 geo 规则集（geosite-cn 等）最近一次网络更新时间，按 tag 索引。无记录=出厂版（视为可补更）。
  builtinGeoMeta?: Record<string, { updatedAt?: string }>;

  // 应用分流规则（实验性）
  appRules?: AppRule[];
  // 应用分流总开关；undefined=true（兼容老配置，升级不静默失效）。false → appRules 完全不进 route 生成/TUN 排除/geo 收集。
  appRoutingEnabled?: boolean;
  // 应用分流默认预设一次性注入标记：首次为内置预设注入默认「代理·跟全局」规则后置 true。
  // 防每次启动回灌（用户删掉某预设规则后不会被重新补回）。新装由 createDefaultConfig 直接置 true。
  appRulesSeeded?: boolean;

  // 用户自定义的应用分流预设
  customAppPresets?: CustomAppPreset[];

  // 端口配置
  /** @deprecated mixed-only 架构已弃用独立端口；仅旧配置兼容 + 迁移读取（见 shared/proxy-ports）。 */
  socksPort?: number;
  /** @deprecated 同上；迁移时若 mixedPort 未设则以此为 mixedPort 种子。 */
  httpPort?: number;
  // 本地混合代理端口（mixed inbound 同口 HTTP+SOCKS）。mixed-only 架构 canonical 端口，恒 >0、无开关。
  // 新装缺省 7890（DEFAULT_MIXED_PORT，对齐业内）；旧配置迁移自 httpPort。统一经 shared/proxy-ports#localProxyPort 取用。
  mixedPort?: number;
  // clash_api 外部控制端口。新装缺省 9090（DEFAULT_CONTROL_PORT，对齐业内）。可改：当 9090 被另一 clash 系应用/
  // 任意进程占用时，FlowZ 据此改 external_controller 端口，避免 clash_api 无法 bind 的死局。统一经 shared/proxy-ports#controlApiPort 取用。
  controlPort?: number;
  allowLan?: boolean; // 局域网共享代理（允许其他设备连接）
  bypassLAN?: boolean; // 绕过局域网总开关（关 → 不绕过，内网/清单内目标也走代理）
  // 绕过局域网完整清单（用户可编辑，含 CIDR + 域名）：undefined=用 DEFAULT_BYPASS_LAN（字节不变）；已编辑存全量。
  // 受 bypassLAN 开关管理。双消费：① TUN 模式 route 私网直连 + Windows TUN 排除只取其 CIDR（bypassLanCidrs，
  // mac/Linux 走 route 规则规避 NetworkExtension HANG）；② 系统代理模式整份（CIDR+域名）写入 OS 忽略列表。
  // 原 systemProxyBypass 已并入此字段（单一清单，杜绝两处重复）。
  bypassLANList?: string[];
  blockQuic?: boolean; // 阻止 QUIC（对代理向 UDP 443 执行 reject，逼浏览器回退 TCP）；默认关；节点无关，对所有协议一视同仁
  tlsFragment?: boolean; // 全局 TLS 分片：对所有 TLS 节点切分 ClientHello 抗 SNI-DPI；默认关
  // WebRTC 防泄露（仅 TUN 模式生效）：off=关；proxy=对 STUN 经协议嗅探强制走代理（srflx=代理 IP，WebRTC 正常）；
  // block=reject STUN（断 P2P、零公网 IP 泄露）。默认 undefined=off（零行为变化）。系统代理模式拦不住（浏览器 WebRTC
  // 的 UDP 不经 sing-box 核），UI 在系统代理模式置灰。
  webrtcLeakProtection?: 'off' | 'proxy' | 'block';
  // 节点测速端点 URL（经各节点代理 GET 量 TTFB）。默认 generate_204（见 shared/speed-test）；用户可自配，兼容 http/https。
  // 非法值由 SpeedTestService 经 resolveSpeedTestTarget 回落默认，不阻断测速。
  speedTestUrl?: string;
  // fake-ip-filter 默认清单（NTP/STUN/Captive 等在 FakeIP 下会坏的域名 → 真实解析）。默认开（undefined/true=开），仅 false=关。
  fakeIpFilter?: boolean;
  // FakeIP 例外域名清单（用户可编辑）：undefined=用内置默认（DEFAULT_FAKEIP_FILTER_DOMAINS，与历史字节一致）；
  // 已编辑则存全量。仅 fakeIpFilter 开时生效。内置 captive 域名仍走内网解析器，其余走 dns-domestic（见 singbox-dns-builder）。
  fakeIpFilterList?: string[];
  // 核心更新：仅在配置生成器已验证的 sing-box minor 版本带内自动更新（默认 true）。关闭后允许自动
  // 更新跨越 minor（如 1.13→1.14），但跨 minor 的 schema 变更可能导致配置不兼容、需手动处理。
  restrictCoreUpdateToCompatibleMinor?: boolean;
  // 内核自动更新总开关（默认 false；读取端 === true 判定，不进 createDefaultConfig）。开启后调度器周期检查、
  // 仅在「同 major.minor 兼容版本带内」（如 1.13.x→1.13.y）自动下载+预检+落位；跨 minor 一律不自动，仅提示。
  // 落位永远只在代理进程不存在时发生（运行中暂存 staged，延到停止/启动/用户点立即应用），绝不静默断流。
  autoUpdateCore?: boolean;
  /** @deprecated 已迁移至 customRules（processName+direct）；仅保留兼容旧配置，ConfigManager 启动时清空迁移。 */
  bypassProcesses?: string[];

  // 日志设置
  logLevel: LogLevel;
  // 关闭日志写盘（sing-box log.disabled）；默认 false=写盘。关闭后应用内无法查看实时日志/基于日志的诊断
  disableLogFile?: boolean;

  // 诊断采集（临时提级）：开启时把 logLevel 临时拉到 debug 复现问题，存档原级别供还原。
  // 存在即「采集中」（UI 据此显示采集条）。结束采集 / 下次启动 app → 还原 logLevel=prevLogLevel 后清此字段。
  // 还原到「采集前的快照级别」（可能是 error/warn），绝不硬编码 info。崩溃安全：持久在 config，loadConfig 启动还原。
  diagnosticCapture?: { prevLogLevel: LogLevel };

  // clash_api(127.0.0.1:9090) 鉴权 secret：首次启动随机生成并持久化，统一管所有 clash_api 访问(含 external_ui)。
  // 内部调用(热切换/流量统计/拓扑)带 Authorization；防恶意网页跨域读连接历史。可在设置里查看/重置。
  clashApiSecret?: string;

  // sing-box 1.14 官方面板（opt-in 逃生舱）：开关 on 时在 api service（management api）注入 dashboard.enabled，
  // 核首次联网从官方仓拉 sing-box-dashboard 资源并于 api 监听口 /dashboard/ serve。默认关（undefined=false）；
  // 不随包静态文件，关时核绝不出网拉资源。非 boolean 一律 sanitize 删除（同 appRoutingEnabled 标准，不回填默认）。
  singboxDashboard?: boolean;

  // sing-box 1.14 远程实例控制（P5 Phase2）：FlowZ 当客户端连远端核的管理 API（增删改 + 打开远端面板）。
  // secret 反向可读存于 config.json（0o600）但 CONFIG_GET 经 sanitize 不下发明文给渲染端（详见 RemoteInstance 注释）。
  // 非法/缺字段实例在 validateConfig 整条丢弃（sanitize 而非 throw，避免污染配置致 loadConfig 全丢）。
  remoteInstances?: RemoteInstance[];

  // 当前活动实例：'local'（默认，本地核）| 某条 remoteInstances.id。validateConfig 收敛非法值回落 undefined（=本地）。
  // 当前批次仅落「远程配置 + 客户端 TLS + 打开远端 dashboard」核心闭环；原生页实时镜像远端状态留 TODO（见 dashboard-remote.md §2.3）。
  activeInstanceId?: string;

  // macOS 提权 helper：用户已忽略「安装提权 helper」启动提示（不再每次启动 TUN 时弹）。可在设置里重新安装。
  // 注：socket 鉴权 token 刻意不放这里——它存独立文件，避免被渲染端整体回写 config 时清零。
  helperPromptDismissed?: boolean;

  // macOS 提权 helper：用户已忽略「后台运行被系统禁用」引导弹窗（不再提示）。设置页 helper 卡保留常驻入口。
  helperDisabledPromptDismissed?: boolean;

  // UI 设置
  uiTheme?: 'light' | 'dark' | 'system';
}
