import type { LogLevel, ServerConfig } from '../types';

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
  CRONET_LIB_MISSING = 'CRONET_LIB_MISSING', // 'cronet: library not found' / dlopen 失败（naive 出站缺/坏 libcronet → 整核 FATAL，自愈冷路径触发）
  TUN_INIT_PERSISTENT = 'TUN_INIT_PERSISTENT', // issue #324：Windows wintun 适配器持续未建立（起核重试预算耗尽且全程未见适配器）→ 终态可操作诊断，非「正在自动重试」
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

/** 连接快照：连接信息页订阅 'detail' topic（batch3 §3.7）——订阅即回初始帧 + worker 每帧 push，仅页面打开且可见时传（无订阅者 → worker 逐级停机），非旧「每秒全量广播给所有窗口」。 */
export interface ConnectionsSnapshot {
  connections: ConnectionEntry[];
  at: number; // 采样时刻 epoch ms
}

/** 拓扑「其它」分组的 sentinel host 名（聚合 Top-N 截断后剩余的合并条目）。渲染端 topology-layout 见此值 →
 *  替换为 i18n 文案 t('home.others')。用控制字符前缀确保绝不与真实 host/IP/rule 名冲突。 */
export const TOPOLOGY_OTHERS_KEY = '\u0000others';

/** 某目标（host）→ 单个出口的连接数分布项。 */
export interface ConnectionAggFlow {
  outbound: string;
  count: number;
}

/** 按目标聚合的一组连接：host/destIP/rule 显示名 → 连接数 + 各出口分布（topology 中列节点）。 */
export interface ConnectionAggHost {
  name: string;
  count: number;
  flows: ConnectionAggFlow[];
}

/** 按出口聚合的连接数（topology 右列节点）。 */
export interface ConnectionAggOutbound {
  name: string;
  count: number;
}

/**
 * 连接聚合快照（首页拓扑专用）：StatsWorkerHost 每帧 O(N) 聚合后经 EVENT_CONNECTIONS_AGGREGATE 广播，载荷与连接
 * 总数解耦（恒 ~Top-N host + 出口数）。取代「每秒全量 ConnectionEntry[] relay」——连接风暴下渲染端不再被全量明细
 * 序列化 + 每秒 O(N) 重算拖死（issue #227）。hosts 已按 count 降序、截断 Top-N（剩余并入 TOPOLOGY_OTHERS_KEY）。
 */
export interface ConnectionsAggregate {
  total: number; // 活跃连接总数
  hosts: ConnectionAggHost[];
  outbounds: ConnectionAggOutbound[];
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

export interface SystemProxyStatus {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  bypassList?: string[];
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  stack?: string;
}

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

/** TS 出口 API 直判无效、不探测的终态原因（非空=未选出口设备 / exit peer 离线 / exit peer 在线但未广告出口）。 */
export type ProxyExitBlock =
  | 'ts-no-exit-device'
  | 'ts-exit-device-offline'
  | 'ts-exit-not-advertised';

export interface IpInfoSnapshot {
  /** 本地直连出口（auto_detect_interface 物理网卡），代理未连时也可测。 */
  direct: IpInfo | null;
  /** 代理出口（当前选中节点），代理未连时为 null。 */
  proxy: IpInfo | null;
  updatedAt: number;
  loading?: boolean;
  error?: string;
  /** TS API 直判出口无效、不探测的终态；非空=选中 TS 出口未广告 / exit peer 离线。状态栏据此显「出口无效」，
   *  真探测发生（proxy 探到值或走真链探测）即清空——与 error（探测失败）互斥语义：blocked=没探（已知无效）。 */
  proxyBlocked?: ProxyExitBlock;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface AutoStartStatus {
  enabled: boolean;
  path?: string;
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  isAdmin: boolean;
}
