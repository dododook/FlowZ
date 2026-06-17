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
  | 'http'
  | 'ssh'
  | 'wireguard'
  | 'tailscale'
  | 'custom';
export type Network = 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade';
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
  ech?: boolean; // Encrypted Client Hello（隐藏 SNI）；sing-box tls.ech.enabled
  echConfig?: string; // 可选 ECHConfigList(PEM)；空=sing-box 从 DNS(HTTPS RR type65) 自取，填=下发 tls.ech.config
  fragment?: boolean; // TLS ClientHello 分片，抗 SNI-DPI；sing-box tls.fragment
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
  serverPorts?: string; // 端口跳跃范围，如 "20000:30000"；sing-box server_ports
  hopInterval?: string; // 端口跳跃间隔，如 "30s"；sing-box hop_interval
}

// Multiplex 多路复用设置（vless/trojan/vmess/shadowsocks）；注意 reality+vision(xtls-rprx-vision) 不兼容
export interface MultiplexSettings {
  enabled?: boolean;
  protocol?: 'smux' | 'yamux' | 'h2mux'; // 默认 h2mux
  maxConnections?: number;
  minStreams?: number;
  padding?: boolean; // 流量填充，增强抗特征
}

// TUIC 协议设置
export interface TuicSettings {
  congestionControl?: 'bbr' | 'cubic' | 'new_reno';
  udpRelayMode?: 'native' | 'quic';
  zeroRttHandshake?: boolean;
  heartbeat?: string;
}

