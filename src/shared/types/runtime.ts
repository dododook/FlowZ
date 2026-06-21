/**
 * 运行时状态类型定义
 * 代理状态、连接快照、helper 状态、流量统计、IP 信息等运行态类型
 */

import type { LogLevel, ServerConfig } from '../types';

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
  CRONET_LIB_MISSING = 'CRONET_LIB_MISSING', // 'cronet: library not found' / dlopen 失败（naive 出站缺/坏 libcronet → 整核 FATAL，自愈冷路径触发）
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