// Naive 协议设置
export interface NaiveSettings {
  useHttp3?: boolean; // 使用 HTTP/3 (QUIC) 传输；sing-box naive outbound 的 quic 字段
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

// SSH 协议设置
export interface SshSettings {
  user?: string; // SSH 用户名，默认 root
  password?: string; // 密码认证
  privateKey?: string; // 内联私钥内容
  privateKeyPath?: string; // 私钥文件路径，如 $HOME/.ssh/id_rsa
  privateKeyPassphrase?: string; // 私钥密码
  hostKey?: string[]; // 主机公钥（留空接受所有）
  hostKeyAlgorithms?: string[]; // 主机密钥算法
  clientVersion?: string; // 客户端版本字符串
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

/**
 * WireGuard endpoint 设置（sing-box 1.11+ endpoint；默认 gVisor 用户态栈、零额外提权）。
 * 单 peer 模型：peer 的 endpoint 用 ServerConfig.address/port 承载（与其他协议一致），其余 peer 参数在此。
 */
export interface WireGuardSettings {
  privateKey: string; // 本地私钥（base64）
  localAddress: string[]; // 本地隧道地址（wg-quick [Interface].Address），如 ['10.0.0.2/32','fd00::2/128']
  peerPublicKey: string; // 对端公钥（base64）
  preSharedKey?: string; // 可选预共享密钥（base64）
  allowedIPs?: string[]; // 缺省 ['0.0.0.0/0','::/0']
  persistentKeepalive?: number; // 保活间隔（秒）
  reserved?: number[]; // 3 字节 reserved（Cloudflare WARP 等需要）
  mtu?: number; // 缺省 1408
}

// Tailscale（sing-box endpoint，账号制 mesh，无 server address/port——连控制面）。Phase 1 userspace。
export interface TailscaleSettings {
  authKey?: string; // pre-auth key（可选；无则核日志出 `Waiting for authentication: <url>` 交互登录）
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
}

// 自定义协议（raw-JSON 透传）：用户直接填一份 sing-box outbound/endpoint JSON，FlowZ 不解析语义、只注入 tag。
// 供第三方内核协议（如 snell）使用——「内核即权威」：能否启用由 sing-box check probe / 启动 gate 判定，FlowZ 不维护
// type 白名单。address/port 由 JSON 内部携带，不用 ServerConfig.address/port。
export interface CustomSettings {
  outbound: Record<string, unknown>; // 用户填的 outbound/endpoint 对象（须含字符串 type）；tag 由 FlowZ 生成期强制覆盖
  isEndpoint?: boolean; // 该 type 属 sing-box endpoints[]（如类 wireguard/tailscale 的第三方实现）而非 outbounds[]
  secretKeys?: string[]; // 该 JSON 里属密钥的键名（诊断报告脱敏用：redactDeep 据此叠加打码）。无值层启发式，未声明则仅靠通用密钥黑名单兜底（psk/password/uuid 等），建议填全自定义密钥键
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
// 路由规则
// ============================================================================

/**
 * 旧版自定义规则结构（仅域名 + ipCidr）。保留供迁移读取旧配置/旧备份用，新代码一律用 {@link Rule}。
 * @deprecated 用 Rule
 */
export interface LegacyDomainRule {
  id: string;
  domains: string[];
  ipCidr?: string[]; // IP CIDR 规则
  action: RuleAction;
  enabled: boolean;
  bypassFakeIP?: boolean;
  targetServerId?: string;
  remarks?: string;
}

/**
 * 自定义规则类型（对应 sing-box route rule 常用全集，去冗余）。
 * 域名类：domain/domainSuffix/domainKeyword/domainRegex；
 * IP/端口类：ipCidr(目的)/sourceIpCidr(源)/port(目的)/sourcePort(源)；
 * 进程类：processName/processPath；规则集类：geosite/geoip/ruleSet。
 */
export type RuleType =
  | 'domain'
  | 'domainSuffix'
  | 'domainKeyword'
  | 'domainRegex'
  | 'ipCidr'
  | 'sourceIpCidr'
  | 'port'
  | 'sourcePort'
  | 'processName'
  | 'processPath'
  | 'geosite'
  | 'geoip'
  | 'ruleSet';

/**
 * 自定义路由规则（一条规则 = 单一 type + values 数组）。统一 values 为字符串数组：域名/CIDR/
 * 端口("443"或"1000-2000")/进程名/路径/geo 标签/规则集(URL 或 res:<resourceId>)，一项一条。
 */
/** 单个匹配条件（type + values）。多条件规则用 conditions 数组承载。 */
export interface RuleCondition {
  type: RuleType;
  values: string[];
}

export interface Rule {
  id: string;
  type: RuleType; // 首条件镜像（向后兼容旧消费点 + 回滚安全；恒与 conditions[0] 一致）
  values: string[]; // 首条件镜像
  /** 多条件共存（≥2 条件时存在；首条件镜像到 type/values）。空/缺省 = 单条件规则。 */
  conditions?: RuleCondition[];
  /** 多条件组合：'or'(默认，命中任一) / 'and'(全部命中)。单条件时无意义。 */
  combineMode?: 'and' | 'or';
  action: RuleAction;
  enabled: boolean;
  /** 绕过 FakeIP（仅 domain/domainSuffix/domainKeyword 有效） */
  bypassFakeIP?: boolean;
  /** 目标代理服务器 ID（仅当 action === 'proxy' 时有效） */
  targetServerId?: string;
  /** 规则备注说明 */
  remarks?: string;
}

/** 系统进程信息（进程快速选择器用）。 */
export interface SystemProcessInfo {
  name: string;
  path?: string;
  count: number;
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
  enableFakeIp: boolean; // 是否启用 FakeIP（systemProxy / TUN 统一生效，纯看此开关，见 usesFakeIp）
  // FakeIP 开关统一一次性迁移标记：存量旧默认 enableFakeIp:false 多非用户意图，
  // migrateFakeIpToggle 按迁移时刻 proxyModeType 写 effective 值（TUN/manual→true、systemProxy→保留）后置 true。
  // undefined=未迁移（旧配置）；迁移幂等，置 true 后永不再改写，避免覆盖用户后续手动改的值。
  fakeIpToggleMigrated?: boolean;
  // 节点域名解析器（#57）：决定代理节点域名的 dial/rule1 解析走哪个 resolver。
  // auto（缺省）=AliDNS IP-DoH（dns-bootstrap，零行为变化）/ dnspod=DNSPod IP-DoH（dns-node，1.12.12.12）/
  // system=系统 DNS（dns-local；TUN 下 rule ctx 仍强制 IP-DoH 防递归）。旧配置无此字段 → 视为 auto。
  nodeDomainResolver?: 'auto' | 'dnspod' | 'system';
  // TUN 模式强制接管系统 DNS（SystemDnsManager）：缺省/true=开（默认）。on-link 的 LAN/ISP DNS 不进 TUN →
  // hijack-dns 看不到 → 需代理的域名走系统解析得到真实/错族 IP（双栈站 ERR_CONNECTION_CLOSED / 真 v6 泄漏）。
  // 开 → TUN 启动把系统 DNS 改为可路由的 8.8.8.8 使其经 TUN 被 hijack；停止/退出/崩溃还原。
  // 关 → 不接管（dns-local 恢复用原 LAN DNS、内网域名正常，但 TUN 下有上述泄漏风险），供有自定义/内网 DNS 的用户用。
  // 仅 TUN 模式生效；旧配置无此字段 → 视为开。详见 docs/design/dns-ipv6-takeover.md。
  takeoverSystemDns?: boolean;
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

// ============================================================================
// 规则资源（已下载到本地的 sing-box .srs 规则集）
// ============================================================================

export type RuleResourceFormat = 'binary' | 'source'; // .srs→binary（下载恒此），.json→source（仅保留扩展位）
export type RuleResourceCategory = 'geosite' | 'geoip' | 'geosite-lite' | 'geoip-lite' | 'custom';

/** 已下载到本地的规则资源（文件落 <userData>/rule-resources/，本清单存 config.json）。 */
export interface RuleResource {
  id: string; // 内置=catalog id（'geosite-youtube'）；手动='res_<ts>_<rand>'
  name: string;
  category: RuleResourceCategory;
  sourceUrl: string; // 原始 URL（不含加速前缀，更新时现拼）
  fileName: string; // 落盘名，含分类前缀防撞，如 'geosite-youtube.srs'
  format: RuleResourceFormat;
  size: number; // 字节
  downloadedAt: string; // ISO
}

/** 内置/动态资源库条目（catalog）。 */
export interface RuleResourceCatalogItem {
  id: string;
  category: RuleResourceCategory;
  name: string;
  path: string; // meta-rules-dat 仓库内路径，如 'geo/geosite/youtube.srs'
}

/** 列表项：本地资源 + 文件是否存在 + 被启用 ruleSet 规则引用计数。 */
export interface RuleResourceListItem extends RuleResource {
  fileExists: boolean;
  referencedBy: number;
  /** 内置 geo 规则集（智能分流固定依赖）：不可删除、更新写回 <userData>/rules 热重载、可重置为出厂。id 形如 'builtin:geosite-cn'。 */
  builtin?: boolean;
}

/**
 * 规则资源引用记录（单一真值，见 shared/rule-resource-refs.ts）。
 * kind 区分来源：'route'=自定义路由规则 / 'app'=应用分流卡片。
 * label：route=已就绪文案（备注/首条件摘要）；app=内置 labelKey(i18n key) 或自定义 name（由 appBuiltin 决定渲染端是否 i18n）。
 */
export interface RuleResourceRef {
  kind: 'route' | 'app';
  id: string;
  label: string;
  appBuiltin?: boolean;
}

/** 删除资源结果：被启用规则引用且未 force 时不删，回传 needConfirm + 引用规则明细（供前端分组展开确认列出）。 */
export interface RuleResourceDeleteResult {
  ok: boolean;
  needConfirm?: boolean;
  referencingRules?: RuleResourceRef[];
}

/** 下载入参：catalogId（内置/动态项）或 url（手动，name 可选自动生成）。id/category 仅 redownload 内部用于保留原 id。 */
export interface RuleResourceDownloadItem {
  catalogId?: string;
  url?: string;
  name?: string;
  id?: string;
  category?: RuleResourceCategory;
}

export interface RuleResourceDownloadResult {
  ok: boolean;
  resource?: RuleResource;
  error?: string;
  errorCode?: string;
  id?: string;
  name?: string;
  /** 下载前目标文件是否已存在：用于收窄重启判定（已存在=内容更新，sing-box ≥1.10 热重载，无需重启）。 */
  existedBefore?: boolean;
}

export interface RuleResourceProgress {
  id: string;
  name: string;
  received: number;
  total: number | null;
  percent: number | null;
  status: 'queued' | 'downloading' | 'done' | 'error';
  error?: string;
  errorCode?: string;
}

export interface RuleResourceCatalogResult {
  items: RuleResourceCatalogItem[];
  fetchedAt: number | null;
  source: 'remote' | 'cache' | 'builtin';
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
  customRules: Rule[];

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
  bypassLAN?: boolean; // 绕过局域网（将内网 IP 设置为直连）
  // 系统代理「忽略代理列表」(OS proxy 例外)。仅系统代理模式生效（TUN 直连走 sing-box route）。
  // 缺省/空 → 取 shared/system-proxy-bypass#DEFAULT_SYSTEM_PROXY_BYPASS（业内聚合清单）；用户可在设置里逗号分隔编辑。
  // mac networksetup 原样下发 CIDR+域名；win 转通配；linux gsettings ignore-hosts。详见 shared/system-proxy-bypass。
  systemProxyBypass?: string[];
  blockQuic?: boolean; // 阻止 QUIC（对代理向 UDP 443 执行 reject，逼浏览器回退 TCP）；默认关；节点无关，对所有协议一视同仁
  tlsFragment?: boolean; // 全局 TLS 分片：对所有 TLS 节点切分 ClientHello 抗 SNI-DPI；默认关
  // 节点测速端点 URL（经各节点代理 GET 量 TTFB）。默认 generate_204（见 shared/speed-test）；用户可自配，兼容 http/https。
  // 非法值由 SpeedTestService 经 resolveSpeedTestTarget 回落默认，不阻断测速。
  speedTestUrl?: string;
  // fake-ip-filter 默认清单（NTP/STUN/Captive 等在 FakeIP 下会坏的域名 → 真实解析）。默认开（undefined/true=开），仅 false=关。
  fakeIpFilter?: boolean;
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

  // macOS 提权 helper：用户已忽略「安装提权 helper」启动提示（不再每次启动 TUN 时弹）。可在设置里重新安装。
  // 注：socket 鉴权 token 刻意不放这里——它存独立文件，避免被渲染端整体回写 config 时清零。
  helperPromptDismissed?: boolean;

  // macOS 提权 helper：用户已忽略「后台运行被系统禁用」引导弹窗（不再提示）。设置页 helper 卡保留常驻入口。
  helperDisabledPromptDismissed?: boolean;

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
  errorCode?: ProxyErrorCode;
  currentServer?: ServerConfig;
}

// ============================================================================
// 代理错误码协议（跨进程错误分类的唯一依据；message 仅供展示/日志，禁止用于分类）
// 成员从 ProxyManager 现有 includes()/退出码检测逐条反推，string enum 保证 wire 稳定可 grep。
// ============================================================================

export enum ProxyErrorCode {
  // 连接类 → ErrorCategory.Connection
  DEST_CONNECTION_REFUSED = 'DEST_CONNECTION_REFUSED', // 'report handshake success: connection refused'
  CONNECTION_REFUSED = 'CONNECTION_REFUSED', // 'connection refused'
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT', // 'timeout'|'timed out'
  DNS_RESOLVE_FAILED = 'DNS_RESOLVE_FAILED', // 'dns'+'fail'
  TLS_CERT_ERROR = 'TLS_CERT_ERROR', // 'certificate'|'tls'|'ssl'（排除 anytls/shadowtls）
  AUTH_FAILED = 'AUTH_FAILED', // 'authentication failed'|'auth fail'
  // 配置类 → ErrorCategory.Config
  CONFIG_INVALID = 'CONFIG_INVALID', // 'invalid config'|'config error'、退出码 2
  PORT_IN_USE = 'PORT_IN_USE', // 'address already in use'
  CLASH_API_PORT_RECYCLING = 'CLASH_API_PORT_RECYCLING', // 9090 处于 TIME_WAIT 回收中（瞬态，自动等待，非终态）
  // 权限/环境类 → ErrorCategory.System
  PERMISSION_DENIED = 'PERMISSION_DENIED', // 'permission denied'|'access denied'
  SYSTEM_PROXY_FAILED = 'SYSTEM_PROXY_FAILED', // 核心已起但系统代理 networksetup/reg 设置失败（非终态提示）
  BINARY_NOT_EXECUTABLE = 'BINARY_NOT_EXECUTABLE', // 退出码 126
  BINARY_NOT_FOUND = 'BINARY_NOT_FOUND', // 退出码 127
  // 进程生命周期类 → ErrorCategory.Process
  STARTUP_FAILED = 'STARTUP_FAILED', // 退出码 1
  PROCESS_KILLED = 'PROCESS_KILLED', // 退出码 137
  PROCESS_EXITED = 'PROCESS_EXITED', // 其它异常退出
  AUTO_RESTARTING = 'AUTO_RESTARTING', // 自动重启中（瞬态）
  AUTO_RESTART_FAILED = 'AUTO_RESTART_FAILED', // 自动重启失败达上限
  RESTART_LIMIT_REACHED = 'RESTART_LIMIT_REACHED', // 健康检查发现死亡且重启耗尽
  STOP_AUTH_CANCELLED = 'STOP_AUTH_CANCELLED', // 停止时用户取消提权授权、进程仍在运行（非终态）
  CORE_UPDATE_IN_PROGRESS = 'CORE_UPDATE_IN_PROGRESS', // 内核二进制替换窗口中，手动 start/restart/switchMode 被拒（瞬态，非终态）
  UNKNOWN = 'UNKNOWN',
}

/** 渲染端信任前的运行时校验（防 errno 串等任意 .code 混入误判）。 */
export function isProxyErrorCode(v: unknown): v is ProxyErrorCode {
  return typeof v === 'string' && (Object.values(ProxyErrorCode) as string[]).includes(v);
}

/** EVENT_PROXY_ERROR 统一 payload。新增字段全 optional → 旧渲染端零破坏。 */
export interface ProxyErrorEvent {
  message: string; // 【兼容】已合成的展示串，旧渲染端继续可用
  errorCode?: ProxyErrorCode; // 【新增】结构化分类，渲染端优先消费
  errorParams?: Record<string, string | number>; // 【新增】i18n 插值参数
  code?: number; // 【兼容】进程退出码语义
  signal?: string | null; // 【兼容】
  error?: string; // 【兼容·deprecated】原始 raw
}

/**
 * 启动前配置校验 gate 剔除的非法节点（坏节点拖垮 sing-box 整体启动 FATAL → 启动前 check 剔除）。
 * 仅会话内存语义：每次启动重判，换核自动复活；reason 区分「直接被 check 标中」/「detour 级联剔除」。
 * 经 EVENT_PROXY_INVALID_NODES 推送渲染端，节点列表据此标灰 + tooltip（不禁用点击）。
 */
export interface InvalidNodeInfo {
  id: string;
  tag: string;
  reason: string;
}

// ============================================================================
// 连接快照（topology 统一供数：main 1s 轮询 clash_api /connections 留存裁剪后推送）
// ============================================================================

/**
 * clash /connections 单条连接（main 裁剪后子集）。
 * topology 只用 id/chains/rule/rulePayload/metadata{host,destinationIP}；连接信息页额外用扩展字段
 * （network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start）算速率/源/进程/时长。
 * 扩展字段全 optional → 向后兼容 topology（拿到更多字段但只读原有的）；含 sourceIP/processPath 隐私字段，
 * 故连接信息页须在隐私模式下屏蔽明细（见 connections-page）。
 */
export interface ConnectionEntry {
  id: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  metadata?: {
    host?: string;
    destinationIP?: string;
    network?: string; // tcp/udp
    type?: string; // 入站类型（如 Tun/HTTP/Socks）
    sourceIP?: string;
    sourcePort?: string;
    destinationPort?: string;
    processPath?: string; // 发起连接的进程路径（隐私字段）
  };
  upload?: number; // 累计上行字节
  download?: number; // 累计下行字节
  start?: string; // 连接建立时刻（RFC3339）
}

/** 连接快照：经 EVENT_CONNECTIONS_UPDATED 推送 / CONNECTIONS_GET 回填。 */
export interface ConnectionsSnapshot {
  connections: ConnectionEntry[];
  at: number; // 采样时刻 epoch ms
}

// ============================================================================
// macOS 提权 helper 状态
// ============================================================================

export interface HelperStatus {
  /** 当前平台是否支持（仅 macOS） */
  supported: boolean;
  /** helper 二进制 + LaunchDaemon plist 是否在位 */
  installed: boolean;
  /** socket ping 成功且协议版本 ≥ 最低可用（可零提权驱动 TUN） */
  ready: boolean;
  /** 可用但有新版 helper（v5 install-core）：proto ≥ 最低可用但 < 期望 → 温和提示可升级（非故障，不强制重装） */
  upgradeable: boolean;
  /** 协议版本（ping/version 返回），未就绪为 null */
  version: string | null;
  /** daemon 是否被 launchd 加载（launchctl print 退出码）；非 macOS / 未安装为 null */
  loaded: boolean | null;
  /** 已安装但无法就绪、协议版本不符、或烧录路径与当前 app 不符 → 建议重装修复 */
  needsRepair: boolean;
  /** macOS「系统设置→登录项→允许在后台」被关。判定链：SMAppService.statusForLegacyURL(=2) → BTM disposition 直读
   *  → launchctl 去抖启发式（BTM .btm 目录受 TCC 完全磁盘访问保护、生产 GUI 读不到，故 SMAppService 为权威首通道）。
   *  可与 ready=true 并存（install-over-top 混合态）。消费方契约：先判 backgroundDisabled 再判 needsRepair/pathMismatch。 */
  backgroundDisabled: boolean;
  /** 仅 macOS 打包版：plist 烧录的 sing-box 路径 ≠ 当前 app 路径（app 被移动过） */
  pathMismatch: boolean;
  /** plist 中烧录的 sing-box 路径（诊断展示用；未装/解析失败为 null） */
  installedSingboxPath: string | null;
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
  activeConnections?: number;
}

// ============================================================================
// 出口 IP 信息（本地直连出口 / 代理出口）
// ============================================================================

export interface IpInfo {
  ip: string;
  country?: string;
  countryCode?: string;
}

export interface IpInfoSnapshot {
  /** 本地直连出口（auto_detect_interface 物理网卡），代理未连时也可测。 */
  direct: IpInfo | null;
  /** 代理出口（当前选中节点），代理未连时为 null。 */
  proxy: IpInfo | null;
  updatedAt: number;
  loading?: boolean;
  error?: string;
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
