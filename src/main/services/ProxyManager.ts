/**
 * 代理管理服务
 * 负责 sing-box 进程的生命周期管理和配置生成
 */

import { BrowserWindow, shell, powerMonitor } from 'electron';
import { notifyUser } from '../notify-user';
import { mt } from '../i18n';
import { spawn, ChildProcess } from 'child_process';
import { system32, powershellPath } from '../utils/win-system32';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import * as https from 'https';
import { EventEmitter } from 'events';
import type {
  UserConfig,
  ServerConfig,
  ProxyStatus,
  HelperStatus,
  InvalidNodeInfo,
} from '../../shared/types';
import { ProxyErrorCode } from '../../shared/types';
import type { ILogManager } from './LogManager';
import { HelperManager } from './HelperManager';
import type { IPrivilegedHelper } from './IPrivilegedHelper';
import { PlatformPrivilegeService } from './PlatformPrivilegeService';
import { type ISystemProxyManager, SystemProxyBase } from './SystemProxyManager';
import { type ISystemDnsManager } from './SystemDnsManager';
import { DnsInterfaceWatcher, shouldReconcileDns } from './DnsInterfaceWatcher';
import { localProxyPort, controlApiPort } from '../../shared/proxy-ports';
import { effectiveBypassLan } from '../../shared/system-proxy-bypass';
import { isDirectSelection, resolveGlobalExitTag } from '../../shared/direct-selection';
import {
  isIpv4Host,
  isIpv6Host,
  effectiveAppRules,
  applyRuleSetPrune,
  buildIdToTagMap,
} from './singbox-config-helpers';
import { buildDnsConfig } from './singbox-dns-builder';
import { buildRouteConfig } from './singbox-route-builder';
import { buildInbounds } from './singbox-inbounds-builder';
import { buildLogConfig } from './singbox-log-builder';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { LOGIN_ITEMS_SETTINGS_URL } from '../../shared/constants';
import { resourceManager } from './ResourceManager';
import { seedBuiltinRuleSets } from './builtin-geo-rulesets';
import type { SingBoxConfig, SingBoxOutbound, SingBoxEndpoint } from './singbox-config-types';
import {
  buildProxyOutbound,
  isNodeUsable,
  buildWireGuardEndpoint,
  prunedSelectorDefault,
  buildOutbounds,
  type PendingRuleSelector,
} from './singbox-outbound-builder';
import { NodeDnsRaceServer } from './node-dns-race-server';
import { resolveUpstreams, DEFAULT_POOL_IDS } from '../../shared/node-resolver-upstreams';
import {
  isEndpointProtocol,
  isAccountBasedProtocol,
  isSpeedTestable,
  meshSelectedExitFallsBackToDirect,
  meshAlwaysRoutesSubnets,
  endpointForcedRouteCidrs,
} from '../../shared/endpoint-routes';
import {
  classifyCoreBuild,
  decideCoreOverride,
  classifyReseedResult,
} from '../../shared/core-build';
import { retry } from '../utils/retry';
import { coreVersionAtLeast } from '../../shared/version';
import { parseTailscaleAuthLine } from '../../shared/tailscale';
import { safeHttpUrl } from '../../shared/url';
import { tailscaleStateExists, tailscaleStateDir } from './tailscale-state';
import { buildTailscaleLoginConfig, tailscaleEndpointInRunningCore } from './tailscale-login-core';
import { SingBoxApiClient, type TailscaleEndpointStatus } from './singbox-api-client';
import { reconcileTreeOwnership } from './runtime-ownership';
import {
  getUserDataPath,
  getSingBoxConfigPath,
  getSingBoxLogPath,
  getSingBoxPidPath,
  getCachePath,
  getCustomRulesDir,
  getSingboxDashboardOverrideDir,
} from '../utils/paths';
import { ruleConditions } from '../../shared/rules';
import { planCustomRule, buildCustomRuleFiles, condMatcherFields } from './custom-rule-files';
import { resolveWinTunInterfaceName } from '../../shared/tun-interface';
import { probeWinTunAdapterPresent, waitForAdapterReleased } from './win-tun-adapter';
import {
  probeTcpReachable,
  waitForCoreReady,
  CoreStartRetryError,
  CoreStartSupersededError,
} from './core-readiness';
import coreManifest from '../../shared/core-manifest.json';

/**
 * 私有 IP 地址段（CIDR 格式）
 * 用于路由规则中的直连配置
 */
/**
 * 私有 IP 地址正则表达式
 * 用于日志过滤中识别内网请求
 */
const PRIVATE_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/,
  /\b192\.168\.\d{1,3}\.\d{1,3}/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b169\.254\.\d{1,3}\.\d{1,3}/,
];

/**
 * 从 sing-box `check` 的 stderr 解析出错出站的数组下标。覆盖两种措辞：
 *  - decode 阶段复数：`outbounds[2].method: ...`
 *  - initialize 阶段单数：`outbound[2]: ...` / `dependency... for outbound[2]`
 * 不命中返回 null（调用方降级为「配置校验失败」不启动，不误剔）。
 */
export function parseCheckOutboundIndex(stderr: string): number | null {
  const m = /\boutbounds?\[(\d+)\]/.exec(stderr);
  if (!m) return null;
  const idx = Number(m[1]);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * 同 parseCheckOutboundIndex，但匹配 endpoints[N]（sing-box 顶层 endpoints[]：WireGuard/Tailscale/自定义 endpoint）。
 * 自定义 endpoint 用不被内核支持的 type 时，check 报 `endpoints[N]: unknown endpoint type` —— 须能据此剪除该
 * endpoint 节点（否则 idx=null 整体启动失败）。内置 WG/TS 恒兼容，历史上不触发；自定义 endpoint 才需要它。
 */
export function parseCheckEndpointIndex(stderr: string): number | null {
  const m = /\bendpoints?\[(\d+)\]/.exec(stderr);
  if (!m) return null;
  const idx = Number(m[1]);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * 进程优雅终止升级（SIGTERM → 宽限期 → SIGKILL），注入式纯逻辑（便于单测）：
 *  1. 立即发 SIGTERM（优雅退出窗口）；
 *  2. graceMs 后若进程仍存活（未触发 exit 收尾）→ 发 SIGKILL 强杀。
 * 返回升级 timer 句柄，调用方须在进程 exit/error 收尾时 clearTimeout 它（防 timer 泄漏 + 升级被取消）。
 * 与主核 stopSingBoxProcess 的 SIGTERM→SIGKILL 模式一致（瞬态核宽限期更短：进程轻量、无 TUN/路由要拆）。
 *
 * deps 注入 sendSignal（实际为 proc.kill）+ schedule（实际为 setTimeout），单测可零进程验证两段信号序。
 */
export function escalateProcessKill(deps: {
  sendSignal: (signal: NodeJS.Signals) => void;
  schedule: (fn: () => void, ms: number) => NodeJS.Timeout;
  graceMs: number;
}): NodeJS.Timeout {
  // SIGTERM 对已退出进程为安全 no-op（ChildProcess.kill 返回 false 不抛）。
  deps.sendSignal('SIGTERM');
  return deps.schedule(() => {
    // 宽限期到点仍未被 finalize 取消 → 进程拒绝 SIGTERM，强杀。SIGKILL 对已退出进程同样安全 no-op。
    deps.sendSignal('SIGKILL');
  }, deps.graceMs);
}

export interface IProxyManager {
  start(config: UserConfig, options?: { interactive?: boolean }): Promise<void>;
  stop(opts?: { quitting?: boolean }): Promise<void>;
  teardownForQuit(): Promise<void>;
  restart(config: UserConfig, options?: { interactive?: boolean }): Promise<void>;
  switchMode(config: UserConfig): Promise<void>;
  getStatus(): ProxyStatus;
  isStartedViaHelper(): boolean;
  // api service（sing-box 1.14 management api）运行期监听端口；「打开官方面板」IPC 据此构造 /dashboard/ URL（0=未启动）。
  getTailscaleApiPort(): number;
  // dashboard #55：面板连接信息（运行期 api 端口 + clash secret），供「内窗口直连」预写 localStorage 与「复制连接信息」用。
  // secret 取自 main config（不长驻渲染端 store）；代理未运行 → { ok: false }。
  getDashboardConnectionInfo(): { ok: boolean; url: string; apiUrl: string; secret: string };
  // 运行期管理 API 客户端（sing-box 1.14 gRPC）：供 StatsService 经此订阅 Status/Connections 流；未启动核时为 null。
  getApiClient(): SingBoxApiClient | null;
  generateSingBoxConfig(config: UserConfig, resolvedIps?: Record<string, string>): SingBoxConfig;
  on(
    event:
      | 'started'
      | 'stopped'
      | 'error'
      | 'node-hot-switched'
      | 'api-client-ready'
      | 'tailscale-selected-running',
    listener: (...args: any[]) => void
  ): void;
  off(
    event:
      | 'started'
      | 'stopped'
      | 'error'
      | 'node-hot-switched'
      | 'api-client-ready'
      | 'tailscale-selected-running',
    listener: (...args: any[]) => void
  ): void;
  getCoreVersion(force?: boolean): Promise<string>;
  buildPreflightConfigJson(targetVersion: string): string | null;
  probeOutbound(
    outbound: unknown,
    isEndpoint?: boolean
  ): Promise<{ ok: boolean; indeterminate?: boolean; error?: string }>;
  closeConnection(id?: string): Promise<{ ok: boolean; status: number }>;
}

export class ProxyManager extends EventEmitter implements IProxyManager {
  private singboxProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private pid: number | null = null;
  private singboxPid: number | null = null; // macOS TUN 模式下实际的 sing-box PID
  // 提权 helper（macOS=HelperManager / Windows=WindowsServiceHelper，装一次后免提权启停）；未注入/未就绪
  // 则回退平台提权路径（macOS osascript 看护脚本 / Windows 每次 UAC）。按 process.platform 在 index.ts 装配。
  private helperManager: IPrivilegedHelper | null = null;
  // 系统代理单一写者（注入 index.ts 的同一 singleton，与 IPC handler/tray 共享 originalSettings/marker 状态）。
  // 拆双轨：ProxyManager 不再内联 networksetup/reg，统一经此调用 enableProxy/disableProxy（带 marker + 防自指）。
  private systemProxyManager: ISystemProxyManager | null = null;
  // 系统 DNS 接管单一写者（注入 index.ts 同一 singleton）：仅 TUN 模式接管（on-link LAN DNS 不进 TUN → hijack
  // 失效，故强制系统 DNS 为可路由的受控 IP 使其经 TUN 被 hijack）。与 systemProxyManager 同生命周期点收口。
  private systemDnsManager: ISystemDnsManager | null = null;
  // 方案B：接管前读到的内网 LAN 解析器 IP（私网 IPv4）。仅 TUN+takeover 开时在 generateSingBoxConfig 前预读填充，
  // 供 generateDnsConfig 把内网/captive 域名重定向到它（takeover 后 dns-local=公网解不了内网）+ rule C 直连放行防环。
  // null=无可用 LAN 解析器（非 TUN/关/DHCP 读不到/仅公网）→ 退回 dns-local。每次 start 入口重置重读。
  private lanResolverForDns: string | null = null;
  // issue #147：本地节点域名 race DNS server（多上游并发 race）+ 其监听端口。start 路径（race on）起；
  // raceServerPort>0 = race 就绪 → getNodeResolverTag on→dns-node-race + buildDnsConfig 生成该 server；
  // =0（off / 起失败 / snapshot/preflight/未启动路径）→ 降级单上游（生成物逐字节回现状，快照零变化）。
  private nodeDnsRaceServer = new NodeDnsRaceServer({
    log: (level, message) => this.logToManager(level, message),
  });
  private raceServerPort = 0;
  // issue #147 §E.1：本地 race server 的上游 IP（含内置+自定义），TUN 下经 route 直连放行防回环。race off / 未起 → []。
  private raceUpstreamIps: string[] = [];
  // 杀核前「静默 StatsService」回调（停其到管理 API 的 Status/Connections gRPC 流）：核将死，提前 cancel 流避免 RST 噪音。
  private quiesceStats: (() => void) | null = null;
  // 事件驱动出口 re-probe 去重（item 1）：记上次因「选中 TS 节点 STATUS 翻 Running」已发过 re-probe 的 serverId。
  // STATUS 流持续推帧，仅 Running 上升沿（首次见该选中节点 Running）发一次 'tailscale-selected-running'，避免每帧触发。
  // 切到别的节点 / 节点掉出 Running（停止/掉线）即清空，使下次重新 Running 能再发（覆盖重连）。
  private lastTsSelectedRunningId: string | null = null;
  // P2a：启用代理 / 切接管模式（两者均经 startInternal）后延迟一次「连接 flush」的延时器。stop()/再次 start 时清。
  private connectionFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // 平台提权服务（T16：原提权脚本生成 / 文件权限 / 提权复制等纯函数迁出，经 setPrivilegeService 注入；
  // delegate 落地后调用点零改动）。macOS 委托 helperManager 分支由子 commit 后续处理，本字段先占位。
  private privilegeService: PlatformPrivilegeService | null = null;
  // ensureSystemProxyCleared 单飞：终态清理可能被 giveUp/健康检查/信号死多路并发触发，防重复 disable。
  private clearingSystemProxy = false;
  // ensureSystemDnsRestored 单飞：与系统代理同终态多路并发，防重复 restore。
  private clearingSystemDns = false;
  // macOS DNS 接管「热插重灌」watcher：setDns 成功后起、stop/终态还原时停（仅 darwin，与 setDns 真接管同口径）。
  // 长驻 route -n monitor 探链路变化 + powerMonitor resume → 去抖调 reconcileDns 补接管新出现/换网未受控的服务。
  private dnsInterfaceWatcher: DnsInterfaceWatcher | null = null;
  // 「主动停止/重启中」：stop() 期间置位，令 ensureSystemProxyCleared 跳过——避免重启 stop 腿清掉系统代理后
  // 又被 start() reconcile 设回的并发竞态（C1）。真·外部死亡时为 false → 信号死分支照常清理。
  private stopping = false;
  // 用户在自动重启退避窗口内主动停止 → 置位，令 attemptAutoRestart 退避后放弃重启（用户意图优先，M3）。
  // 退避已加宽到 2/5/15s，窗口可达分钟级；start() 入口复位。
  private autoRestartAborted = false;
  // 生命周期世代：start()/stop() 入口各 +1。attemptAutoRestart 进入时快照，退避后比对——变了说明已有更新的
  // start/stop 接管生命周期（如退避窗口内用户手动 start，它会 reset autoRestartAborted=false 绕过 M3 检查）→
  // 本次自动重启静默让位，杜绝「自动腿 + 手动腿」双启动流并发互相杀进程/撞 9090/误清对方系统代理（M-2′）。
  private lifecycleGeneration = 0;
  // 在途自动重启腿的世代快照（isRestarting 置位时记，finally 清 -1）。供 handleProcessExit 判断「在途腿是否已被
  // supersede（注定让位）」→ 若是且此刻又崩溃，置 crashWhileSuperseded 让那条腿醒来补发一次重启，否则崩溃信号
  // 被 isRestarting dedup 吞掉、接管会话死后无人恢复（M-2′-G1）。
  private restartingGen = -1;
  private crashWhileSuperseded = false;
  // helper 引导门控回调（主进程 UI 注入）。收敛单点：所有 start/restart 入口（按钮/托盘/切模式/
  // config-changed 重启/换节点回退重启…）最终都汇入 start()，gate 设在此处即不可能漏。
  // 返回 'abort' → start() 抛 HELPER_GATE_ABORTED 终止启动（终态等价 osascript 取消=停止态）。
  private helperGate:
    | ((hs: HelperStatus, config: UserConfig) => Promise<'proceed' | 'abort'>)
    | null = null;
  // 本次 sing-box 是否经 helper 启动（决定停止走 helper socket 还是 osascript）。
  private startedViaHelper: boolean = false;
  // 远程 geo rule_set URL 可达性缓存（应用分流/自定义 geo 规则的 remote rule_set 预检用）。
  // 仅缓存"确定结论"：2xx→可达(6h)，404/403/410→缺失(30min，留恢复窗口)；瞬时错误不缓存。见 isRemoteRuleSetReachable。
  private ruleSetReachCache = new Map<string, { reachable: boolean; at: number }>();
  // 本次 start 是否交互式（非交互=崩溃自动重启）：helper 不可用时非交互不裸弹 osascript（F10）。
  private startInteractive: boolean = true;
  // 重启去抖：连改多条配置（编辑多条规则/导入/迁移）合并为一次重启，避免每次编辑 ~1.2s 断流。
  // trailing 触发时取 this.currentConfig（恒最新），故各 switchMode 分支须先更新 currentConfig。
  private restartDebounceTimer: NodeJS.Timeout | null = null;
  private static readonly RESTART_DEBOUNCE_MS = 1500;
  // issue #176 配置变更重启轴单飞：lifecycleDepth>0 = 有 start/stop/restart 在飞。去抖重启 trailing 命中时不并发
  // 起第二条（杜绝「就绪等待中又来重启」叠加 stop/超时/restart 互踩 → wintun 适配器抢放 → 「管理 API 未绑定」假
  // 超时风暴），只置 restartPending；在飞操作 settle 回 depth 0 时由 endLifecycleOp 排空一次尾随重启（吃最新
  // currentConfig）。与崩溃轴（isRestarting/lifecycleGeneration）、换核轴（coreSwapInProgress）正交、互不干扰。
  private lifecycleDepth = 0;
  private restartPending = false;
  // issue #176：最近一次 start() 是否因被接管而「静默让位」（未真正起核）。startInternal 入口复位 false，start() 的
  // supersede 吞掉分支同步置 true。供 attemptAutoRestart 在 await start() 后判别——让位时跳过「自动重启成功」日志与
  // EVENT_PROXY_STARTED（否则发出与「已让位」矛盾、pid/startTime 陈旧的多余 started 事件）。
  // 安全契约：读取必须**紧贴**对应的 `await this.start(...)`（之间无 await）——置 true 发生在 start() 让位 catch 的
  //   同步段、与 promise resolve 之间无让出窗口，故读者恒读到自己那次 start 的让位态，不被并发 start 的入口复位污染。
  //   成功 start 路径不写 true（入口置 false、成功不改）→ 成功恒 false。新增读者须遵守此「读紧贴 await」约束。
  private lastStartSuperseded = false;
  // 上次生成时有外化规则因「文件未落盘」降级走 inline（值已在 inline route 规则里、文件无消费者）。
  // 置 true → 热路径(switchMode no-op 分支)改走重启重落盘，防「写文件但无人消费」导致值陈旧。
  private customRuleFilesDegraded = false;
  private currentConfig: UserConfig | null = null;
  // 启动时生成的「节点 id → selector 成员 tag」映射，用于 clash_api 热切换时定位目标 tag
  private currentIdToTagMap: Map<string, string> | null = null;
  // 启动时生成的「规则 key → { selectorTag, memberTag }」映射，用于「改规则目标节点」clash_api 热切换
  // （rule-sel-<ruleId> 独立 selector，避免固定规则经共享 proxy-selector 跟随全局节点漂移）。
  // key 形如 `custom:<ruleId>` / `app:<appId>`（与生成侧 selectorTag 一一对应）。
  private currentRuleTargetMap: Map<string, { selectorTag: string; memberTag: string }> | null =
    null;
  // 生成侧暂存：本轮 generateOutbounds 产出的 rule-sel selector 列表（selectorTag/memberTag/targetServerId），
  // 供 generateSingBoxConfig 末尾按 targetServerId → currentConfig 解析回 ruleKey 填充 currentRuleTargetMap。
  // 仅 generateRuleSelectors 写、generateSingBoxConfig 末尾读，跨这两步的临时载体（非持久态）。
  private pendingRuleSelectors: PendingRuleSelector[] = [];
  // 生成侧暂存：本轮 generateOutbounds 产出的 endpoint（WireGuard 等，sing-box 顶层 endpoints[]）。
  // 仅 generateOutbounds 写、generateSingBoxConfig 末尾读，注入 SingBoxConfig.endpoints（非持久态）。
  private pendingEndpoints: SingBoxEndpoint[] = [];
  // 启动前配置校验 gate 标记的非法节点（坏节点会让 sing-box 整体启动 FATAL）：仅会话内存，每次
  // startInternal 清空重判（换核自动复活）。generateOutbounds 据此跳过、不进 selector；checkAndPruneConfig
  // 迭代填充并在末尾推送渲染端标灰。
  private gateInvalidNodes = new Map<string, InvalidNodeInfo>();
  // 本次 start 是否已用过「run-FATAL dependency not found」解析修正腿（A7 备用腿，单次闸，防重写抖动）。
  private refFixAttempted = false;
  // libcronet 启动失败自愈（T2 冷路径）一次性闸：本次 start 内命中 cronet FATAL → strong 重拷 + 重启一次，
  // 仅一次（防「拷不动/版本错位反复 restored」抖动循环）。每次 start 复位（与 refFixAttempted 同生命周期）。
  private cronetHealAttempted = false;
  // 诊断计数（本会话累计，跨多次 start 累加）：自愈触发次数 / 失败次数，纳入诊断报告供「库被反复删（疑杀软）」定位。
  private cronetHealTriggeredCount = 0;
  private cronetHealFailedCount = 0;
  // 出口 IP 探针 inbound 的动态端口（每次 start 重新分配）：probe-direct-in → direct 出站，
  // probe-proxy-in → proxy-selector。经此两口发请求，能在「三种接管 × 三种分流」全矩阵下稳定测出
  // 真实直连出口 IP 与代理出口 IP（inbound 规则在 route.rules 头部短路，不受分流策略影响）。
  private probeDirectPort: number | null = null;
  private probeProxyPort: number | null = null;
  private configPath: string;
  private singboxPath: string;
  // `sing-box version` 探测串行链（issue #150）：所有版本探测（启动检测/换核重读/CoreUpdate 检查/关于页）汇流
  // 此处串行排队，确保任一时刻至多一个 version 子进程 execve 内核二进制——缩小与启动期换核写盘并发执行的 race 窗口。
  private versionProbeChain: Promise<unknown> = Promise.resolve();
  private logManager: ILogManager | null = null;
  // 隐私模式 provider（index 注入 getPrivacyMode）：隐私开 → sing-box 日志级别抬到 ≥warn，不记访问域名/SNI。
  private privacyProvider: () => boolean = () => false;
  // sing-box 1.14 管理 API：统一管理面客户端（Tailscale 状态订阅 + clash 等价方法）+ 其 api service 端口（clash 端口 +1，独立共存）。
  private tailscaleApiClient: SingBoxApiClient | null = null;
  private tailscaleApiPort = 0;
  private lastLogMessage: string = '';
  private lastLogCount: number = 0;
  private lastLogTime: number = 0;
  private mainWindow: BrowserWindow | null = null;
  private lastErrorOutput: string = '';
  private logFileWatcher: ReturnType<typeof setInterval> | null = null;
  private lastLogFileSize: number = 0;
  // 长会话 debug 日志无限增长会撑满磁盘，超过此上限即截断 singbox.log
  // （sing-box 以 O_APPEND 模式写，截断后从 offset 0 续写，不产生 sparse 空洞）
  private static readonly MAX_LOG_FILE_SIZE = 20 * 1024 * 1024; // 20MB
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEALTH_CHECK_INTERVAL = 10000; // 10秒检查一次

  // issue #159：Windows TUN 重启前等自家 wintun 适配器释放的门控参数。8s 上限覆盖硬杀后驱动回收滞后，
  // 250ms 轮询；探测到消失即早退（常见 1-3s），超时 fail-open 放行交启动 retry（绝不卡死代理）。
  private static readonly TUN_ADAPTER_RELEASE_TIMEOUT_MS = 8000;
  // 500ms 轮询：每轮 probe 一次 Get-NetAdapter（spawn powershell，冷启 ~百 ms），间隔放宽控最坏 spawn 次数（≤~16）。
  // 常见 1-3 轮即检出释放、早退。若真机证明 PS spawn 仍过重，可改单次长轮询 PS 脚本（内部 while+Start-Sleep）只付一次冷启。
  private static readonly TUN_ADAPTER_RELEASE_POLL_MS = 500;
  // wintun 适配器存在性探测（默认 Get-NetAdapter，零提权，按本名匹配）；注入式便于单测替换桩。
  private adapterProbe: (name: string) => Promise<boolean> = probeWinTunAdapterPresent;

  // issue #159 纵深网：helper 起核后等核真就绪（管理 API 绑定）的门控。成功路径早退（API 通常 <1s 绑定）不加延迟；
  // 12s 上限仅在「进程活但 API 始终不绑」的卡死态触顶，进程死则即时捕获。
  private static readonly CORE_READY_TIMEOUT_MS = 12000;
  // 500ms 轮询：成功路径 isReady(异步TCP) 早退、不触发 isAlive(execSync 探活阻塞)；仅失败路径每轮探活，放宽间隔控阻塞次数。
  private static readonly CORE_READY_POLL_MS = 500;
  // 管理 API 可连探测（默认 TCP 直连）；注入式便于单测替换桩。
  private coreReadyProbe: (host: string, port: number) => Promise<boolean> = probeTcpReachable;
  // issue #176 诊断计数：本次启动经几次「就绪重试」才成功（runStartWithRetry 累计）。>0 = 起核慢（多因 Windows
  // 重启争用下 wintun 适配器未及时释放），与「核崩溃自动重启」（restartCount/AUTO_RESTARTING）是不同轴，纳入诊断
  // 区分「核崩」vs「争用慢起」。每次 startInternal 复位。
  private lastStartReadyRetries = 0;

  // 自动重启相关
  private autoRestartEnabled: boolean = true;
  // 核心更新"待验证窗口"内由 CoreUpdateService 置 true：抑制自动重启，让新核心首次异常退出立即
  // 上报 'error' 触发回滚（而非在已知有问题的新核心上空转 MAX_RESTART_COUNT 次后才上报）。
  private autoRestartSuppressed: boolean = false;
  // 核心更新「二进制替换窗口」内由 CoreUpdateService.installCoreFromDir 置 true：拒绝手动 start/restart/switchMode，
  // 防用户在内核半替换期间拉起进程撞 FATAL。与 autoRestartSuppressed 同区但生命周期更短——仅覆盖 installCoreFromDir
  // 执行期（install 返回即清，让 updateCore/applyStagedNow 后续 start 放行）；autoRestartSuppressed 覆盖更长的
  // 「首启验证窗口」（armPendingValidation 管）。两者独立，勿混。
  private coreSwapInProgress: boolean = false;
  private restartCount: number = 0;
  private lastRestartTime: number = 0;
  private static readonly MAX_RESTART_COUNT = 3; // 最大重启次数
  private static readonly RESTART_COOLDOWN = 60000; // 重启冷却时间（1分钟内最多重启3次）
  private isRestarting: boolean = false;
  private coreVersion: string = 'unknown';
  // `sing-box version` 原始第一行（含 fork 后缀，不截 X.Y.Z）；供内核来源判定（classifyCoreBuild）。
  // 由 getCoreVersion 的同一次 spawn 顺带写入，避免「关于/内核」页二次 spawn（Windows 45MB 核加载慢）。
  private coreVersionLine: string | null = null;

  constructor(
    logManager?: ILogManager,
    mainWindow?: BrowserWindow,
    configPath?: string,
    singboxPath?: string
  ) {
    super();
    this.logManager = logManager || null;
    this.mainWindow = mainWindow || null;

    // 配置文件路径
    if (configPath) {
      this.configPath = configPath;
    } else {
      this.configPath = getSingBoxConfigPath();
    }

    // sing-box 可执行文件路径
    if (singboxPath) {
      this.singboxPath = singboxPath;
    } else {
      this.singboxPath = this.getSingBoxPath();
    }
  }

  /**
   * 启动代理（public 包装）：失败统一收口清系统代理——重启/切模式场景下旧会话系统代理仍指向现已死的端口，
   * 启动失败必须清掉防全网断（L-2′）。覆盖所有直接 start 入口（PROXY_START/托盘/自动连接）与 restart 的 start 腿，
   * 故 restart() 不再单独 catch-clear。ensureSystemProxyCleared 在非主动 stop 语境 stopping=false → 会真清；
   * fresh start 无 marker → no-op。
   */
  async start(config: UserConfig, options: { interactive?: boolean } = {}): Promise<void> {
    this.beginLifecycleOp();
    try {
      await this.startInternal(config, options);
    } catch (e) {
      // issue #176：本腿在就绪等待期被更新的 start/stop 接管 → 静默让位，**绝不 cleanup**（接管方已拥有/正在
      //   建立进程与系统代理状态，cleanup 会清掉它的 refs）。镜像 attemptAutoRestart「自动重启已让位」语义。
      if (e instanceof CoreStartSupersededError) {
        this.lastStartSuperseded = true; // 供 attemptAutoRestart 判别，跳过让位时的多余 started 事件
        this.logToManager('info', '启动已让位（检测到更新的启动/停止操作接管）');
        return;
      }
      // 启动失败终态收口：① 清进程引用——否则 singboxProcess/pid 仍指向已死进程，下次 start 的内部 stop() 会对
      //   死进程挂 once('exit')（exit 早发过、永不再触发）→ 永挂 → UI 恒「启动中」（修「二次点击卡死」根因 A）。
      //   cleanup 在此只在「最终失败」执行，不影响 retry 成功路径的探针端口。② 清可能残留的系统代理（L-2′）。
      this.cleanup();
      await this.ensureSystemProxyCleared();
      throw e;
    } finally {
      this.endLifecycleOp('start');
    }
  }

  private async startInternal(
    config: UserConfig,
    options: { interactive?: boolean } = {}
  ): Promise<void> {
    // core-swap 手动轴门控：内核替换窗口中拒绝启动（防撞半替换核 FATAL）。须在 lifecycleGeneration++ 之前——
    // 被拒时不污染世代。updateCore/applyStagedNow 自身的 start 在 installCoreFromDir 返回后调用（coreSwapInProgress
    // 已清），不受此闸影响。
    this.rejectIfCoreSwapInProgress('启动代理');
    // issue #176：本次 start 让位标记从干净态开始（被接管时 start() 包装置 true）。
    this.lastStartSuperseded = false;
    // 生命周期世代 +1：标记一次新的 start 接管（供退避中的 attemptAutoRestart 比对让位，M-2′）。
    this.lifecycleGeneration++;
    // 新启动接管 → 清掉任何陈旧的 supersede-崩溃补发标记（防上一会话遗留的标记误触发补发，M-2′-G1 防陈旧）。
    this.crashWhileSuperseded = false;
    // 新会话从干净状态开始：清 TS「选中节点已 Running」去重标记。stop() 断 tailscaleApiClient 后不再有 STATUS 帧
    // 推「非 Running」来清此标记，残留的 Running 标记会让重连同一 TS 节点时新 STATUS 首帧 Running 被去重命中、
    // 'tailscale-selected-running' 不发射 → 事件驱动出口 re-probe 丢失（退避仍兜底但失去「隧道就绪即抢先出口」）。
    // 与 handleTailscaleStatus 的清除逻辑不冲突：那是运行期掉线/切节点时清，此处只补会话起点的重置。
    this.lastTsSelectedRunningId = null;
    // 本次启动是否交互式（非交互=崩溃自动重启）：供 startSingBoxProcess 决定 helper 不可用时是否裸弹 osascript。
    this.startInteractive = options.interactive !== false;
    // 真正 start 即作废未决的去抖重启（崩溃自动重启直走 start、不经 stop，避免窗口内 crash 后被二次拉起）
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
    // 如果已经在运行，先停止
    if (this.singboxProcess || this.singboxPid) {
      await this.stop();
    }

    // 复位自动重启取消标记：必须在上面的内部 stop() 之后（stop 会置 true）——真正开始一次启动即清掉，
    // 否则 start 的内部 stop poison 该标记会让此后所有崩溃自动重启被误拦（M3 回归防护）。
    this.autoRestartAborted = false;

    // 用户态启动（手动/托盘/IPC/去抖重启，恒 interactive!==false）即重置重启计数；自动重启腿恒 interactive:false
    // 不重置（计数需跨自动重启累积到上限）。按用户意图判而非 isRestarting——退避窗口内用户手动 start 时
    // isRestarting 仍为 true，旧 `!isRestarting` 会漏掉这次重置（gen token 已钦定它为合法接管，L-G2）。
    if (options.interactive !== false) {
      this.resetRestartCount();
    }

    // 先保存当前配置（needsRootPrivilege 等方法需要用到）
    this.currentConfig = config;

    // Linux 下确保核心在用户目录且可执行，以便支持 setcap 和规避 AppImage EROFS
    if (process.platform === 'linux') {
      try {
        this.singboxPath = await resourceManager.ensureWritableCore();
      } catch (err) {
        this.logToManager('error', `Linux 核心准备失败: ${(err as Error).message}`);
      }
    } else if (process.platform === 'darwin') {
      // B 块：受保护目录是 macOS 现役核单一真相，install-core 换核后路径不变、内容变；每次 start 重解析
      // this.singboxPath，消除「同会话换核/装 helper 后仍用构造时缓存的旧（bundle）路径」（修 review HIGH-1）。
      this.singboxPath = this.getSingBoxPath();
    } else if (process.platform === 'win32') {
      // 对齐 darwin HIGH-1：Windows 现役核恒为可写核（getSingBoxPath 优先 userData/core_update），CoreUpdateService
      // 同会话换核写入该处后路径不变、内容变；每次 start 重解析 this.singboxPath，消除「同会话换核后仍用构造时
      // 缓存的随包路径 → version 探测/check/spawn 全走旧核 → 换核静默 no-op」（修 #168 review MED-2）。
      this.singboxPath = this.getSingBoxPath();
    }

    // 清理可能残留的 sing-box 孤儿进程（崩溃残留占 TUN 设备/端口致下次启动失败）。1B：去掉旧 TUN gate，
    // 系统代理模式也清——Mac 非 TUN 走零提权用户态 kill（systemProxy sing-box 是用户进程，绝不弹 osascript）。
    const isTunMode = config.proxyModeType === 'tun';

    // macOS 提权 helper 引导门控（收敛单点，先于一切重活；abort 直接抛出、不留半启动态）。
    await this.maybePromptHelperGate(config, isTunMode, options);

    await this.killOrphanedSingBoxProcesses(isTunMode);

    // 孤儿清理后仍占 9090 → 按端口清掉占用者（helper freePort / osascript），否则明确终态（L2，含外部/旧路径
    // sing-box）。把「裸 spawn 撞 9090 占用 → retry 风暴」收敛为一次明确、可定位的失败。
    await this.resolveClashApiPortConflict();

    // 0. 获取核心版本（用于后续生成兼容的配置文件）。force=true：内核可能已更新，启动时强制重检测刷新缓存。
    this.coreVersion = await this.getCoreVersion(true);
    this.logToManager('info', `检测到 sing-box 核心版本: ${this.coreVersion}`);

    // §5 核覆盖 reconcile + 最低版本守卫：内置核是种子（强制落位），决策只针对本机在用的【非内置】核。
    //  官方 <内置 → 内置替换（取更新随包核）；官方 ≥内置 → 保持（不降级用户装的官方核）；
    //  fork/unknown → 保持（绝不覆盖用户的 fork/自建核），≤内置 → 发基线兼容警告。
    // 配置已硬切 1.14，<1.14 核会 unknown-field FATAL，故覆盖决策后仍 <1.14 → 明确报错（含 fork 专属引导）。
    {
      const bundledCore = coreManifest.bundledCoreVersion;
      const coreKind = classifyCoreBuild(this.coreVersionLine || `version ${this.coreVersion}`);
      const { reseed, warn } = decideCoreOverride(coreKind, this.coreVersion, bundledCore);
      if (reseed) {
        const before = this.coreVersion;
        this.logToManager(
          'info',
          `官方内核 ${before} 旧于随包基线 ${bundledCore}，用随包核替换...`
        );
        let reseedError = '';
        try {
          // §5 两平台统一经 ensureWritableCore(true)：linux force 覆盖可写核；darwin 经注入的 helper installCore
          // 重播种随包核到受保护目录（root-only，helper 上方 maybePromptHelperGate 已引导在位）。临时目录复制 +
          // installCore 编排已下沉 ResourceManager（平台感知，免 ProxyManager 内联）。修：app 更新后受保护目录旧核不自愈。
          // darwin helperManager 恒为 HelperManager（win 才注入 WindowsServiceHelper）；installCore 是具体方法非接口成员，故 cast。
          if (process.platform === 'darwin') this.helperManager ??= new HelperManager();
          this.singboxPath = await resourceManager.ensureWritableCore(true, {
            installCore: (seedDir) => (this.helperManager as HelperManager).installCore(seedDir),
          });
        } catch (e) {
          reseedError = (e as Error)?.message ?? String(e);
        }
        // 诚实校验（issue #150 + review F1）：重读活二进制确认换核「真的」生效。用 getCoreVersionLine(true)
        // ——其探测失败返回 ''、**不回落随包基线**；绝不用 getCoreVersion（探测失败会回落 bundledCoreVersion，
        // 把「重读失败」伪装成「换核成功」→ 闸门误放行、带旧核硬跑退回死循环）。探测失败/版本未达基线 → 保守
        // 保留换核前旧版本、判未生效，由下方版本闸门明确终止（而非谎报成功）。
        const lineAfter = await this.getCoreVersionLine(true);
        const { version, applied } = classifyReseedResult(lineAfter, before, bundledCore);
        this.coreVersion = version;
        if (applied) {
          this.logToManager('info', `内核已用随包版刷新至 ${this.coreVersion}`);
        } else {
          this.logToManager(
            'warn',
            `随包内核刷新未生效（仍为 ${this.coreVersion}，期望 ≥ ${bundledCore}）${reseedError ? `：${reseedError}` : ''}；请退出代理后在「设置 · 内核 · 重置到出厂」手动切回随包核`
          );
        }
      }
      if (warn) {
        this.logToManager(
          'warn',
          `检测到非官方内核 ${this.coreVersion} 低于随包基线 ${bundledCore}，可能与新版配置不兼容（连接异常/功能缺失）；建议手动升级内核或在「设置 · 内核 · 重置到出厂」切回随包官方核`
        );
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_CORE_BASELINE_WARNING, {
          current: this.coreVersion,
          bundled: bundledCore,
          kind: coreKind,
        });
      }
      // 覆盖决策后仍 <1.14（仅 fork/unknown 旧核会到此；官方旧核已重播种到 ≥内置≥1.14）→ 配置 FATAL 前明确报错。
      if (!coreVersionAtLeast(this.coreVersion, 1, 14)) {
        throw new Error(
          coreKind === 'official'
            ? `当前 sing-box 内核版本 ${this.coreVersion} 低于所需的 1.14。请重新安装应用以获取随包内核，或在「设置 · 内核」更新到 1.14 及以上。`
            : `当前使用的非官方内核 ${this.coreVersion} 低于所需的 1.14，与新版配置不兼容。请手动升级该内核到 ≥1.14，或在「设置 · 内核 · 重置到出厂」切回随包官方核。`
        );
      }
    }

    // 1.14 管理 API 端口：解析一个空闲本地端口（排除 clash/用户端口），避免硬编 clash+1 撞占致 services bind FATAL（A1）。
    this.tailscaleApiPort = await this.resolveTailscaleApiPort(config);

    // 修复可能被 root 创建的文件权限（从 TUN 模式切换到系统代理模式时）
    await this.fixFilePermissions();

    // 检查是否选择了服务器
    if (!config.selectedServerId) {
      throw new Error('No server selected');
    }

    // 查找选中的服务器（'__direct__' 哨兵=全局直连，无真实节点，跳过存在性校验）
    const isDirect = isDirectSelection(config.selectedServerId);
    const selectedServer = isDirect
      ? undefined
      : config.servers.find((s) => s.id === config.selectedServerId);
    if (!isDirect && !selectedServer) {
      throw new Error('Selected server not found');
    }

    // 3. 准备规则文件（必须在生成配置前完成）
    await this.copyRuleSetsToUserData();
    // 3.1 落盘外化自定义规则文件 + 孤儿对账清扫（必须在 generateSingBoxConfig 前——缺文件 sing-box 启动 FATAL）
    await this.writeCustomRuleFiles(config);

    // 3.5. 预解析所有节点的域名为 IP（仅针对 TUN 模式），防止 Windows 下回流死循环
    // 【待真机验证 / CDN 风险】：对"域名节点"预解析得到的 IP 会进 route_exclude_address，若节点在
    //   共享 CDN(如 Cloudflare) 后，等于把共享 IP 加直连 → 误伤同 IP 的被墙站点、且抗不住 IP 轮换。
    //   现已在 generateRouteConfig 用"全节点域名 → direct"的纯域名规则(sniff SNI)做 CDN 安全豁免；
    //   此处 Windows IP 预解析是否仍为断环所必需，需 Wintun 真机验证：若域名规则+sniff 足够 → 删除本块；
    //   若 Windows 确需 IP 级兜底 → 应仅对 IP-literal 节点保留、域名节点不预解析。无 Windows 环境暂不擅改。
    const resolvedServerIps: Record<string, string> = {};
    if (isTunMode && process.platform === 'win32') {
      this.logToManager('info', '正在预解析节点域名以防止 TUN 回流...');
      const dns = require('dns').promises;
      const allServerIds = new Set([
        config.selectedServerId as string,
        ...effectiveAppRules(config).map((r) => r.targetServerId),
      ]);

      const resolvePromises = Array.from(allServerIds).map(async (serverId) => {
        if (!serverId) return;
        const server = config.servers.find((s) => s.id === serverId);
        if (
          server?.address &&
          !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(server.address) &&
          !server.address.includes(':')
        ) {
          try {
            const { address } = await dns.lookup(server.address);
            if (address) {
              resolvedServerIps[serverId] = address;
            }
          } catch {
            /* ignore */
          }
        }
      });
      await Promise.all(resolvePromises);
    }

    // 3.6. 为出口 IP 探针分配端口（失败不阻断启动，仅探针不可用）
    await this.allocateProbePorts(config);

    // 3.7. 复位启动前配置校验 gate 状态（必须在 generateSingBoxConfig→generateOutbounds 消费 gateInvalidNodes
    //      之前）：每次 start 重新判定坏节点，换核 / 修好配置后自动复活，不跨会话残留。
    this.gateInvalidNodes.clear();
    this.refFixAttempted = false;
    this.cronetHealAttempted = false; // T2：每次 start 复位 cronet 自愈一次性闸（换核/修好后可再触发一次）

    // 3.7.1 根治跨提权态 state 属主冲突：本次以登录用户(非提权)跑 sing-box 前，归一 tailscale state 属主——
    //   删掉上次 TUN(root/SYSTEM)跑残留的 root 600 文件，让 tsnet 以登录用户重建。否则 sing-box 以登录用户
    //   open 不了 root 600 的 tailscaled.* → endpoint post-start `permission denied` → 拖垮**整个**启动
    //   （即便没选 tailscale 节点，它在 endpoints[] 里也会被 post-start；系统代理模式同样中招）。
    this.reconcileRuntimeOwnershipBeforeStart();

    // 3.8 方案B：DNS 接管激活时,先读接管前的内网 LAN 解析器(私网 IPv4),供 generateDnsConfig 把内网/captive 域名
    //     重定向到它(takeover 把系统 DNS 改公网 8.8.8.8 后 dns-local 解不了内网/可能环)。必须在 generateSingBoxConfig
    //     之前读(此刻系统 DNS 尚未被 setDns 改写,scutil/netsh 反映的仍是 LAN 解析器)。无可用→null→退回 dns-local。
    this.lanResolverForDns = null;
    if (config.proxyModeType === 'tun' && config.dnsConfig?.takeoverSystemDns !== false) {
      this.lanResolverForDns =
        (await this.systemDnsManager?.getLanResolverForDns().catch(() => null)) ?? null;
      if (this.lanResolverForDns) {
        this.logToManager(
          'info',
          `DNS 接管：内网/captive 域名将经原 LAN 解析器 ${this.lanResolverForDns} 解析`
        );
      }
    }

    // 3.9 issue #147：节点 outbound.server 恒用域名（buildProxyOutbound）→ 内核 resolveDialer 运行时解析多 A →
    //     DialSerial 逐 IP 重试（取代旧 resolve-ahead 烧单 IP，那会关闭内核多 IP 容错，见设计 §1.1）。多上游 race
    //     的本地 server 起停 + effective config 降级见下（startNodeDnsRaceServer）。
    await this.startNodeDnsRaceServer(config);

    // 4. 生成 sing-box 配置文件
    const singboxConfig = this.generateSingBoxConfig(config, resolvedServerIps);

    // 写入配置文件
    await this.writeSingBoxConfig(singboxConfig);
    this.logToManager('info', 'sing-box 配置文件已生成');

    // 4.5 启动前配置校验 gate：剔除会致整体启动 FATAL 的坏节点后重写盘（插在写盘后、retry 前 →
    //     gate 抛错由 start() catch 收口，不进 retry；选中节点被剔/全部剔光/降级 → throw 不启动）。
    await this.checkAndPruneConfig(singboxConfig, config);

    // TUN 模式下，删除旧的 PID 文件，确保不会读到旧的 PID
    if (this.needsOsascript() || this.needsWindowsUAC()) {
      await this.deletePidFile();
    }

    // 4.9 libcronet 启动前自愈（对称化）：linux/win 起内核前确保 cronet 在核心同目录、且与内置 bundle 大小一致
    //     （缺失/0 字节/截断/版本错位 → 从内置重拷）。覆盖 Windows 常规启动不补的盲区（Linux 既有 ensureWritableCore
    //     内的 beside 保留，此处对其幂等）；mac 静态编入 cronet，ensureCronetReadyForLaunch 内部跳过。热路径仅 stat。
    await this.ensureCronetReadyForLaunch();

    // issue #176 L1.2：快照本次起核世代——就绪/重试腿据此判 supersede 让位。捕获点在本方法上方内部 stop()
    //   （它会 lifecycleGeneration++）之后，故此值即本次 start 的稳定基线；之后任一外部 start/stop 接管即令其变化。
    const startGen = this.lifecycleGeneration;
    let readyRetries = 0; // 本次启动累计的就绪重试次数（onRetry 自增），成功后落 lastStartReadyRetries 供诊断。
    this.lastStartReadyRetries = 0;

    // 5. 启动 sing-box 进程（issue #159 的 wintun 适配器释放门控已下沉至 startSingBoxProcess 顶部，覆盖每次重试腿 + helper/UAC 两支路）
    const runStartWithRetry = (): Promise<void> =>
      retry(() => this.startSingBoxProcess(startGen), {
        maxRetries: 2,
        delay: 2000,
        exponentialBackoff: true,
        shouldRetry: (error) => {
          // issue #176：被更新的 start/stop 接管（CoreStartSupersededError）→ 绝不重试（接管方拥有生命周期）。
          if (error instanceof CoreStartSupersededError) {
            return false;
          }
          // 启动 gate 备用腿（补 check 盲区）：run 阶段 `dependency[X] not found` FATAL（detour/selector 幽灵
          // tag）→ 允许重试一次（onRetry 会解析 tag、pruneTagsClosure 修正重写盘），refFixAttempted 闸保证只修一次。
          if (/dependency\[(.+?)\] not found/i.test(error.message)) {
            return !this.refFixAttempted;
          }
          // libcronet 缺库 FATAL：内层裸重试无意义（库还是坏的）→ 不重试，交由外层 cronet 自愈闭环 strong 重拷后整体重启一次。
          if (this.isCronetLibError(error.message)) {
            return false;
          }
          // 只对特定错误进行重试
          const message = error.message.toLowerCase();

          // 不重试的错误类型
          const nonRetryableErrors = [
            '找不到',
            '权限',
            'permission',
            'enoent',
            'eacces',
            'eperm',
            '配置文件格式错误',
            'invalid config',
          ];

          // 如果是不可重试的错误，直接失败
          if (nonRetryableErrors.some((pattern) => message.includes(pattern))) {
            return false;
          }

          // 其他错误可以重试
          return true;
        },
        onRetry: (error, attempt) => {
          readyRetries = attempt; // issue #176 诊断：累计就绪重试次数
          // issue #176：软化文案——多数是「起核较慢/争用」而非真失败，避免「启动失败」吓到用户（#176 即因此报 bug）。
          this.logToManager(
            'warn',
            `sing-box 起核较慢，正在自动重试（第 ${attempt} 次）: ${error.message}`
          );
          // 端口被占（含探针端口在 osascript 授权窗口内被抢占）→ 重分配探针端口并重写配置（review P1-4）。
          // retry 在 onRetry 后有 2s+ 退避，足够这段 ms 级异步完成。
          if (/address already in use|in use|bind|eaddrinuse/i.test(error.message)) {
            void (async () => {
              try {
                await this.allocateProbePorts(config);
                // T9：用已 prune 的 singboxConfig（捕获 startInternal :746 外层变量），不重新 generateSingBoxConfig
                //     ——否则会丢掉 :754 checkAndPruneConfig 已就地剔除的坏节点，导致坏节点回流重撞 FATAL。
                //     仅把新探针端口回填到对应 inbound.listen_port（allocateProbePorts 只改 this.probe*Port 字段，
                //     不改 singboxConfig 对象；不回填则 sing-box 仍 bind 旧冲突端口）。
                for (const ib of singboxConfig.inbounds) {
                  if (ib.tag === 'probe-direct-in' && this.probeDirectPort) {
                    ib.listen_port = this.probeDirectPort;
                  } else if (ib.tag === 'probe-proxy-in' && this.probeProxyPort) {
                    ib.listen_port = this.probeProxyPort;
                  }
                }
                await this.writeSingBoxConfig(singboxConfig);
              } catch {
                /* 忽略：下次尝试用现有配置 */
              }
            })();
          }
          // 启动 gate 备用腿：run 阶段 `dependency[X] not found` → 解析幽灵 tag、pruneTagsClosure 修正重写盘，
          // 只修一次（refFixAttempted 闸）。tag 经 idToTagMap 进 gateInvalidNodes，下次 generateSingBoxConfig 跳过。
          const depMatch = /dependency\[(.+?)\] not found/i.exec(error.message);
          if (depMatch && !this.refFixAttempted) {
            this.refFixAttempted = true;
            void (async () => {
              try {
                const cfg = this.generateSingBoxConfig(config, resolvedServerIps);
                this.pruneTagsClosure(cfg, config, new Set([depMatch[1]]), 'detour');
                await this.writeSingBoxConfig(cfg);
                this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_INVALID_NODES, [
                  ...this.gateInvalidNodes.values(),
                ]);
              } catch (e) {
                this.logToManager(
                  'warn',
                  `启动 gate 引用修正失败（将按现有配置重试）: ${(e as Error)?.message ?? e}`
                );
              }
            })();
          }
        },
      });

    // T2 libcronet 启动失败冷路径闭环：起核失败且命中 cronet 缺库 FATAL（linux/win）→ strong（hash 强校验）
    // 重拷 → 若 restored 则整体重启内核一次（一次性 cronetHealAttempted 闸，防抖动循环）→ 仍失败/未恢复 →
    // 抛原错误（带可读文案，由 start() 收口落终态），不再重试。mac 无独立库不进此分支。
    try {
      await runStartWithRetry();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.cronetHealAttempted && this.isCronetLibError(msg)) {
        this.cronetHealAttempted = true;
        this.cronetHealTriggeredCount++;
        const loadDir = path.dirname(this.getSingBoxPath());
        this.logToManager(
          'warn',
          `内核启动失败疑因 libcronet 缺失/损坏，正在强校验自愈（hash）后重启一次: ${msg}`
        );
        const heal = await resourceManager.ensureCronetHealthy(loadDir, { strong: true });
        if (heal.action === 'restored') {
          this.logToManager('info', `libcronet 已从内置恢复，重启内核一次...`);
          try {
            await runStartWithRetry();
          } catch (e) {
            // 重拷成功但重启仍失败（库与核版本不匹配等）→ 计失败数（否则诊断「触发但最终失败」漏计），抛出由 start() 收口。
            this.cronetHealFailedCount++;
            throw e;
          }
        } else {
          // 未恢复（拷贝失败/无内置库）→ 计失败数 + 抛原错误（含 cronet 文案，UI 引导改协议/查权限）。
          this.cronetHealFailedCount++;
          throw err;
        }
      } else {
        throw err;
      }
    }

    // issue #176 诊断：起核成功（含经数次就绪重试）。落 lastStartReadyRetries，>0 时记一行——便于把「争用下起得慢
    //   但已自愈」与「核崩溃自动重启」（restartCount/AUTO_RESTARTING 另一轴）在诊断里区分开。
    this.lastStartReadyRetries = readyRetries;
    if (readyRetries > 0) {
      this.logToManager('info', `sing-box 经 ${readyRetries} 次就绪重试后启动成功`);
    }

    // 系统代理单一写者收口（拆双轨）：systemProxy 模式 → 置系统代理（marker + 防自指在 SystemProxyManager 内，
    // 杜绝把自己当原始保存致 disable restore 死端口）；TUN/manual 模式 → 反向清掉可能残留的系统代理
    // （覆盖「切接管方式 systemProxy→TUN 经 switchMode 去抖重启」这条不经 IPC handler 的路径）。
    // best-effort：networksetup/reg 失败仅告警不阻断启动（enableProxy 内含重试 + 失败回滚 + 清 marker）。
    try {
      if (config.proxyModeType === 'systemProxy') {
        await this.systemProxyManager?.enableProxy(
          '127.0.0.1',
          localProxyPort(config), // mixed-only：HTTP 与 SOCKS 同口（mac 三代理同口、win 仅 http）
          localProxyPort(config),
          // 系统代理「忽略列表」= 绕过局域网完整清单（CIDR+域名），受 bypassLAN 开关管理（单一真值 effectiveBypassLan）。
          effectiveBypassLan(config)
        );
      } else {
        await this.ensureSystemProxyCleared();
        // 仅 TUN：清掉 FlowZ 自己的(marker)系统代理后，若仍有系统代理开着 = 无 marker 残留(外部/他软件/丢 marker)。
        // TUN 下它会截走代理感知 app 的流量致连接异常；direct/manual 模式不接管路由，残留是用户自己的事，不提示。
        // 不自动清(7890 等业内共用端口、无法证明归属，自动清会误伤别的代理软件)→ 一次性提示，交用户决定。
        if (config.proxyModeType === 'tun') await this.adviseIfResidualSystemProxy();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logToManager('warn', `系统代理状态同步失败: ${msg}`);
      // 非致命：核心已起但系统代理没设上 → UI 会显示「已连接」而流量实未走代理。发一条非终态提示告知用户
      // （enableProxy 内部已 fail-closed 关掉半残留，不会留死端口），避免「显示连上、实际没代理」的静默不一致（L-4）。
      if (config.proxyModeType === 'systemProxy') {
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: `系统代理设置失败：${msg}。核心已启动但流量可能未走代理，请检查系统网络权限后重试。`,
          errorCode: ProxyErrorCode.SYSTEM_PROXY_FAILED,
          code: -3,
        });
      }
    }

    // 系统 DNS 接管收口（治本 DNS，与系统代理 reconcile 正交）：仅 TUN 模式接管——on-link 的 LAN/ISP DNS 不进
    // TUN → hijack-dns 看不到 → 需代理的域名被系统解析器解析成真实/错族 IP。故 TUN 启动把系统 DNS 改为受控、
    // 可路由、不在 bootstrap-direct 的 8.8.8.8，使其经 TUN 被 hijack（真进 sing-box → FakeIP/远程解析）。
    // systemProxy/manual 模式不接管 DNS（系统代理走远程解析）→ 反向还原可能残留（覆盖 TUN→其它模式切换）。
    // best-effort：setDns 内部失败仅告警 + 回滚，绝不抛、不阻断 TUN 启动。
    try {
      if (config.proxyModeType === 'tun' && config.dnsConfig?.takeoverSystemDns !== false) {
        await this.systemDnsManager?.setDns();
        // 接管成功 → 起热插重灌 watcher（探链路变化/唤醒 → 去抖 reconcile 补接管换网/新服务）。仅 darwin 真起，
        // best-effort：起失败不阻断 TUN 启动（watcher 失效 ≠ 接管失效，已接管服务仍受控）。
        this.startDnsInterfaceWatcher();
      } else {
        // 非 TUN / 用户关掉接管开关 → 停 watcher（若在）+ 还原可能残留的受控 DNS（覆盖 TUN→其它模式切换、开→关切换）。
        this.stopDnsInterfaceWatcher();
        await this.ensureSystemDnsRestored();
      }
    } catch (e) {
      this.logToManager(
        'warn',
        `系统 DNS 接管状态同步失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // sing-box 1.14 管理 API：核起后连 api service 订阅 Tailscale 状态（断线重连，随主核生命周期）。
    if (this.hasManagementApi()) {
      this.tailscaleApiClient?.stop();
      // 修复（P0）：api service 注入了 secret（= clashApiSecret）→ 每个 RPC 须带 Bearer，否则真机被拒认证。
      // 客户端接收 secret 经 call credentials 注入 Bearer；空串退化免认证。endpoint host 为 Phase 2 远程预留（本地恒 127.0.0.1）。
      this.tailscaleApiClient = new SingBoxApiClient(
        { host: '127.0.0.1', port: this.tailscaleApiPort },
        config.clashApiSecret || '',
        (eps) => this.handleTailscaleStatus(eps)
      );
      this.tailscaleApiClient.start();
      // 修复（首页 stats 全 0 根因）：emit('started')（startViaHelper:3209，在 729 的 runStartWithRetry 内）早于此处
      // api client 创建约 100 行/0.5s，故 'started' 监听器同步调的 statsService.resubscribe() 拿到 null client 早退、
      // Status/Connections 订阅从未发起、且无 client 就绪后的二次重订。此处 client 已就绪（崩溃自动重启亦走 startInternal
      // 同路径到此），再发一事件让 index.ts 补一次 resubscribe，使订阅在 client 真正可用后发起。
      this.emit('api-client-ready');

      // H3 修复：sing-box 的 cache_file 持久化 selector 旧选择、重启后覆盖 config default。故启动后用管理 API 把
      // selector 校正回 config.selectedServerId，让 FlowZ 配置成单一真值、压过缓存。**必须在 client 创建后调**
      // （reassertSelectorSelection 的 `if(!client)break` 在 client=null 直接放弃不重试）——原在 client 前调用致首启
      // cache 与 config 不一致时「选 X 实际走上次出口」(出口混乱)。best-effort（不阻塞启动成功）。
      // 时序修（E）：flush 链到 reassert 完成后。reassert（≤3s，管理 API 慢时）若晚于独立的 scheduleConnectionFlush
      // （内部 1500ms），flush 的 CloseAllConnections 会按 cache_file 旧 selector 重连 → 出口混乱在窄窗复现。改为
      // .finally() 串接：reassert 把 selector 校正回 config 后才安排 flush，使 flush 的重连走的是正确出口。
      // reassert 仍 best-effort、不阻塞 start（链在 void promise 上，scheduleConnectionFlush 自身另有 1500ms 延时 +
      // 世代 token 守卫，被 stop/重启接管即放弃）。flush 绝不丢：reassert 成功或异常 finally 都会安排。
      void this.reassertSelectorSelection(config).finally(() =>
        this.scheduleConnectionFlush(config)
      );
    } else {
      // 无管理 API（版本 <1.14）：无 reassert 可链，直接安排 flush（与原行为一致）。
      // P2a：启用代理 / 切接管模式后延迟一次连接 flush（见 scheduleConnectionFlush）——RST 泄漏成真实 IP 的旧连接
      // 逼其重连重解析（经 FakeIP 走代理），不重启内核；node 热切换不经 startInternal、由 interrupt 开关另管。
      this.scheduleConnectionFlush(config);
    }
  }

  /**
   * 启动后把各 selector 选择校正回用户意图（压过 cache_file 持久化的旧选择，修 H3）：
   *  - proxy-selector → currentConfig.selectedServerId（启动窗口内用户热切则跟随最新）。
   *  - 各 rule-sel-<id> → currentConfig 中对应规则的 targetServerId（防 cache_file 把规则选择回弹到旧节点）。
   * best-effort + 短重试，管理 API 刚起可能未就绪；失败不影响启动（cache/default 仍是有效节点）。
   * proxy-selector 成功后再 reassert rule-sel（管理 API 已就绪，rule-sel 通常首轮即成）。
   */
  private async reassertSelectorSelection(config: UserConfig): Promise<void> {
    // 阶段 1：proxy-selector（带重试，等管理 API 就绪）
    for (let i = 0; i < 10; i++) {
      if (!this.singboxProcess && !this.singboxPid) return; // 已停止则放弃
      if (this.stopping) return; // 主动停止/重启中：勿在杀核窗口里重连管理 API（核将死）
      // 每轮读最新 currentConfig.selectedServerId：若启动窗口内用户已热切到别的节点，则用新节点、
      // 不要把它 revert 回启动时的旧节点。
      const targetId = this.currentConfig?.selectedServerId ?? config.selectedServerId;
      const tag = this.currentIdToTagMap?.get(targetId as string);
      if (!tag) break;
      const client = this.tailscaleApiClient;
      if (!client) break; // 管理 API 客户端未创建（核未起/无管理 API）→ 放弃，cache/default 兜底
      try {
        // gRPC SelectOutbound throws on error（与 clash_api 的 {ok,status} 不同）：成功即跳出，异常进重试腿。
        await client.selectOutbound('proxy-selector', tag);
        break;
      } catch {
        // 管理 API 未就绪/瞬时失败 → 短延迟后重试
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    // 阶段 2：各 rule-sel（无重试——proxy-selector 已就绪证管理 API 可用；失败由 cache/default 兜底）
    await this.reassertRuleSelectors(config);
  }

  /**
   * 重载后 reassert 各 rule-sel 选择：按 currentConfig 的规则 targetServerId 重新 PUT（启动窗口内用户热切规则
   * 目标的话 currentConfig 反映最新意图）。恒优化后无 targetServerId 的 proxy 规则也生成 rule-sel（default=
   * proxy-selector 跟全局，嵌套），但 sing-box 重载不擦 selector default、默认值靠生成时正确指向 + 嵌套跟随全局，
   * 故本函数仍只 reassert 有 targetServerId 者（下方 put/循环 `!targetServerId continue` skip 无 target 者正合此语义）。
   */
  private async reassertRuleSelectors(config: UserConfig): Promise<void> {
    const map = this.currentRuleTargetMap;
    const idToTag = this.currentIdToTagMap;
    const cur = this.currentConfig ?? config;
    if (!map || !idToTag) return;

    const put = (ruleKey: string, targetServerId: string | undefined) => {
      if (!targetServerId) return;
      const entry = map.get(ruleKey);
      if (!entry) return;
      const memberTag = idToTag.get(targetServerId);
      if (!memberTag) return; // 目标被 gate 剔除/不存在 → 跳过（selector default 仍有效，不 FATAL）
      // gRPC SelectOutbound throws on error；best-effort fire-and-forget（失败由 cache/default 兜底，不阻塞）。
      void this.tailscaleApiClient?.selectOutbound(entry.selectorTag, memberTag).catch(() => {});
    };

    for (const rule of cur.customRules || []) {
      if (!rule.enabled || rule.action !== 'proxy' || !rule.targetServerId) continue;
      put(`custom:${rule.id}`, rule.targetServerId);
    }
    for (const appRule of cur.appRules || []) {
      if (!appRule.enabled || appRule.action !== 'proxy' || !appRule.targetServerId) continue;
      put(`app:${appRule.appId}`, appRule.targetServerId);
    }
  }

  /**
   * 停止代理。issue #176 单飞外壳：begin/end 包住全程（含内部早退），令在飞期到来的去抖重启置待决而非并发；
   * 真实停止逻辑在 stopInner。stop 是终态 → endLifecycleOp('stop') 在回到 idle 时丢弃待决重启（停止优先）。
   */
  async stop(opts?: { quitting?: boolean }): Promise<void> {
    this.beginLifecycleOp();
    try {
      await this.stopInner(opts);
    } finally {
      this.endLifecycleOp('stop');
    }
  }

  private async stopInner(opts?: { quitting?: boolean }): Promise<void> {
    // Phase 2：停止/退出语境一并杀掉残留的瞬态登录核（无孤儿进程）。放早退之前——列表直接点登录时
    // 主核未运行，下方 `!singboxProcess && !singboxPid` 会早退，故在此先收瞬态核。
    this.killAllTailscaleLoginCores();
    // issue #147：本地 race DNS server 随核停（绑主核生命周期）。
    this.nodeDnsRaceServer.stop();
    this.raceServerPort = 0;
    this.raceUpstreamIps = [];
    // 1.14 管理 API 客户端随核停（停订阅 + 关连接）。
    this.tailscaleApiClient?.stop();
    this.tailscaleApiClient = null;
    // 生命周期世代 +1：标记一次停止接管（退避中的 attemptAutoRestart 比对到变化即让位，M-2′/L-1′）。
    this.lifecycleGeneration++;
    // 取消未决的去抖重启（停止/退出优先于 trailing 重启，避免停了又被自动拉起）
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
    // 取消未决的连接 flush（停止/重启优先；flush 只对仍在跑的本世代核有意义）
    if (this.connectionFlushTimer) {
      clearTimeout(this.connectionFlushTimer);
      this.connectionFlushTimer = null;
    }
    // 停 DNS 接口 watcher（停止/切模式/重启 stop 腿统一入口）：杀 route monitor 子进程 + 反注册 resume + 取消在飞去抖。
    // 切模式重启时这里先停，紧随的 start() 会按新模式重判是否重起（TUN→重起 / 其它→保持停），零打架。best-effort 不抛。
    this.stopDnsInterfaceWatcher();
    // 用户意图优先：取消可能在退避窗口内待发的自动重启（崩溃后进程已死、refs 均 null 会触发下面的早退，
    // 但 attemptAutoRestart 仍在退避中——退避期 isRestarting=true，故这里能拦下，M3）。
    // 条件置位（含 isRestarting）：避免 start() 启动窗口内（已过复位点、refs 尚未就绪、isRestarting=false）
    // 的一次「无可停止」stop() 把标记毒化为 true → 本会话此后所有崩溃自动重启被静默废掉（M-A 回归防护）。
    if (this.singboxProcess || this.singboxPid || this.isRestarting) {
      this.autoRestartAborted = true;
    }
    // macOS TUN 模式：即使 singboxProcess 为 null，也可能有后台进程在运行
    if (!this.singboxProcess && !this.singboxPid) {
      return;
    }

    // stopping 标记「主动停止/重启中」：stopSingBoxProcess 的 SIGTERM 会触发 handleProcessExit 信号死分支
    // → emit('stopped') → index 监听器调 ensureSystemProxyCleared。若不区分，会在「重启 stop 腿」就把系统代理清掉，
    // 与紧随的 start() reconcile enable 并发打架（C1 竞态）。置位后 ensureSystemProxyCleared 直接跳过：
    //  - 用户主动停止 → IPC PROXY_STOP / 托盘 onStop 已在 stop() 前置调 ensureSystemProxyCleared（stopping 仍 false）清掉
    //  - 切模式 / 重启 → 后继 start() 按新模式 reconcile（systemProxy→enable / TUN→clear）
    //  - 真·外部死亡（非本 stop 触发）→ stopping=false → 信号死分支正常清
    //  - 退出 → cleanupResources（marker 门控）/ disableProxySync 兜底
    this.stopping = true;
    try {
      await this.stopSingBoxProcess(opts);
      // 进程已停 → 清掉旧的 id→tag 映射，防止对一个已不存在的 selector 误发 clash_api 切换
      this.currentIdToTagMap = null;
      this.currentRuleTargetMap = null;
    } finally {
      this.stopping = false;
    }
  }

  /**
   * 退出语境的总拆除：停当前会话代理（quitting=跳过交互式提权弹框）+ macOS 经 root helper
   * 回收托管/孤儿 sing-box。幂等、best-effort —— 覆盖 stop() 早退够不到的「跨会话孤儿 / 隐藏会话残留」。
   * helper socket 不存在（未装）时 stopCore/cleanup 快速失败（ENOENT），无额外延迟、不弹框。
   */
  async teardownForQuit(): Promise<void> {
    try {
      await this.stop({ quitting: true });
    } catch (e) {
      this.logToManager('warn', `退出停止代理失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (process.platform === 'darwin') {
      // sing-box 由 root helper 托管（非 GUI 子进程）→ 显式让 helper 停 child + 扫孤儿（覆盖跨会话残留）。
      try {
        this.helperManager ??= new HelperManager();
        await this.helperManager.stopCore();
        await this.helperManager.cleanup();
      } catch {
        /* best-effort：退出兜底，失败不阻塞退出 */
      }
    } else if (process.platform === 'win32' && this.helperManager) {
      // Windows：sing-box 由 LocalSystem 服务托管 → 同样让服务停 child + 扫孤儿。用注入的 WindowsServiceHelper
      // （不实例化 macOS 的 HelperManager）；未装/未就绪则 stopCore/cleanup 经管道 ENOENT 快速失败，无额外延迟。
      try {
        await this.helperManager.stopCore();
        await this.helperManager.cleanup();
      } catch {
        /* best-effort：退出兜底，失败不阻塞退出 */
      }
    }
  }

  /**
   * issue #159：Windows TUN 起核前，等上一轮自家 wintun 适配器（按 resolveWinTunInterfaceName 取名）真正释放。
   * 只认本名网卡 → 不误等外部 sing-box / 用户手动核 / 自家孤儿核的同址 tun0。已释放或超时(fail-open)均放行，
   * 绝不卡死代理（残留由 runStartWithRetry 兜底）。仅由 startInternal 在 win32 && TUN 时调用。
   */
  private async waitForOwnTunAdapterReleased(config: UserConfig): Promise<void> {
    const name = resolveWinTunInterfaceName(config);
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const { released, polls } = await waitForAdapterReleased(
      name,
      {
        timeoutMs: ProxyManager.TUN_ADAPTER_RELEASE_TIMEOUT_MS,
        pollMs: ProxyManager.TUN_ADAPTER_RELEASE_POLL_MS,
      },
      { probe: (n) => this.adapterProbe(n), sleep }
    ).catch(() => ({ released: false, polls: 0 }));
    if (released) {
      // 仅在确实等过（>1 次探测）才记一行，避免无残留时刷无意义日志。
      if (polls > 1) this.logToManager('info', `Windows TUN 适配器 ${name} 已释放，继续启动`);
    } else {
      this.logToManager(
        'warn',
        `Windows TUN 适配器 ${name} 释放等待超时，仍继续启动（如起核失败将自动重试）`
      );
    }
  }

  /**
   * macOS 提权 helper 引导门控（收敛单点，唯一弹窗实现）。所有 start/restart 入口（开启代理按钮/托盘/
   * 切接管/CONFIG_CHANGED 重启/换节点回退重启…）汇入此处；仅 interactive 启动 + darwin + TUN +
   * helper 未就绪 + 用户未 dismiss 时，经注入回调弹 native 引导（无窗口依赖）；回调返回 'abort' → 抛
   * HELPER_GATE_ABORTED 终止启动（终态等价 osascript 取消=停止态）。崩溃自动重启(interactive:false) 跳过。
   * 注：ready 但 pathMismatch（socket 通但 plist 路径失效）必须进 gate（否则 startViaHelper 会失败→裸弹 osascript）。
   */
  private async maybePromptHelperGate(
    config: UserConfig,
    isTunMode: boolean,
    options: { interactive?: boolean }
  ): Promise<void> {
    if (options.interactive === false) return; // 崩溃自动重启等：禁模态
    if ((process.platform !== 'darwin' && process.platform !== 'win32') || !isTunMode) return; // 非 macOS/Windows / 非 TUN：systemProxy 绝不弹
    if (!this.helperManager || !this.helperGate) return;
    const hs = await this.helperManager.getStatus().catch(() => null);
    // 关键：backgroundDisabled 时**即便 ready 也不能早退**——install-over-top 让 daemon 在跑(ready=true)但 BTM
    // 开关仍关（disposition allowed 位缺），必须进 gate 提示用户去系统设置手动开启（修 Bug2：原 `ready→return` 把
    // 混合态直接放过，用户永远收不到引导）。getStatus 已直读 disposition 判 backgroundDisabled（无需去抖）。
    if (!hs || (hs.ready && !hs.pathMismatch && !hs.backgroundDisabled)) return;
    if (!(hs.backgroundDisabled || hs.needsRepair || !hs.installed)) return;
    // 尊重「不再提示」（needsRepair=路径不符 不可 dismiss）
    const dismissed = hs.backgroundDisabled
      ? config.helperDisabledPromptDismissed === true
      : !hs.installed
        ? config.helperPromptDismissed === true
        : false;
    if (dismissed) return; // 静默落 osascript（与今天 dismissed 行为一致）
    const decision = await this.helperGate(hs, config).catch(() => 'proceed' as const);
    if (decision === 'abort') {
      const err = new Error('用户取消了提权助手引导') as Error & { code?: string };
      err.code = 'HELPER_GATE_ABORTED';
      throw err;
    }
  }

  /**
   * 重启代理
   */
  async restart(config: UserConfig, options: { interactive?: boolean } = {}): Promise<void> {
    this.beginLifecycleOp();
    try {
      await this.stop();
      // start 腿失败的系统代理清理已下沉进 start() 的 public 包装（L-2′），此处无需再 catch。
      await this.start(config, options);
    } finally {
      this.endLifecycleOp('restart');
    }
  }

  /**
   * issue #176 单飞：进入一次 lifecycle 操作（start/stop/restart）。与 endLifecycleOp 成对（try/finally）。
   * lifecycleDepth 是重入计数：restart 内嵌 stop/start 时 depth 会到 2，确保 restart 全程 depth≥1（无 0 缝隙让
   * 去抖 timer 钻进来并发起第二条）。
   */
  private beginLifecycleOp(): void {
    this.lifecycleDepth++;
  }

  /**
   * issue #176 单飞：退出一次 lifecycle 操作。仅在回到 idle（depth 0）时处理待决重启：
   * - kind='stop'（终态停止：用户断开 / 切模式停止腿外）→ 丢弃 restartPending（停止优先，避免停了又被排空拉起；
   *   与 stop() 内既有「取消未决去抖 timer」对称）。
   * - kind='start'/'restart' 收尾 → 有 restartPending 则排空一次尾随重启（吃最新 currentConfig）。
   * depth>0（仍在更外层操作内，如 restart 内嵌的 stop/start）→ 不处理，留给最外层那次。
   */
  private endLifecycleOp(kind: 'start' | 'stop' | 'restart'): void {
    this.lifecycleDepth = Math.max(0, this.lifecycleDepth - 1);
    if (this.lifecycleDepth > 0) return;
    if (kind === 'stop') {
      this.restartPending = false;
      return;
    }
    if (this.restartPending) {
      this.restartPending = false;
      this.scheduleDebouncedRestart();
    }
  }

  /**
   * 去抖重启：连改多条配置合并为一次重启。trailing 触发时取最新 this.currentConfig（调用方须已更新它），
   * 故窗口内的后续切节点(hotSwitch)/no-op/再次结构变更都会被最终那次重启自然纳入。stop()/quit 取消未决重启。
   *
   * issue #176 单飞：trailing 触发时若有 lifecycle 操作在飞（lifecycleDepth>0，如上一条重启的 start 还在就绪等待），
   * **不并发起第二条**（那正是「就绪等待中又来重启」叠加 stop/超时/restart 互踩的风暴根因），只置 restartPending；
   * 待在飞操作 settle 回 depth 0 时由 endLifecycleOp 排空一次。
   */
  private scheduleDebouncedRestart(): void {
    if (this.restartDebounceTimer) clearTimeout(this.restartDebounceTimer);
    this.restartDebounceTimer = setTimeout(() => {
      this.restartDebounceTimer = null;
      // 窗口内可能已被 stop()/quit 清掉：仅在仍运行时重启
      if (!this.singboxProcess && !this.singboxPid) return;
      const cfg = this.currentConfig;
      if (!cfg) return;
      // issue #176 单飞：有 start/stop/restart 在飞 → 不并发，置待决，由 endLifecycleOp 在 depth 归 0 时排空。
      if (this.lifecycleDepth > 0) {
        this.restartPending = true;
        return;
      }
      // helper gate abort / 其它错误内部消化（终态=停止），防 timer 回调 unhandled rejection
      void this.restart(cfg).catch((e) => {
        this.logToManager('warn', `去抖重启结束: ${e instanceof Error ? e.message : String(e)}`);
        // 去抖重启失败 → sing-box 未拉起，终态清掉曾指向我们的系统代理，避免死端口致全网断（marker 门控、幂等）。
        void this.ensureSystemProxyCleared();
      });
    }, ProxyManager.RESTART_DEBOUNCE_MS);
  }

  /** 启用/切接管模式后延迟一次连接 flush 的延时（ms）：给 app 早于 TUN 建立的旧连接经 TUN 重新进入 sing-box 连接表的窗口。 */
  private static readonly CONNECTION_FLUSH_DELAY_MS = 1500;

  /**
   * 启用代理 / 切接管模式后（两者均经 startInternal；node 热切换走管理 API SelectOutbound 不经此路径）延迟一次
   * 管理 API `CloseAllConnections`，RST 掉 sing-box 跟踪的连接——重点是 app 早于 TUN 建立、泄漏成真实 IP
   * 的旧连接：它们的后续包经 TUN 重新进表后被 RST → app 重连 → DNS 重新经 FakeIP 反查 → 走代理。
   * **不重启内核**（与「切节点」的 interrupt_exist_connections 开关正交）。仅 TUN：systemProxy 的旧连接多在
   * sing-box 表外、flush 够不着，且会误伤已代理连接。
   * 取舍：closeAll 无差别 RST，也会重置启用后用户新建的正确连接（app 自动重连、短暂抖动）——属「启用即断开
   * 现有连接」的固有代价，取单次短窗口最小化误伤。延迟/有效性属 runtime 语义，真机抓包定论后再定最终形态。
   */
  private scheduleConnectionFlush(config: UserConfig): void {
    if (config.proxyModeType !== 'tun') return;
    if (this.connectionFlushTimer) clearTimeout(this.connectionFlushTimer);
    const gen = this.lifecycleGeneration; // 世代 token：窗口内被 stop/重启接管则放弃，避免打到已换的核
    this.connectionFlushTimer = setTimeout(() => {
      this.connectionFlushTimer = null;
      if (gen !== this.lifecycleGeneration) return; // 已被新的 start/stop 接管
      if (!this.singboxProcess && !this.singboxPid) return; // 核已停
      // gRPC CloseAllConnections throws on error；best-effort（与启用流程正交，失败仅记日志）。
      void this.tailscaleApiClient
        ?.closeAllConnections()
        .then(() =>
          this.logToManager('info', '启用后连接 flush：管理 API CloseAllConnections → ok')
        )
        .catch((e) =>
          this.logToManager(
            'info',
            `启用后连接 flush：管理 API CloseAllConnections 失败(${(e as Error)?.message ?? e})`
          )
        );
    }, ProxyManager.CONNECTION_FLUSH_DELAY_MS);
  }

  /**
   * 启动期落盘外化规则文件 + 孤儿对账清扫（start() 在 generateSingBoxConfig 前调用）。
   * 函数头先清降级标记；① mkdir；② 删孤儿（custom-rule-*(.tmp) 但不在期望集——删规则/禁用/转 inline/
   * 改 id/direct 切换的遗留）；③ 期望集全量写（仅内容变化的原子写）。逐文件写失败 → 删旧副本 + 置降级标记
   * （缺文件触发 generateCustomRules inline 降级，用内存态值），仅 warn 不抛。
   */
  private async writeCustomRuleFiles(config: UserConfig): Promise<void> {
    const dir = getCustomRulesDir();
    const expected = buildCustomRuleFiles(config); // fileName → JSON
    this.customRuleFilesDegraded = false;
    try {
      await fs.mkdir(dir, { recursive: true });
      // 孤儿清扫（含 atomicWrite 可能残留的 .tmp）
      let existing: string[] = [];
      try {
        existing = await fs.readdir(dir);
      } catch {
        /* 目录刚建/读失败：无孤儿可清 */
      }
      for (const name of existing) {
        if (/^custom-rule-.+\.json(\.tmp)?$/.test(name) && !expected.has(name)) {
          await fs.unlink(path.join(dir, name)).catch(() => {});
        }
      }
      // 期望集落盘（内容未变跳过）。单文件写失败（EIO/磁盘满）→ 删旧副本，避免 sing-box 消费陈旧值：
      // 缺文件触发 generateCustomRules existsSync 降级走 inline（用内存态值，功能不损）+ 置 degraded 走重启兜底。
      for (const [name, content] of expected) {
        const filePath = path.join(dir, name);
        const cur = await fs.readFile(filePath, 'utf-8').catch(() => null);
        if (cur === content) continue;
        try {
          await this.atomicWrite(filePath, content);
        } catch (e) {
          await fs.unlink(filePath).catch(() => {});
          this.customRuleFilesDegraded = true;
          this.logToManager(
            'warn',
            `外化规则文件写失败，已删旧副本回退 inline: ${name} (${e instanceof Error ? e.message : String(e)})`
          );
        }
      }
    } catch (e) {
      this.customRuleFilesDegraded = true;
      this.logToManager(
        'warn',
        `落盘外化规则文件失败（回退 inline）: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * 运行中外化规则「值」热更：仅原子替换内容变化的文件（fswatch 热重载），**绝不删文件**
   *（运行中删被挂载文件会致 sing-box reload 报错；删除只在 start() 清扫）。写失败 → 去抖重启兜底。
   */
  private async syncCustomRuleFiles(config: UserConfig): Promise<void> {
    const dir = getCustomRulesDir();
    const expected = buildCustomRuleFiles(config);
    try {
      for (const [name, content] of expected) {
        const filePath = path.join(dir, name);
        const cur = await fs.readFile(filePath, 'utf-8').catch(() => null);
        if (cur === content) continue;
        await this.atomicWrite(filePath, content);
      }
    } catch (e) {
      this.logToManager(
        'warn',
        `热更外化规则文件失败，退回去抖重启: ${e instanceof Error ? e.message : String(e)}`
      );
      this.scheduleDebouncedRestart();
    }
  }

  /** 原子写：临时文件 + rename（与 RuleResourceManager 同形；rename-over 触发 sing-box fswatch 热重载）。 */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  }

  /**
   * 切换代理模式
   * 检测模式变化，如果代理正在运行则重启
   */
  async switchMode(newConfig: UserConfig): Promise<void> {
    // core-swap 手动轴门控：内核替换窗口中拒绝切模式/切节点——防 clash_api 打到半替换核、防重启式切换撞核。
    this.rejectIfCoreSwapInProgress('切换代理模式');
    // 代理未运行：只更新配置（下次 start 时按新配置生成）
    if (!this.singboxProcess && !this.singboxPid) {
      this.currentConfig = newConfig;
      return;
    }

    // clash_api 热切换（不重启 sing-box）：覆盖「切全局节点」「改规则目标节点」「两者同时」三类纯值变化。
    // planHotSwitch 产出需 PUT 的 selector 列表；任一 PUT 失败 → 退回去抖重启兜底（保证一定能应用）。
    // norm 已移出 selectedServerId/targetServerId → 仅这俩值变不翻转 norm → 可经此热切换路径。
    const plan = this.planHotSwitch(newConfig);
    if (plan.kind !== 'none') {
      let allOk = true;
      for (const p of plan.puts) {
        if (!(await this.hotSwitchSelector(p.selectorTag, p.memberTag))) {
          allOk = false;
          break;
        }
      }
      if (allOk) {
        this.currentConfig = newConfig;
        // L3：norm 排除了外化规则的值 → 「切节点 + 改外化规则值」同一次 save 会通过 planHotSwitch 检查，
        //   补一次文件对账防值静默丢失（通常零 diff、幂等）。降级态文件无消费者 → 改走重启重落盘（与 no-op 分支对称）。
        if (this.customRuleFilesDegraded) this.scheduleDebouncedRestart();
        else await this.syncCustomRuleFiles(newConfig);
        // 全局节点热切换出口（覆盖渲染端/托盘/自动换节点三条切节点路径）→ 通知重测代理出口 IP。
        // 纯规则目标热切换（kind=rules）不切换全局出口 IP，不发 node-hot-switched（避免无谓重测）。
        // 注意：所有切节点路径必须经 switchMode，否则代理 IP 会陈旧至手动刷新。
        // payload accountBased：切换后目标是否账号制（TS）节点。监听方据此选退避预算——TS 隧道（DERP/peer 握手、
        // 路由下发）需几秒才就绪，走常规预算（2×1000ms）会耗尽闪「暂不可用」，应改宽退避 refreshProxyPostConnect；
        // IP 类节点即起即通、不需宽退避。currentConfig 此刻已对账到 newConfig（上面刚赋值），反查即目标节点。
        if (plan.kind === 'global' || plan.kind === 'both') {
          const target = this.currentConfig?.servers.find(
            (s) => s.id === this.currentConfig?.selectedServerId
          );
          this.emit('node-hot-switched', isAccountBasedProtocol(target?.protocol));
        }
        return;
      }
      this.logToManager('warn', '热切换失败，退回重启式切换');
    }

    // 生成无关变更（仅 mainSessionViaProxy/ghProxyPrefix/订阅元数据/内置 geo 戳/未引用资源 等归一化字段，
    // 且节点未变、且无规则 targetServerId 变化）→ 既无需热切换也无需重启：直接更新缓存。避免纯切「更新检查
    // 走代理」开关触发 ~1.2s 断流。注意 planHotSwitch=none 已排除规则 targetServerId 变化（那会进 rules/both）。
    if (
      this.currentConfig &&
      this.currentConfig.selectedServerId === newConfig.selectedServerId &&
      this.configGenerationNorm(this.currentConfig) === this.configGenerationNorm(newConfig)
    ) {
      this.currentConfig = newConfig;
      // L3 值热更主路径：norm 结构相等但外化规则的值可能变了 ⇔ 文件内容 diff → 原子替换 + fswatch 热重载、零重启。
      // 降级桥：上次有外化规则未落盘走 inline（文件无消费者）→ 改走重启重落盘，防「写了没人消费」的值陈旧。
      if (this.customRuleFilesDegraded) this.scheduleDebouncedRestart();
      else await this.syncCustomRuleFiles(newConfig);
      return;
    }

    // issue #176 P2-A：订阅刷新「仅新增了未被引用的纯代理节点」（机场加新节点的常见情形，#176 高频触发源：6+
    //   订阅 autoUpdate）→ 免整核重启。安全模型是**非对称**的（见 canSkipRestartForAddedUnreferenced）：新增未引用
    //   节点的 route 排除 / DNS rule1 条目缺失**无害**（该节点未承载流量，要被选中才连它、届时 planHotSwitch 经
    //   currentIdToTagMap 查不到 → 退回重启自然补全）；而删除/改址会让运行核**残留陈旧**条目（旧址被复用为真实目标时
    //   可致错误直连）→ 必须重启。故只放行「纯新增未引用节点」。externalized 规则值若同窗口变了，与 no-op 分支同款经
    //   syncCustomRuleFiles 热重载（不重启）/降级则重启。
    if (
      this.currentConfig &&
      this.canSkipRestartForAddedUnreferenced(this.currentConfig, newConfig)
    ) {
      this.logToManager(
        'info',
        '仅新增未引用节点（订阅刷新等），免重启应用（新节点下次启动/被选中时生效）'
      );
      this.currentConfig = newConfig;
      if (this.customRuleFilesDegraded) this.scheduleDebouncedRestart();
      else await this.syncCustomRuleFiles(newConfig);
      return;
    }

    // 其余变化（模式/端口/TUN/规则/选中或被引用节点集合/interrupt 开关 等需重生成配置的项）→ 重启应用。
    // 去抖合并：先把缓存更新到最新 newConfig（窗口内 hotSwitch/no-op/再次结构变更都对账到它），
    // 再调度 trailing 重启（~1.5s 内连改多条只重启一次，消除「连改 5 条规则=5 次断流」）。
    this.logToManager('info', '配置已更改，调度去抖重启以应用...');
    this.currentConfig = newConfig;
    this.scheduleDebouncedRestart();
  }

  /**
   * 是否可走 clash_api 热切换：当且仅当唯一变化是「切到一个已在运行中 selector 里的节点」，
   * 其余影响配置生成的项（模式/端口/TUN/customRules/servers 集合/appRules/interrupt 开关）都未变。
   */
  /**
   * Windows TUN 热切换 guard：system 栈放行（实测零环路），gvisor 栈未实测保守退回重启。
   * 全局节点热切换与规则目标热切换共用（rule-sel selector 切换同理可能触发 Wintun 回捕）。
   */
  private winTunBlocksHotSwitch(config: UserConfig): boolean {
    if (process.platform !== 'win32' || config.proxyModeType !== 'tun') return false;
    const winTunStack = config.tunConfig?.stack || 'system'; // Windows 默认 system 栈
    return winTunStack !== 'system';
  }

  /**
   * 热切换规划：判 newConfig 相对 currentConfig 能否走 clash_api 热切换，并产出需 PUT 的 selector 列表。
   * - norm(old)===norm(new) 是前提（targetServerId 已移出 norm → 改规则目标不翻转 norm）。
   * - kind=global：仅 selectedServerId 变 → PUT proxy-selector。
   * - kind=rules：仅规则 targetServerId 变 → PUT 各 rule-sel-<id>。
   * - kind=both：全局 + 规则同时变 → PUT proxy-selector + 各 rule-sel。
   * - kind=none：无热切换可行（结构变更/目标节点不在 selector/WIN gvisor guard）→ 退回去抖重启。
   */
  private planHotSwitch(newConfig: UserConfig): {
    kind: 'none' | 'global' | 'rules' | 'both';
    puts: { selectorTag: string; memberTag: string }[];
  } {
    const old = this.currentConfig;
    if (!old) return { kind: 'none', puts: [] };
    // norm 前提：结构等价（targetServerId/selectedServerId 均已移出 norm → 仅这俩值变不翻转 norm）。
    if (this.configGenerationNorm(old) !== this.configGenerationNorm(newConfig)) {
      return { kind: 'none', puts: [] };
    }
    if (this.winTunBlocksHotSwitch(newConfig)) return { kind: 'none', puts: [] };

    const puts: { selectorTag: string; memberTag: string }[] = [];
    let globalChanged = false;

    // 全局节点变化（含切到/切出"直连"哨兵：memberTag=direct，direct 恒是 proxy-selector 成员→可热切换不重启）
    if (old.selectedServerId !== newConfig.selectedServerId && newConfig.selectedServerId) {
      const toDirect = isDirectSelection(newConfig.selectedServerId);
      // 目标节点必须已存在于运行中的 selector（= 启动时 servers），否则 PUT 指向不存在的成员；direct 豁免（恒为成员）
      if (!toDirect && !old.servers.some((s) => s.id === newConfig.selectedServerId)) {
        return { kind: 'none', puts: [] };
      }
      // ICMP 规则已恒走 direct（route-builder，静态不依赖选中节点）→ ICMP 不再是热切换边界。但选中节点的【其它】
      // route 投影仍随之变，而 configGenerationNorm 已剔除 selectedServerId → 这些差异 PUT 不重生成，必须退回重启：
      //   (1) 全隧道兜底：meshSelectedExitFallsBackToDirect 翻转 → final/smart-geo 的 userExitTag(proxy-selector↔direct)
      //       翻转（原 ICMP guard 与此互补、隐式覆盖；ICMP 改静态后须显式保留，否则全隧道 endpoint↔off-mesh 热切 final
      //       黑洞，并补上旧 guard 漏的 off-mesh↔普通代理 同款翻转）。
      //   (2) force-route engaged：alwaysRouteSubnets=false 的 endpoint 仅被选中时发其内网段；切到/离开它 → 段规则增删
      //       （保守：任一端是此类节点即重启，含被规则指向时极少数无谓重启，安全优先）。
      const oldSel = old.servers.find((s) => s.id === old.selectedServerId);
      const newSel = newConfig.servers.find((s) => s.id === newConfig.selectedServerId);
      const selOnlyForcesSubnets = (s?: ServerConfig): boolean =>
        !!s &&
        isEndpointProtocol(s.protocol) &&
        !meshAlwaysRoutesSubnets(s) &&
        endpointForcedRouteCidrs(s).length > 0;
      if (
        meshSelectedExitFallsBackToDirect(old) !== meshSelectedExitFallsBackToDirect(newConfig) ||
        selOnlyForcesSubnets(oldSel) ||
        selOnlyForcesSubnets(newSel)
      ) {
        return { kind: 'none', puts: [] };
      }
      const targetTag = resolveGlobalExitTag(newConfig.selectedServerId, this.currentIdToTagMap);
      if (!targetTag) return { kind: 'none', puts: [] };
      puts.push({ selectorTag: 'proxy-selector', memberTag: targetTag });
      globalChanged = true;
    }

    // 规则目标变化：diff customRules + appRules 的 targetServerId，对每条变化的规则从 currentRuleTargetMap
    // 查 selectorTag、从 newConfig 的 idToTagMap（= 启动时映射，结构等价所以不变）解析新 memberTag。
    const rulePuts = this.planRuleHotSwitch(old, newConfig);
    if (rulePuts === null) return { kind: 'none', puts: [] }; // 任一规则目标节点不在 selector → 整体退回重启
    puts.push(...rulePuts);

    if (puts.length === 0) return { kind: 'none', puts: [] };
    const kind = globalChanged && rulePuts.length > 0 ? 'both' : globalChanged ? 'global' : 'rules';
    return { kind, puts };
  }

  /**
   * 规则 targetServerId diff → rule-sel PUT 列表。返回 null 表示任一目标节点不在运行中 selector（应整体退回重启）。
   * currentRuleTargetMap 的 memberTag 是【生成时】的 default（启动时 targetServerId 解析）；此处按 newConfig 重解析
   * 新 targetServerId → 新 memberTag（currentIdToTagMap 结构等价不变，可复用）。
   */
  private planRuleHotSwitch(
    old: UserConfig,
    newConfig: UserConfig
  ): { selectorTag: string; memberTag: string }[] | null {
    const map = this.currentRuleTargetMap;
    if (!map) return []; // 启动时无 rule-sel（无 proxy+targetServerId 规则）→ 无规则热切换
    const idToTag = this.currentIdToTagMap;
    if (!idToTag) return null;

    const puts: { selectorTag: string; memberTag: string }[] = [];
    const visit = (
      ruleKey: string,
      oldTarget: string | undefined,
      newTarget: string | undefined
    ): boolean => {
      if (oldTarget === newTarget) return true; // 未变
      const entry = map.get(ruleKey);
      if (!entry) return true; // currentRuleTargetMap 无此条（启动时该规则未生成 rule-sel，如被 gate 剔除）→ 跳过
      // 新目标有→解析节点 tag；无（节点切回默认/跟全局）→ proxy-selector（rule-sel 嵌套 default）
      const memberTag = newTarget ? idToTag.get(newTarget) : 'proxy-selector';
      if (newTarget && !memberTag) return false; // 新目标节点不在 selector → 退回重启
      puts.push({ selectorTag: entry.selectorTag, memberTag: memberTag || 'proxy-selector' });
      return true;
    };

    // customRules：按 id 配对（结构等价 ⇒ 顺序与 id 集合一致）
    const oldRulesById = new Map(
      (old.customRules || []).filter((r) => r.enabled).map((r) => [r.id, r])
    );
    for (const r of newConfig.customRules || []) {
      if (!r.enabled) continue;
      const oldR = oldRulesById.get(r.id);
      if (!oldR) continue;
      if (!visit(`custom:${r.id}`, oldR.targetServerId, r.targetServerId)) return null;
    }
    // appRules：按 appId 配对
    const oldAppsByAppId = new Map(
      (old.appRules || []).filter((a) => a.enabled).map((a) => [a.appId, a])
    );
    for (const a of newConfig.appRules || []) {
      if (!a.enabled) continue;
      const oldA = oldAppsByAppId.get(a.appId);
      if (!oldA) continue;
      if (!visit(`app:${a.appId}`, oldA.targetServerId, a.targetServerId)) return null;
    }
    return puts;
  }

  /**
   * 配置的「生成相关」归一化键：剔除只影响下载/调度/Electron 会话/元数据、不影响 sing-box 配置生成的字段
   * （selectedServerId、ghProxyPrefix、ruleResource* 调度、builtinGeoMeta、subscriptions 元数据、
   * mainSessionViaProxy、未被引用的本地资源、servers 的 updatedAt/createdAt 时间戳）。
   * 两配置此键相等 ⇔ 生成的 sing-box 配置等价。供 canHotSwitch（判纯切节点）与 switchMode（判生成无关变更 → 免重启 no-op）共用。
   *
   * issue #176 P2-A：可选 serverIds 把 servers 投影过滤到「被引用集」——两配置此「引用归一键」相等 ⇔ 生成配置中
   *   实际承载流量的部分（选中节点+其 detour 前置链+规则目标+endpoint）逐字节一致，差异只在未引用的惰性 selector
   *   成员节点（订阅刷新增删的纯代理节点）→ 运行核行为不变、可免重启。不传 serverIds = 全量（原行为，现有调用方不变）。
   */
  private configGenerationNorm(c: UserConfig, serverIds?: ReadonlySet<string>): string {
    // 用户路由（自定义规则 + 应用分流）仅 smart 模式影响生成（global=真·全局忽略用户分流、direct=全直连，均不 emit）。
    // 非 smart 下其内容/增删/编辑/换节点都不改变 sing-box 配置 → 不应翻转 norm（否则运行中编辑规则误触重启断流）。
    const userRoutingActive = (c.proxyMode || 'smart').toLowerCase() === 'smart';
    // 被启用 ruleSet 规则引用的本地资源 id 集（只有它们影响生成；未引用资源的增删不应阻断热切换）。非 smart → 无引用。
    const ids = new Set<string>();
    if (userRoutingActive) {
      for (const r of c.customRules || []) {
        if (!r.enabled) continue;
        for (const cond of ruleConditions(r)) {
          if (cond.type === 'ruleSet') {
            for (const v of cond.values) if (v.startsWith('res:')) ids.add(v.slice(4));
          }
        }
      }
    }
    return this.stableStringify({
      ...c,
      selectedServerId: null,
      ghProxyPrefix: null,
      ruleResourceAutoUpdate: null,
      ruleResourceUpdateIntervalHours: null,
      builtinGeoMeta: null,
      subscriptions: null,
      mainSessionViaProxy: null,
      // helper 引导/升级「不再提示」纯 UI 偏好，不影响 sing-box 生成 → 运行中勾选不应触发重启断流。
      helperPromptDismissed: null,
      helperDisabledPromptDismissed: null,
      helperUpgradePromptDismissed: null,
      // fakeIpToggleMigrated 是一次性迁移元数据标记，不影响生成（enableFakeIp 本身仍在 norm 内 → 影响生成保留）。
      //   若不排除：未来某路径重建 dnsConfig 丢标记 → norm 翻转无谓重启，且再次迁移可能覆盖用户手动改的值。
      dnsConfig: c.dnsConfig ? { ...c.dnsConfig, fakeIpToggleMigrated: null } : c.dnsConfig,
      // 规则投影：禁用规则不进生成（generateCustomRules / DNS 侧均跳过 disabled）→ 内容/增删不触发重启；
      //   remarks 纯展示元数据，不影响生成。顺序保留（reorder 仍重启，语义正确）。
      // 非 smart（global/direct）：用户路由不进生成 → 整体投影为 []（增删/编辑/换节点都不翻转 norm，免无谓重启）。
      // smart：外化规则（全 EXT 可表达）的「值」移出 norm（值变 ⇔ 文件 diff → 热重载、不重启），保留结构位
      //   （id/action/target/combineMode/bypassFakeIP/各 cond 的 type 与 ok=有无 matcher）；inline 规则保留全量值（值变须重启）。
      customRules: (() => {
        if (!userRoutingActive) return [];
        return (c.customRules || [])
          .filter((r) => r.enabled)
          .map((r) => {
            if (planCustomRule(r).kind === 'inline') {
              // smart inline 规则：rule-sel 恒存在（default=target 节点或 proxy-selector 跟全局）。
              // targetServerId 值变（换节点/节点↔默认）= rule-sel default 变（PUT 热切换）→ 移出 norm。
              // 其余值（域名/IP 等）仍在 inline route 消费、改值须重启 → 保留全量结构。
              const copy: Record<string, unknown> = { ...r };
              delete copy.remarks;
              delete copy.targetServerId;
              return copy;
            }
            return {
              __ext: 1, // 防与 inline 形态键集碰撞误判等价
              id: r.id, // 文件身份绑定 id；id 变=结构变=重启
              action: r.action,
              // targetServerId 移出 norm（值热切换）：rule-sel 恒存在，default=target 节点或 proxy-selector
              //   跟全局，值变=PUT rule-sel default 热切换、不重启。
              targetServerId: null,
              combineMode: r.combineMode ?? null,
              bypassFakeIP: !!r.bypassFakeIP,
              // ok 位承载 fail-closed/skip 决策与「值空↔非空」翻转（值本身不入 norm）
              conds: ruleConditions(r).map((cd) => ({
                t: cd.type,
                ok: condMatcherFields(cd) !== null,
              })),
            };
          });
      })(),
      // appRules 投影：仅 smart 生效。非 smart → []（增删/换 action 都不翻转 norm）。
      //   smart：targetServerId 移出 norm（rule-sel-app 恒存在，值变=PUT 热切换）；保留 appId/action/enabled 结构位。
      appRules: !userRoutingActive
        ? []
        : (c.appRules || []).map((a) => ({
            appId: a.appId,
            action: a.action,
            enabled: a.enabled,
            targetServerId: null,
          })),
      ruleResources: (c.ruleResources || [])
        .filter((rr) => ids.has(rr.id))
        .map((rr) => rr.id)
        .sort(),
      servers: [...c.servers]
        .filter((s) => !serverIds || serverIds.has(s.id)) // P2-A：传 serverIds 时仅保留被引用节点
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => {
          const copy: Record<string, unknown> = { ...s };
          delete copy.updatedAt;
          delete copy.createdAt;
          return copy;
        }),
    });
  }

  /**
   * issue #176 P2-A：「被引用节点」id 集——其定义变化会影响运行核实际行为、故必须随之重启。
   *   = {选中节点} ∪ {所有启用规则(custom/app)目标}，按 detour（前置代理链）传递闭包展开
   *   ＋ 保守纳入全部 endpoint 协议节点（WireGuard/Tailscale 可能 force-route 子网/mesh，独立于选中即承载流量）。
   * 其余「纯代理」节点仅作 selector 惰性成员、不承载任何流量，增删改不改变运行核行为 → 不在此集 → 可免重启。
   * 安全方向：**过度纳入只会多一次重启、绝不错跳**（漏纳入才会错误免重启致运行核用旧前置参数 → 流量错误/泄漏）。
   *   故 endpoint 一律纳入、detour 取全闭包、direct 哨兵剔除、悬空 detour 忽略。
   * 注：custom-endpoint（`customSettings.isEndpoint`）不被 isEndpointProtocol 纳入，但其 `endpointForcedRouteCidrs`
   *   恒返 []（不 force-route）→ 不会独立于选中承载流量 → 按普通未引用节点处理即安全（新增它经 additions-only
   *   模型放行、其 route/DNS 条目缺失无害），无需进引用集。
   */
  private referencedServerIds(c: UserConfig): Set<string> {
    const byId = new Map(c.servers.map((s) => [s.id, s]));
    const R = new Set<string>();
    const stack: string[] = [];
    const seed = (id?: string | null): void => {
      if (id && !isDirectSelection(id)) stack.push(id);
    };
    seed(c.selectedServerId);
    for (const r of c.customRules || []) if (r.enabled) seed(r.targetServerId);
    for (const a of c.appRules || []) if (a.enabled) seed(a.targetServerId);
    for (const s of c.servers) if (isEndpointProtocol(s.protocol)) stack.push(s.id); // 保守纳入全部 endpoint
    while (stack.length) {
      const id = stack.pop() as string;
      if (R.has(id)) continue; // 成环/重复保护
      R.add(id);
      const s = byId.get(id);
      if (s?.detour && byId.has(s.detour)) stack.push(s.detour); // detour 前置链传递闭包
    }
    return R;
  }

  /**
   * issue #176 P2-A：判 next 相对 old 是否「仅新增了未被引用的纯代理节点」——是则可免整核重启（订阅刷新加新节点）。
   * 非对称安全模型：新增未引用节点 → 其 route 排除/DNS rule1（route-builder/dns-builder 遍历**全部**节点的 address+
   *   serverName）条目缺失**无害**（节点未承载流量、被选中才连它→届时退回重启补全）；删除/改址/改任一旧节点 →
   *   运行核**残留陈旧**条目（旧址被复用为真实代理目标时可致错误直连）→ 必须重启。
   * 全部满足才放行（缺一即重启）：
   *   ① selectedServerId 未变；② 所有非 servers 的生成相关字段未变（servers 过滤到空集后归一键相等）；
   *   ③ 旧节点全部原样保留在 next（无删除、无任一旧节点 address/参数改动——含选中/规则目标/detour/endpoint）；
   *   ④ 新增节点（next\old）全部未被引用（非选中/非规则目标/不在 detour 链/非 endpoint）。
   */
  private canSkipRestartForAddedUnreferenced(old: UserConfig, next: UserConfig): boolean {
    if (old.selectedServerId !== next.selectedServerId) return false; // ①
    const EMPTY: ReadonlySet<string> = new Set();
    // ② 非 servers 字段逐字节一致（servers 投影到空 → 仅比对路由/规则/DNS/端口/模式 等非节点字段）
    if (this.configGenerationNorm(old, EMPTY) !== this.configGenerationNorm(next, EMPTY))
      return false;
    const fingerprint = (s: ServerConfig): string => {
      const c: Record<string, unknown> = { ...s };
      delete c.updatedAt; // 时间戳不影响生成
      delete c.createdAt;
      return this.stableStringify(c);
    };
    const oldById = new Map(old.servers.map((s) => [s.id, s]));
    const newById = new Map(next.servers.map((s) => [s.id, s]));
    // ③ 旧节点全部原样保留（无删除、无改动；含 address/serverName 与全部协议参数）
    for (const s of old.servers) {
      const n = newById.get(s.id);
      if (!n || fingerprint(n) !== fingerprint(s)) return false;
    }
    // ④ 新增节点全部未被引用
    const refNext = this.referencedServerIds(next);
    for (const s of next.servers) {
      if (!oldById.has(s.id) && refNext.has(s.id)) return false;
    }
    return true;
  }

  /**
   * 递归按 key 排序后序列化——使深比较对对象属性插入顺序不敏感。
   * 渲染层重建配置对象时键序常与原对象不同，普通 JSON.stringify 会因此误判"配置已变"而退回重启、
   * 废掉热切换。数组顺序保留（customRules/appRules 顺序具语义，顺序变化应视为真变更触发重启）。
   */
  private stableStringify(v: any): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map((x) => this.stableStringify(x)).join(',') + ']';
    return (
      '{' +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined) // 与 JSON.stringify 一致：丢弃 undefined 键，避免 undefined↔null 误判相等
        .map((k) => JSON.stringify(k) + ':' + this.stableStringify(v[k]))
        .join(',') +
      '}'
    );
  }

  /** 启动前端口冲突清理用的控制端口（缺省 9090，可经 config.controlPort 改）。clash_api 已移除，仅 resolveClashApiPortConflict 残留用作清理目标端口。 */
  getClashApiPort(): number {
    return controlApiPort(this.currentConfig ?? {});
  }

  /**
   * 当前 api service（sing-box 1.14 management api）监听端口。startInternal 经 resolveTailscaleApiPort 解析的空闲动态端口，
   * 渲染端构造不出，故「打开官方面板」IPC 用此取运行期端口构造 /dashboard/ URL。未启动时为 0（dashboard 仅运行中可用）。
   */
  getTailscaleApiPort(): number {
    return this.tailscaleApiPort;
  }

  /**
   * dashboard #55：面板连接信息（运行期 api 端口构造 URL + clash secret）。
   * - url：内窗口加载地址 `http://127.0.0.1:<port>/dashboard/`（核 serve 内置/覆盖面板处）。
   * - apiUrl：面板要连的管理 API 地址 `http://127.0.0.1:<port>`（写入面板 localStorage 的 server.url / 复制信息用）。
   * - secret：clashApiSecret（注入 api service 的 Bearer，面板每个 RPC 须带）。取自 currentConfig，**不长驻渲染端 store**。
   * 代理未运行（端口=0）→ { ok: false }（UI 仅运行中 enable 入口）。
   */
  getDashboardConnectionInfo(): { ok: boolean; url: string; apiUrl: string; secret: string } {
    const port = this.tailscaleApiPort;
    if (!this.getStatus().running || !port) {
      return { ok: false, url: '', apiUrl: '', secret: '' };
    }
    return {
      ok: true,
      url: `http://127.0.0.1:${port}/dashboard/`,
      apiUrl: `http://127.0.0.1:${port}`,
      secret: this.currentConfig?.clashApiSecret || '',
    };
  }

  /**
   * 运行期管理 API 客户端（sing-box 1.14 gRPC）。StatsService 经此订阅 Status/Connections 流（取代 clash_api 轮询）。
   * 随主核生命周期：startInternal 内核起后创建（this.tailscaleApiClient），stop() 置 null。未启动核时返回 null
   * → StatsService 据此判定不开流（核未就绪）。
   */
  getApiClient(): SingBoxApiClient | null {
    return this.tailscaleApiClient;
  }

  /**
   * 关闭连接（连接信息页用）：直调管理 API gRPC（Bearer secret 内部封装，渲染端不持 secret）。
   * id 给定 → CloseConnection(id)（关单条）；id 省略 → CloseAllConnections()（关全部）。
   * gRPC 抛错（与 clash_api 的 {ok,status} 不同）→ catch 包成 { ok:false, status:0 }，维持原签名/语义（与 reassert/hotSwitch 同治）。
   * status：成功 200（无 HTTP 状态码，仅用于 UI 判 ok）；失败 0（管理 API 未就绪/调用异常）。
   */
  async closeConnection(id?: string): Promise<{ ok: boolean; status: number }> {
    const client = this.tailscaleApiClient;
    if (!client) return { ok: false, status: 0 }; // 客户端未就绪（核未起）→ fallback
    try {
      if (id) await client.closeConnection(id);
      else await client.closeAllConnections();
      return { ok: true, status: 200 };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /**
   * 管理 API 热切换任一 selector 的选中成员（gRPC SelectOutbound）。
   * 泛化自 hotSwitchNode：全局 proxy-selector 与各 rule-sel-<id> 复用同一原语。
   * @returns true=切换成功；false=定位失败或 gRPC 抛错（调用方退回去抖重启兜底）。
   */
  private async hotSwitchSelector(selectorTag: string, memberTag: string): Promise<boolean> {
    if (!memberTag) return false;
    const client = this.tailscaleApiClient;
    if (!client) {
      this.logToManager('warn', `管理 API 客户端未就绪，无法热切换 ${selectorTag}`);
      return false;
    }
    // gRPC SelectOutbound throws on error（与 clash_api 的 {ok,status} 不同）：catch 包成 false，退去抖重启兜底。
    try {
      await client.selectOutbound(selectorTag, memberTag);
    } catch (e) {
      this.logToManager(
        'warn',
        `管理 API 热切换 ${selectorTag} 失败：${(e as Error)?.message ?? e}`
      );
      return false;
    }
    this.logToManager('info', `已热切换 ${selectorTag} → ${memberTag}（管理 API，无重启）`);
    return true;
  }

  /**
   * 获取代理状态
   */
  getStatus(): ProxyStatus {
    // 判定依据：是否经「包装进程」启动（macOS osascript / Windows UAC）。
    //   · 包装进程模式：this.pid 是 osascript/PowerShell 的 PID，真实 sing-box PID 在 singboxPid。
    //   · 直接 spawn 模式（含 Linux TUN）：只有 this.pid，singboxPid 恒 null。
    // 旧逻辑按 `proxyModeType==='tun'` 取 singboxPid → Linux TUN 直接 spawn 时 activePid 恒 null →
    // getStatus 恒返回 running:false（issue #33「连接状态/按钮不同步」根因，且令健康检查失效）。
    const wrapperMode = this.needsOsascript() || this.needsWindowsUAC();
    const activePid = wrapperMode ? this.singboxPid : this.singboxPid || this.pid;

    // 验证进程是否真正存活
    const isRunning = activePid !== null && this.isProcessAlive(activePid);

    if (!isRunning || !activePid) {
      return {
        running: false,
      };
    }

    // 计算运行时间
    let uptime: number | undefined;
    if (this.startTime) {
      uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }

    return {
      running: true,
      pid: activePid,
      startTime: this.startTime || undefined,
      uptime,
      currentServer: this.currentConfig?.servers.find(
        (s) => s.id === this.currentConfig?.selectedServerId
      ),
    };
  }

  /**
   * 获取核心版本
   */
  async getCoreVersion(force = false): Promise<string> {
    // 缓存命中：启动时(startInternal :716)已检测并写入 this.coreVersion；此后 About 页/版本查询直接返回缓存，
    // 不再每次都 spawn `sing-box version` 子进程（45MB 内核，Windows 进程创建+AV 扫描尤慢 → 进「关于」页转圈）。
    // force=true 仅启动路径用（内核可能已更新 → 须重检测刷新缓存）。
    if (!force && this.coreVersion && this.coreVersion !== 'unknown') {
      return this.coreVersion;
    }
    try {
      // 版本号恒在第一行（`sing-box version X.Y.Z ...`）；用第一行解析既复用 coreVersionLine 的同一次 spawn，
      // 又避免在全量 stdout 上误匹配后续行（如 Environment 的 `go1.25.10` 含 `1.25.10`）。
      const line = await this.spawnCoreVersionFirstLine();
      this.coreVersionLine = line; // 顺带缓存原始行（含 fork 后缀）供内核来源判定
      // 保留 prerelease 后缀（如 1.14.0-alpha.32）：供 compareSemver 排序预览版（alpha.32<alpha.33<…<正式），
      // 驱动「预览→正式可升、正式↛预览」更新逻辑。coreVersionAtLeast/encodeMajorMinor 已容忍后缀。
      const match = line.match(/(?:version\s+|v)(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/i);
      const secondMatch = line.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
      const detected = match
        ? match[1]
        : secondMatch
          ? secondMatch[1]
          : coreManifest.bundledCoreVersion;
      this.coreVersion = detected; // 写缓存：供后续查询命中 + config 生成 coreVersionAtLeast 复用
      return detected;
    } catch (error) {
      this.logToManager('error', `获取核心版本失败: ${(error as any).message}`);
      return coreManifest.bundledCoreVersion; // 不写 'unknown' 缓存，下次仍可重试
    }
  }

  /**
   * spawn `sing-box version` 取原始第一行（含 fork 后缀，不截 X.Y.Z）。失败抛出，由调用方按各自缓存策略处理。
   * 串行化（issue #150）：所有版本探测排到 versionProbeChain，确保任一时刻至多一个 version 子进程 execve 内核
   * 二进制——并发探测会同时占用二进制，与启动期换核写盘并发执行放大 race（旧实现 + 原地 copyFile 即 ETXTBSY）。
   * 链只承载排序、不传播失败（catch→undefined），避免一次探测失败卡死后续所有探测；调用方仍拿到 run 的真实结果/异常。
   */
  private async spawnCoreVersionFirstLine(): Promise<string> {
    const run = this.versionProbeChain
      .catch(() => undefined)
      .then(() => this.doSpawnCoreVersionFirstLine());
    this.versionProbeChain = run.catch(() => undefined);
    return run;
  }

  /** 实际 spawn `sing-box version`（不含串行排队）；仅供 spawnCoreVersionFirstLine 经 versionProbeChain 调用。 */
  private async doSpawnCoreVersionFirstLine(): Promise<string> {
    const execAsync = require('util').promisify(require('child_process').exec);
    const { stdout } = await execAsync(`"${this.singboxPath}" version`);
    return String(stdout).split('\n')[0]?.trim() || '';
  }

  /**
   * 获取 `sing-box version` 原始第一行（含 fork 后缀），供内核来源判定（classifyCoreBuild）。
   * 通常已由 getCoreVersion 顺带写入 coreVersionLine（换核后 getCoreVersion(force) 会刷新）；未捕获过则单独 spawn。
   * 失败置 null 不缓存（与 getCoreVersion 同策略，下次重试），返回 ''（→ classifyCoreBuild 视为 unknown）。
   */
  async getCoreVersionLine(force = false): Promise<string> {
    if (!force && this.coreVersionLine !== null) return this.coreVersionLine;
    try {
      this.coreVersionLine = await this.spawnCoreVersionFirstLine();
      return this.coreVersionLine;
    } catch (error) {
      // 仅影响 classifyCoreBuild（fork 判定）的最佳努力细节；主版本检测（getCoreVersion）有独立错误日志。
      // 命令偶发失败常自恢复（下次 start force 重取），降 debug 避免误导（曾在真机日志刷 warn 但版本已正常检测）。
      this.logToManager('debug', `获取核心版本行失败: ${(error as any).message}`);
      this.coreVersionLine = null;
      return '';
    }
  }

  /**
   * 为「核心更新预检」生成针对目标版本的配置 JSON：用当前活动配置 + 目标核心版本（this.coreVersion 临时设为
   * targetVersion），供 sing-box check 校验新核能否解析。配置已硬切 1.14（route 层 sniff 无条件、services 仅
   * hasManagementApi(≥1.14) 注入），故 targetVersion<1.14 的预检配置不含 1.14-only 字段。
   * 无活动配置（代理从未启动）时返回 null —— 调用方仅校验二进制可执行即可。
   */
  buildPreflightConfigJson(targetVersion: string): string | null {
    if (!this.currentConfig) return null;
    const savedVersion = this.coreVersion;
    const savedRacePort = this.raceServerPort;
    try {
      this.coreVersion = targetVersion;
      // preflight 只验「新核能否 check 通过此 config schema」，不应引用 live race server——其端口随新核重启会重分配、
      // 且 check 不连该 server。临时 raceServerPort=0 强制 race-off，使预检配置不含 dns-node-race（review #6：
      // 注释曾声称 preflight 恒 race-off，但代理运行时 raceServerPort>0 会让它误带 live race server）。
      this.raceServerPort = 0;
      const cfg = this.generateSingBoxConfig(this.currentConfig);
      return JSON.stringify(cfg, null, 2);
    } catch (e) {
      this.logToManager('warn', `预检配置生成失败: ${(e as any)?.message ?? e}`);
      return null;
    } finally {
      this.coreVersion = savedVersion;
      this.raceServerPort = savedRacePort;
    }
  }

  /**
   * 为 1.14 管理 API service 解析一个空闲本地端口（net.listen 0，排除 clash 端口与用户代理端口）。每次 start 重解析，
   * 避免硬编 clash+1 被占 → services bind FATAL（A1）。解析失败（极少见）兜底 clash+1（与旧行为一致）。
   */
  private async resolveTailscaleApiPort(config: UserConfig): Promise<number> {
    const exclude = new Set<number>(
      [controlApiPort(config), config.httpPort, config.socksPort, config.mixedPort].filter(
        (p): p is number => typeof p === 'number' && p > 0
      )
    );
    return this.resolveFreeLocalPort(exclude, controlApiPort(config) + 1);
  }

  /**
   * 瞬态登录核管理 API 端口：独立解析一个空闲本地端口，**排除主核 api 端口**（this.tailscaleApiPort，主核运行
   * 中则已占）+ 用户代理端口，避两个 api service bind 撞端口。主核未运行（tailscaleApiPort=0）则该排除项无效，
   * 自然不影响。兜底用一个高位偏移（避与主核兜底 controlApiPort+1 撞）。
   */
  private async resolveTailscaleLoginApiPort(): Promise<number> {
    const cfg: Partial<UserConfig> = this.currentConfig ?? {};
    const exclude = new Set<number>(
      [
        this.tailscaleApiPort,
        controlApiPort(cfg),
        cfg.httpPort,
        cfg.socksPort,
        cfg.mixedPort,
      ].filter((p): p is number => typeof p === 'number' && p > 0)
    );
    return this.resolveFreeLocalPort(exclude, controlApiPort(cfg) + 2);
  }

  /**
   * 解析一个空闲 127.0.0.1 本地端口（listen(0) 拿系统分配口 → 立即关 → 不在 exclude 集才采用）。IPv4 端口
   * 探测单一真值：主核 api / 瞬态登录核 api 共用，避端口探测逻辑多份漂移。5 次重试仍撞 exclude → 返回 fallback。
   */
  private async resolveFreeLocalPort(exclude: Set<number>, fallback: number): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const srv = net.createServer();
      try {
        const port = await new Promise<number>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
        });
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        if (!exclude.has(port)) return port;
      } catch {
        try {
          srv.close();
        } catch {
          /* ignore */
        }
      }
    }
    return fallback;
  }

  /**
   * 为出口 IP 探针分配两个空闲端口（probe-direct-in / probe-proxy-in）。每次 start 重新分配，避免
   * 端口被占。失败（极少见）则置 null，generateInbounds/generateRouteConfig 据此跳过探针，不影响代理。
   */
  private async allocateProbePorts(config?: UserConfig): Promise<void> {
    // 排除用户自配端口与 clash_api，避免 listen(0) 偶撞用户端口段致 sing-box bind FATAL（review P1-4）
    const exclude = new Set<number>([controlApiPort(config ?? {})]);
    if (config) {
      if (config.httpPort) exclude.add(config.httpPort);
      if (config.socksPort) exclude.add(config.socksPort);
      if (config.mixedPort) exclude.add(config.mixedPort);
    }
    const servers: net.Server[] = [];
    const ports: number[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        let port = 0;
        // 至多 5 次重绑避开排除端口（ephemeral 段与常用端口几乎不撞，循环仅作保险）
        for (let attempt = 0; attempt < 5; attempt++) {
          const srv = net.createServer();

          await new Promise<void>((resolve, reject) => {
            srv.listen(0, '127.0.0.1', () => resolve());
            srv.on('error', reject);
          });
          port = (srv.address() as net.AddressInfo).port;
          if (!exclude.has(port) && !ports.includes(port)) {
            servers.push(srv);
            break;
          }

          await new Promise<void>((resolve) => srv.close(() => resolve()));
          port = 0;
        }
        if (!port) throw new Error('probe port allocation collided');
        ports.push(port);
      }
      this.probeDirectPort = ports[0];
      this.probeProxyPort = ports[1];
    } catch {
      this.probeDirectPort = null;
      this.probeProxyPort = null;
    } finally {
      await Promise.all(
        servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
      );
    }
  }

  /**
   * 启动前确认 clash_api 控制端口可用，仍被占则**按端口**清掉占用者（L2，彻底摆脱 cmdline 匹配）。
   * 端口取 getClashApiPort()（默认 9090，可经 config.controlPort 改）。残留 sing-box 是自家的，正确处置是「清掉
   * 占用者，否则明确终态 / 提示用户改 controlPort」。处置阶梯：① helper 就绪 → freePort（root、按端口、零提权，是 sing-box
   * 才杀，否则回报占用者名）；② 交互 + 无 helper → osascript 一次性按端口清；③ 兜底明确终态。所有终态码
   * ∈ 不可恢复错误（含 _FOREIGN / _AUTH_CANCELLED，均含 clash_api_port_busy 子串）→ 不进自动重启风暴。
   */
  private async resolveClashApiPortConflict(): Promise<void> {
    const PORT = this.getClashApiPort();
    // 占用两态：listening(connect 连上=有活监听者，必有 PID，可杀) / bindBusy(bind EADDRINUSE)。
    // bindBusy 但 !listening = TIME_WAIT 类——XNU in_pcbbind 有 UID 检查：root sing-box 死后留下的 9090
    // root TIME_WAIT，用户态(systemProxy) sing-box 即使 SO_REUSEADDR 也压不过 → EADDRINUSE，持续 2MSL≈30s。
    // **TIME_WAIT 无进程可杀（lsof 抓不到），只能等它自然回收**，绝不能弹提权框（无意义且阻塞）。
    const probe = async (): Promise<{ bindBusy: boolean; listening: boolean }> => {
      // 串行（非 Promise.all）：isPortBindBusy 为测可绑定性会临时 listen 127.0.0.1:PORT；若与 isPortListening 并行，
      // connect 探测会连上 bind 探测自己刚开的临时 listener → 空闲端口被误判 listening=true（Windows 真机实测 30/30
      // 必中，致 9090 恒判 BUSY；Windows 无 helper/osascript 清理分支 → 锁死所有代理启动）。先让 bind 探测开/关
      // listener 完全结束、再 connect → 杜绝自连（实测 0/30）。两探测无依赖、串行的额外延迟可忽略。
      const bindBusy = await this.isPortBindBusy(PORT);
      const listening = await this.isPortListening(PORT);
      return { bindBusy, listening };
    };
    let p = await probe();
    if (!p.bindBusy && !p.listening) {
      this.logToManager('info', `[clash_api] 端口空闲，正常继续`);
      return;
    }
    this.logToManager(
      'warn',
      `[clash_api] 仍被占用(bindBusy=${p.bindBusy} listening=${p.listening})，进入清理（helper=${!!this.helperManager}）`
    );

    // ② 有活监听者（孤儿/外部/旧路径 sing-box）→ 按端口提权杀（freePort 零提权 / osascript 带超时）
    if (p.listening) {
      if (this.helperManager && (await this.helperManager.isReady())) {
        this.logToManager('info', `[clash_api] helper 就绪 → freePort 按端口清理`);
        const r = await this.helperManager.freePort(PORT);
        this.logToManager('info', `[clash_api] freePort 结果: ${JSON.stringify(r)}`);
        if (r.foreign) throw this.clashPortError('FOREIGN', r.foreign);
      }
      p = await probe();
      if (p.listening && this.startInteractive && process.platform === 'darwin') {
        this.logToManager(
          'warn',
          `[clash_api] freePort 未清净 → osascript 按端口清理（带超时，弹前置顶窗口）`
        );
        const res = await this.osascriptFreePort(PORT);
        this.logToManager('info', `[clash_api] osascript 按端口清理结果: ${res}`);
        if (res === 'cancelled') throw this.clashPortError('AUTH_CANCELLED');
        if (res === 'foreign') throw this.clashPortError('FOREIGN');
        p = await probe();
      }
      if (
        p.listening &&
        process.platform === 'win32' &&
        this.helperManager &&
        (await this.helperManager.isReady())
      ) {
        // M5：Windows helper 就绪但首次 freePort 未清净（可能竞态/刚退 TIME_WAIT 转监听）→ 再试一次。
        // 注：Windows 无 osascript 等价的零提权清理；helper 未装=设计现状（可选加速层），
        // 不冒险加 RunAs taskkill（按映像名杀会误杀用户其他 sing-box 进程）。
        this.logToManager('info', `[clash_api] Windows helper freePort 首次未清净，重试一次`);
        await this.helperManager.freePort(PORT);
        p = await probe();
      }
      if (!p.bindBusy && !p.listening) {
        this.logToManager('info', `[clash_api] 活监听者已清掉，端口空闲`);
        return;
      }
      if (p.listening) {
        if (process.platform === 'win32') {
          const ready = this.helperManager && (await this.helperManager.isReady());
          this.logToManager(
            'error',
            `[clash_api] Windows 活监听者仍在 → 终态 BUSY：${ready ? 'helper freePort 重试后仍未清净' : '未装 helper，无零提权清理手段（建议安装 Windows 提权 helper）'}`
          );
        } else {
          // 仍有活监听者没杀掉（非交互/取消/外部）
          this.logToManager('error', `[clash_api] 活监听者仍在 → 终态 BUSY`);
        }
        throw this.clashPortError('BUSY');
      }
      // 杀完活孤儿后 bindBusy && !listening → 它自己留下的 root TIME_WAIT → 落入 ③ 等待
    }

    // ③ bindBusy 且无活监听者 = TIME_WAIT → 等自然回收（≤35s，覆盖 2MSL=30s），全程不弹提权框
    if (p.bindBusy && !p.listening) {
      // 预检放行：本次若经 macOS root(osascript/helper) 启动 sing-box（TUN 模式），残留多为上次 root sing-box 的
      // 9090 TIME_WAIT（同 uid 0）。Go listener 默认带 SO_REUSEADDR，root 进程对同 uid TIME_WAIT 残留可直接 bind →
      // 无需空等 30s，直接放行；失败由启动失败链（retry 退避，不进重启风暴）兜底。仅 darwin TUN 放行：用户态
      // systemProxy sing-box 跨 uid 压不过 root TIME_WAIT 仍须等；Win/Linux 的 bind/TIME_WAIT 语义未验证，保守仍等待（M-2）。
      // 注：依赖 XNU in_pcbbind「同 uid + SO_REUSEADDR 放行 TIME_WAIT」语义，需真机抓包实测确认（设计文档待验证项）。
      if (this.needsOsascript()) {
        this.logToManager(
          'info',
          `[clash_api] TIME_WAIT 残留，本次以 root 启动 sing-box（SO_REUSEADDR 复用同 uid 残留）→ 跳过等待直接放行`
        );
        return;
      }
      this.logToManager(
        'warn',
        `[clash_api] 端口处于回收中(TIME_WAIT)，等待系统释放（≤35s，无需结束进程）...`
      );
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
        message:
          '上一会话的 clash_api 端口正在回收（约 30 秒），请稍候自动重试或片刻后再启动，无需手动结束进程。',
        errorCode: ProxyErrorCode.CLASH_API_PORT_RECYCLING,
        code: -5,
      });
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        p = await probe();
        if (!p.bindBusy && !p.listening) {
          this.logToManager('info', `[clash_api] TIME_WAIT 已回收，端口空闲`);
          return;
        }
        if (p.listening) break; // 期间又冒出活监听者 → 跳出走 BUSY 终态（罕见）
      }
      if (p.bindBusy && !p.listening) {
        this.logToManager('error', `[clash_api] TIME_WAIT 35s 未回收 → 终态`);
        throw this.clashPortError('BUSY_TIMEWAIT');
      }
    }
    this.logToManager('error', `[clash_api] 清理后仍被占用 → 终态 BUSY`);
    throw this.clashPortError('BUSY');
  }

  /** bind 探测 127.0.0.1:port 是否被占（listen 报 EADDRINUSE=占用）。覆盖「活监听 + (SO_REUSEADDR 之外的)端口持有」，
   *  与 sing-box(Go) 的 bind 语义最接近——connect 探测漏掉的 held-but-not-accepting 由它兜住（修 9090 storm 回归）。 */
  private isPortBindBusy(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
    });
  }

  /** connect 探测 127.0.0.1:port 是否有活监听者（连上=有）。被拒/超时=无（不被 TIME_WAIT 误判为占用）。 */
  private isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      const done = (v: boolean): void => {
        sock.destroy();
        resolve(v);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(800, () => done(false));
    });
  }

  /** 构造 clash_api 端口占用终态错误（err.code 带机读码；消息均含「clash_api 端口」→ isUnrecoverableRestartError 命中、立即终态）。 */
  private clashPortError(
    kind: 'BUSY' | 'FOREIGN' | 'AUTH_CANCELLED' | 'BUSY_TIMEWAIT',
    occupant?: string
  ): Error & { code?: string } {
    const PORT = this.getClashApiPort();
    let msg: string;
    let code: string;
    if (kind === 'FOREIGN') {
      msg = `clash_api 端口 ${PORT} 被${occupant ? `「${occupant}」` : '非 sing-box 进程'}占用，请手动结束该进程后重试`;
      code = 'CLASH_API_PORT_BUSY_FOREIGN';
    } else if (kind === 'AUTH_CANCELLED') {
      msg = `清理占用 clash_api 端口 ${PORT} 的进程需要授权，已取消`;
      code = 'CLASH_API_PORT_BUSY_AUTH_CANCELLED';
    } else if (kind === 'BUSY_TIMEWAIT') {
      // TIME_WAIT 无进程可杀，提示「稍候重试」而非「结束进程」（避免误导用户去杀不存在的进程）
      msg = `clash_api 端口 ${PORT} 仍在系统回收中（上一会话残留的 TIME_WAIT，约 30 秒），请稍候片刻再启动，无需手动结束进程`;
      code = 'CLASH_API_PORT_BUSY';
    } else {
      msg = `clash_api 端口 ${PORT} 被占用（残留 sing-box 未释放或被外部进程占用），请手动结束占用进程后重试`;
      code = 'CLASH_API_PORT_BUSY';
    }
    const err = new Error(msg) as Error & { code?: string };
    err.code = code;
    return err;
  }

  /** 无 helper 时按端口清 9090 占用者：写临时脚本（避内联引号转义）→ osascript 提权跑（lsof → 是 sing-box 才杀）。 */
  private osascriptFreePort(port: number): Promise<'freed' | 'cancelled' | 'foreign'> {
    const scriptPath = path.join(getUserDataPath(), 'flowz-freeport.sh');
    // 用 ps -o comm=（仅可执行名，不含参数）判据：避免「参数里碰巧含 sing-box」的无辜进程被 root 误杀（M2）。
    // 杀掉的进程 cmdline 记到 KILLED 行供 app 落日志（killUserOrphansMac「不波及外部」承诺的口径透明化）。
    const script = `#!/bin/bash
pids=$(/usr/sbin/lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)
[ -z "$pids" ] && { echo FREED; exit 0; }
foreign=""; killed=""
for p in $pids; do
  comm=$(/bin/ps -o comm= -p $p 2>/dev/null)
  case "$comm" in
    *sing-box*) /bin/kill -9 $p 2>/dev/null; killed="$killed $p";;
    *) foreign="$foreign|$comm";;
  esac
done
[ -n "$killed" ] && echo "KILLED$killed"
[ -n "$foreign" ] && echo "FOREIGN$foreign" || echo FREED
`;
    try {
      require('fs').writeFileSync(scriptPath, script, { mode: 0o755 });
    } catch {
      return Promise.resolve('cancelled');
    }
    const cleanup = (): void => {
      try {
        require('fs').rmSync(scriptPath, { force: true });
      } catch {
        /* 忽略 */
      }
    };
    // 注：不再 mainWindow.show()/focus()——osascript `with administrator privileges` 的授权框是 SecurityAgent
    // 系统级 modal、自带置顶，不依赖 app 窗口可见；强行 show 隐藏窗口会经 'show' 把 Dock 图标拽回来（破坏
    // 「关窗=隐藏到托盘」的 Dock 状态机，是「程序坞关不掉」的副作用源）。有 120s 超时兜底，不会因不 show 而永挂。
    return new Promise((resolve) => {
      const proc = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "/bin/bash '${scriptPath}'" with administrator privileges`,
      ]);
      let out = '';
      let settled = false;
      const finish = (r: 'freed' | 'cancelled' | 'foreign'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(r);
      };
      // 硬超时：授权框被遮挡/无人应答 120s → 杀 osascript 按取消处理，绝不让 start() 永挂（修卡死诱因）。
      const timer = setTimeout(() => {
        this.logToManager('warn', `[clash_api] osascript 授权框 120s 未应答，按取消处理`);
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 忽略 */
        }
        finish('cancelled');
      }, 120_000);
      proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('close', (code) => {
        const k = out.match(/KILLED(.+)/);
        if (k)
          this.logToManager('info', `已提权按端口清掉占用 ${port} 的 sing-box: ${k[1].trim()}`);
        if (code !== 0)
          finish('cancelled'); // 用户取消授权(-128) 等
        else finish(out.includes('FOREIGN') ? 'foreign' : 'freed');
      });
      proc.on('error', () => finish('cancelled'));
    });
  }

  /** 当前出口 IP 探针端口；代理未启动或分配失败时返回 null。供 IpInfoService 取数用。 */
  getProbePorts(): { direct: number; proxy: number } | null {
    if (this.probeDirectPort && this.probeProxyPort) {
      return { direct: this.probeDirectPort, proxy: this.probeProxyPort };
    }
    return null;
  }

  /**
   * #57 resolve-ahead：本次预解析得到的节点 IP（写进了 outbound.server）。供 DiagnosticService 把这些
   * config.servers 之外的真实节点 IP 一并按节点身份脱敏（<ip-N>），杜绝漏进诊断报告（红线：零节点身份明文）。
   */
  /**
   * issue #147：起本地 race DNS server（race on）。raceServerPort>0 = 就绪 → getNodeResolverTag on→dns-node-race
   * + buildDnsConfig 生成该 server；off / 起失败 → port=0 降级单上游（绝不阻断 start，fail-open）。
   */
  private async startNodeDnsRaceServer(config: UserConfig): Promise<void> {
    this.raceServerPort = 0;
    this.raceUpstreamIps = [];
    if (config.dnsConfig?.resolveNodeDomainsAhead === false) {
      this.nodeDnsRaceServer.stop();
      return;
    }
    const dns = config.dnsConfig;
    const ups = resolveUpstreams(
      dns?.nodeResolverPool ?? DEFAULT_POOL_IDS,
      dns?.nodeResolverCustom
    );
    try {
      this.raceServerPort = await this.nodeDnsRaceServer.start(ups);
      this.raceUpstreamIps = ups.directIps; // §E.1：自定义上游 route 直连放行（内置已在 bootstrap-direct，重复无害）
      this.logToManager(
        'info',
        `节点域名 race 解析就绪：127.0.0.1:${this.raceServerPort}（Tier1 ${ups.tier1.length} / Tier2 ${ups.tier2.length}）`
      );
    } catch (e) {
      this.raceServerPort = 0;
      this.logToManager(
        'warn',
        `race server 启动失败，降级单上游(dns-bootstrap): ${(e as Error)?.message ?? e}`
      );
    }
  }

  /**
   * race server 未就绪（off / 起失败 / snapshot·preflight·诊断等非运行路径，raceServerPort=0）→ 强制 race off：
   * 使 getNodeResolverTag/buildDnsConfig 一致走单上游、不引用不存在的 dns-node-race（防 FATAL），且快照逐字节回现状。
   */
  private withRaceOff(config: UserConfig): UserConfig {
    return {
      ...config,
      dnsConfig: { ...config.dnsConfig, resolveNodeDomainsAhead: false } as UserConfig['dnsConfig'],
    };
  }

  /**
   * 生成 sing-box 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  generateSingBoxConfig(config: UserConfig, resolvedIps?: Record<string, string>): SingBoxConfig {
    // issue #147：race server 就绪(raceServerPort>0)才走 race 解析；否则（off/起失败/snapshot/preflight/诊断）
    // 强制 race off → getNodeResolverTag/buildDnsConfig 一致走单上游、不引用 dns-node-race（防 FATAL，快照零变化）。
    const cfg = this.raceServerPort > 0 ? config : this.withRaceOff(config);
    // 全局直连哨兵（#73 proxifier）：无真实选中节点，proxy-selector default=direct（在 buildOutbounds 内置）。
    const isDirect = isDirectSelection(config.selectedServerId);
    const selectedServer = isDirect
      ? null
      : (config.servers.find((s) => s.id === config.selectedServerId) ?? null);
    if (!isDirect) {
      if (!selectedServer) {
        throw new Error('Selected server not found');
      }
      // 选中节点不可用（naive 缺 libcronet）→ 明确报错，不静默切到别的节点（修 review M1）
      if (!isNodeUsable(selectedServer)) {
        throw new Error(this.naiveUnavailableReason(selectedServer));
      }
    }

    // 获取缓存数据库路径（experimental.cache_file）
    const cachePath = getCachePath();

    // 关键优化：预先生成 ID 到 Tag 的唯一映射，使用服务器名称作为 Tag，确保拓扑和日志显示友好名称
    // 这样做之后内容拓扑（Clash API）和日志中显示的将是“香港 01”而不是“proxy-uuid”。去重规则
    // （预占内置 tag + 撞名追加 (n)）抽到 buildIdToTagMap 单一真值，dns-builder 按名解析 tailscale endpoint 共用同一份。
    const idToTagMap = buildIdToTagMap(config.servers);
    // 记录本次生成的 id→tag 映射，供 clash_api 热切换定位 selector 成员 tag（见 hotSwitchNode）
    this.currentIdToTagMap = idToTagMap;

    // outbounds 须先于 route/endpoints 生成：其产出的两载体（pendingEndpoints / pendingRuleSelectors）
    // 由下方 route deps + endpoints 注入 + 末尾 currentRuleTargetMap 回填消费。回写 this.* 维持原时序。
    const outboundsResult = buildOutbounds(selectedServer, cfg, idToTagMap, {
      gateInvalidNodes: this.gateInvalidNodes,
      log: (level, message) => this.logToManager(level, message),
      // Phase 2：reverseMesh(system 内核接口)需提权,仅 TUN 模式可行（系统代理路径不提权）。非 TUN →
      // buildOutbounds 跳过 reverseMesh 节点不发射,避免内核接口创建失败致启动 FATAL。此判据取「会以提权跑」
      // 的下界(TUN);helper 实际就绪由连接闸门保证,maybePromptHelperGate 仅 macOS/Win 引导(Linux 另径),
      // 各平台 system 接口可创建性真机另验(设计 §11.6/11.7)。
      systemInterfaceAvailable: cfg.proxyModeType === 'tun',
    });
    this.pendingEndpoints = outboundsResult.pendingEndpoints;
    this.pendingRuleSelectors = outboundsResult.pendingRuleSelectors;

    const singboxConfig: SingBoxConfig = {
      log: buildLogConfig(config, this.privacyProvider()),
      dns: buildDnsConfig(
        cfg,
        'proxy-selector',
        this.lanResolverForDns,
        idToTagMap,
        (level, message) => this.logToManager(level, message),
        this.raceServerPort
      ),
      inbounds: buildInbounds(config, resolvedIps, {
        probeDirectPort: this.probeDirectPort,
        probeProxyPort: this.probeProxyPort,
      }),
      outbounds: outboundsResult.outbounds,
      route: buildRouteConfig(config, idToTagMap, {
        probeDirectPort: this.probeDirectPort,
        probeProxyPort: this.probeProxyPort,
        lanResolverForDns: this.lanResolverForDns,
        pendingEndpoints: this.pendingEndpoints,
        log: (level, message) => this.logToManager(level, message),
        onDegraded: () => {
          this.customRuleFilesDegraded = true;
        },
        // §E.1：race 就绪时把上游 IP 传给 route 做直连放行（防 TUN 回环）；未就绪路径恒 []（零变化）。
        raceUpstreamIps: this.raceServerPort > 0 ? this.raceUpstreamIps : [],
      }),
      experimental: {
        cache_file: {
          enabled: true,
          path: cachePath,
          store_fakeip: true,
          store_dns: true,
        },
      },
    };

    // WireGuard 等 endpoint 由 generateOutbounds 收进 pendingEndpoints，注入顶层 endpoints[]（其 tag 已在
    // proxy-selector / rule-sel / route 中作为成员被引用，与 outbound 一视同仁）。
    if (this.pendingEndpoints.length > 0) {
      singboxConfig.endpoints = this.pendingEndpoints;
    }

    // sing-box 1.14 管理 API：注入 api service（h2c gRPC，与 clash_api 共存、端口独立）。Tailscale 状态/登出经此。
    // hasManagementApi 门控（start 路径经 §5 守卫恒 ≥1.14；preflight/snapshot 以 <1.14 fixture 调时不注入，1.13 无 services schema 会 FATAL）。
    if (this.hasManagementApi()) {
      singboxConfig.services = [
        {
          type: 'api',
          listen: '127.0.0.1',
          listen_port: this.tailscaleApiPort,
          secret: config.clashApiSecret || undefined,
        },
      ];
      // sing-box 官方面板（opt-in 逃生舱）：仅开关 on 时注入 dashboard，于本 api service 的 /dashboard/ serve。
      // 关闭时不注入 → 核默认不出网拉 dashboard 资源。同一 service，不重复注入。
      // dashboard #55：path 指向「运行时下载覆盖 > 随包内置」目录 → 核 serve 本地文件、零联网下载、打开即时离线可用；
      //   两者皆无（异常打包且未下载）→ path 省略，核回落联网下载兜底（保旧行为，不 brick）。
      if (config.singboxDashboard) {
        const serveDir = resourceManager.resolveDashboardServeDir(getSingboxDashboardOverrideDir());
        singboxConfig.services[0].dashboard = serveDir
          ? { enabled: true, path: serveDir }
          : { enabled: true };
      }
    }

    // 路由规则若指向「已被跳过/不存在的出站」（如缺 libcronet 被跳过的 naive 节点），sing-box 会以
    // "outbound not found" 启动失败。统一把这类死引用修正为 selector（修 review H2：app/custom 分流
    // 指向被跳过 naive 节点的情况）。抽成方法供 gate 剔除后复用（A5 等价重构）。
    this.fixRouteDeadReferences(singboxConfig);

    // gate 已剔除的非法节点：onRetry 端口重分配会重新走 generateSingBoxConfig，上面的 idToTagMap 会把
    // 这些 id 的 tag 重新填回 → 删掉对应 entry，防 hotSwitchNode/reassertSelectorSelection 经 clash_api
    // PUT 复活幽灵 tag（generateOutbounds 的 gateInvalidNodes.has 跳过保证它们不进 outbounds/selector）。
    for (const id of this.gateInvalidNodes.keys()) {
      this.currentIdToTagMap?.delete(id);
    }

    // 回填 currentRuleTargetMap：ruleKey → { selectorTag, memberTag }，供「改规则目标节点」clash_api 热切换
    // 定位各 rule-sel selector。pendingRuleSelectors 由 generateRuleSelectors 填充（generateOutbounds 内）。
    // 仅保留仍存在于 outbounds 的 selector（detour 死引用剔除可能删空 rule-sel → 该 entry 不进 map，热切换
    // 跳过它、由 fixRouteDeadReferences 兜底改写的 proxy-selector 接管）。
    const liveSelectorTags = new Set(
      singboxConfig.outbounds
        .filter((o) => o.type === 'selector')
        .map((o) => o.tag)
        .filter((t): t is string => !!t)
    );
    this.currentRuleTargetMap = new Map(
      this.pendingRuleSelectors
        .filter((r) => liveSelectorTags.has(r.selectorTag))
        .map((r) => [r.ruleKey, { selectorTag: r.selectorTag, memberTag: r.memberTag }])
    );
    this.pendingRuleSelectors = [];

    this.logToManager(
      'debug',
      `配置已生成: inbounds=${singboxConfig.inbounds.length}, outbounds=${singboxConfig.outbounds.length}, rule_set=${singboxConfig.route?.rule_set?.length || 0}`
    );

    return singboxConfig;
  }

  /** 隐私模式 provider 注入（index：getPrivacyMode）：隐私开时 sing-box 日志级别经 effectiveLogLevel 抬到 ≥warn。 */
  setPrivacyProvider(fn: () => boolean): void {
    this.privacyProvider = fn;
  }

  /**
   * 获取 sing-box 日志文件路径
   */
  private getLogFilePath(): string {
    return getSingBoxLogPath();
  }

  /**
   * 清空 sing-box 日志文件
   * 在 Windows 和 macOS 上都能工作
   */
  async clearSingBoxLogFile(): Promise<void> {
    const logFilePath = this.getLogFilePath();
    try {
      // 清空日志文件（截断为空）
      await fs.writeFile(logFilePath, '', 'utf-8');
      this.logToManager('info', 'sing-box 日志文件已清空');
    } catch (error: any) {
      // 文件不存在，忽略
      if (error.code !== 'ENOENT') {
        this.logToManager('error', `清空 sing-box 日志文件失败: ${error.message}`);
      }
    }
  }

  /** 节点是否可用：naive 需要 libcronet 核心库，缺库时不可用（会被跳过、分流/选中回退到 selector）。 */
  /**
   * naive 节点因缺 libcronet 不可用时的用户可读原因，按平台/真因区分文案：
   * - copy-failed：内置库存在但拷贝到核心目录失败（权限/磁盘/AV），提示重启或修权限，而非误报"无预编译库"
   * - macOS no-lib：mac-x64 等未静态编入 cronet 的核心
   * - 其它 no-lib：linux/win 未随包提供 libcronet（如未跑 fetch-cronet）
   */
  private naiveUnavailableReason(server: ServerConfig): string {
    const status = resourceManager.getCronetLibStatus();
    if (status === 'copy-failed') {
      return `选中的节点「${server.name}」是 NaiveProxy：libcronet 核心库已内置，但拷贝到核心目录失败（可能是权限/磁盘空间/杀软占用）。请重启应用重试或检查目录权限；如仍失败，请改用其它协议的节点。`;
    }
    if (process.platform === 'darwin') {
      return `选中的节点「${server.name}」是 NaiveProxy，但当前 macOS 核心未内置 cronet（暂无官方预编译库）。请选择其它协议的节点。`;
    }
    return `选中的节点「${server.name}」是 NaiveProxy，但未找到 libcronet 核心库。请选择其它协议的节点。`;
  }

  /**
   * 供 SpeedTestService 复用：为单个节点生成**完整出站**（全协议，非仅 hy2/tuic），供临时测速 sing-box 经代理做
   * 真实 urltest（端口通≠代理可用，裸 TCP ping 测不出鉴权/中继失败）。
   *   - naive 缺 libcronet → 返回 null（跳过，避免临时核 FATAL 拖垮整批测速）。
   *   - 清空 detour：测速每节点独立、不接前置代理链（前置链不可达会污染单节点延迟判定）。
   *   - 解析器用 'dns-direct'（与 SpeedTestService 临时配置的 dns server tag 对齐）。
   */
  buildSpeedTestOutbound(
    server: ServerConfig,
    tag: string
  ): SingBoxOutbound | SingBoxEndpoint | null {
    try {
      if (!isNodeUsable(server)) return null;
      // 不可测节点（tailscale 账号制 / reverseMesh system 内核接口需提权 / 自定义 endpoint 类型）排除测速：
      // 与 isSpeedTestable 单一真值同口径——UI ⚡ 禁用、统一测速排除、本后端 null 分支三处共用，杜绝漂移。
      // （Tailscale=非即起即测临时隧道；system:true 内核接口创建失败会拖垮整批；自定义 endpoint type 分流会错放。）
      if (!isSpeedTestable(server)) return null;
      // WireGuard：endpoint（非 outbound）。SpeedTestService 据 type 放入测速临时配置的 endpoints[]。
      // 此处用 isEndpointProtocol 单一真值（tailscale 已上方 return null 排除，剩余 endpoint 协议即 wireguard）。
      if (isEndpointProtocol(server.protocol)) {
        // #58：测速 WG endpoint 的域名 server（如 WARP）需 dial 级 domain_resolver——与下方普通协议同传
        // 'dns-direct'（对齐测速临时配置的 route.default_domain_resolver: 'dns-direct'，223.5.5.5 UDP）。
        // 缺它则 1.14 域名拨号无确定解析上游 → 测速超时（IP-server 节点不受影响，isIpLiteral 内部跳过下发）。
        return buildWireGuardEndpoint(server, tag, 'dns-direct');
      }
      const map = new Map<string, string>([[server.id, tag]]);
      const ob = buildProxyOutbound(server, map, 'dns-direct');
      ob.tag = tag;
      delete ob.detour;
      return ob;
    } catch {
      return null;
    }
  }

  /**
   * 写入 sing-box 配置文件
   */
  private async writeSingBoxConfig(config: SingBoxConfig): Promise<void> {
    // 纵深防御（fail-closed 后通常为 no-op）：fail-closed 改造后 generateRouteConfig 已不生成任何 type:'remote'
    // rule_set（所有 srs 统一本地、缺失剪悬空引用），故此处恒早退、零开销；保留作回滚锚点 + 防御任何未来/旁路
    // 路径意外注入 remote 时仍预检 404 剔除，杜绝 sing-box `initialize rule-set` FATAL。
    await this.pruneUnreachableRemoteRuleSets(config);
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.configPath, content, 'utf-8');
  }

  /**
   * 对已写盘的 configPath 跑一次 `sing-box check`（复用 CoreUpdateService.preflightValidate 的 execFile 模式）。
   * - **spawn 层错误**（code 为字符串 errno，如 ENOENT/EACCES）或 **超时**（killed）→ `{ failOpen: true }`：
   *   gate 跳过、直接启动（终态=现状，无回归）——核心缺失/无权限/慢盘不该把启动卡死。
   * - **真实 check 失败**（退出码 1）→ `{ stderr }`（已过 removeAnsiCodes）：fail-closed，交由剔除逻辑处理。
   * - 通过（退出码 0）→ `{ ok: true }`。
   */
  private async runSingBoxCheck(
    configPath: string
  ): Promise<{ ok?: true; stderr?: string; failOpen?: true }> {
    const execFileAsync = require('util').promisify(require('child_process').execFile);
    try {
      await execFileAsync(this.singboxPath, ['check', '-c', configPath], {
        windowsHide: true,
        timeout: 15000,
      });
      return { ok: true };
    } catch (e: any) {
      // 超时被 kill：execFile 置 e.killed=true（且常带 SIGTERM）。慢盘/卡死 → fail-open，不阻断启动。
      if (e?.killed) return { failOpen: true };
      // spawn 层失败：errno 形如 'ENOENT'/'EACCES'（字符串），区别于 check 失败的数字退出码 1。
      if (typeof e?.code === 'string') return { failOpen: true };
      const stderr = this.removeAnsiCodes(String(e?.stderr || e?.message || e));
      return { stderr };
    }
  }

  /** 自定义协议兼容性 probe 的结果缓存：键 = 内核身份(版本) + outbound 规范化哈希；换核（版本变）键变、天然失效。 */
  private probeCache = new Map<string, { ok: boolean; error?: string }>();

  /**
   * 用当前内核 probe 一个 outbound/endpoint 是否被支持（自定义协议门控的单一真值 = 内核本身）：
   * 写一份最小 config（仅该出站 + direct）跑 `sing-box check`，`unknown outbound type` 等即不支持。
   * 主进程子进程、结果缓存 → 渲染端异步调用不阻塞 UI。失败（spawn/超时）按「无法判定」返回 ok:false 带原因。
   */
  async probeOutbound(
    outbound: unknown,
    isEndpoint = false
  ): Promise<{ ok: boolean; indeterminate?: boolean; error?: string }> {
    if (
      !outbound ||
      typeof outbound !== 'object' ||
      Array.isArray(outbound) ||
      typeof (outbound as any).type !== 'string'
    ) {
      return { ok: false, error: 'invalid outbound: must be an object with a string "type"' };
    }
    const crypto = require('crypto');
    const version = await this.getCoreVersion().catch(() => 'unknown');
    // 内核身份含二进制 size+mtime：fork 版本号撞官方（同 version）但换了二进制时，键变、缓存自动失效。
    let binId = 'na';
    try {
      const st = require('fs').statSync(this.singboxPath);
      binId = `${st.size}-${Math.round(st.mtimeMs)}`;
    } catch {
      /* 核缺失：用 version 兜底键 */
    }
    const norm = JSON.stringify(outbound);
    const key = `${version}|${binId}|${isEndpoint ? 'ep' : 'ob'}|${crypto.createHash('sha1').update(norm).digest('hex')}`;
    const cached = this.probeCache.get(key);
    if (cached) return cached;

    const probe = { ...(outbound as Record<string, unknown>), tag: 'probe' };
    const minimal = isEndpoint
      ? {
          log: { level: 'fatal' },
          endpoints: [probe],
          outbounds: [{ type: 'direct', tag: 'direct' }],
          route: { final: 'direct' },
        }
      : {
          log: { level: 'fatal' },
          outbounds: [probe, { type: 'direct', tag: 'direct' }],
          route: { final: 'direct' },
        };

    const fs = require('fs');
    const tmp = path.join(getUserDataPath(), `probe-${crypto.randomBytes(6).toString('hex')}.json`);
    let result: { ok: boolean; indeterminate?: boolean; error?: string };
    try {
      fs.writeFileSync(tmp, JSON.stringify(minimal));
      const r = await this.runSingBoxCheck(tmp);
      if (r.ok) result = { ok: true };
      // failOpen（核缺失/超时/慢盘）≠ 不兼容 → indeterminate，渲染端给中性「无法判定」而非红色「不支持」。
      else if (r.failOpen)
        result = { ok: false, indeterminate: true, error: '内核不可用或超时，无法判定兼容性' };
      else result = { ok: false, error: (r.stderr || 'check failed').slice(0, 300) };
    } catch (e: any) {
      result = { ok: false, error: String(e?.message ?? e) };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 已不存在/无权限：忽略 */
      }
    }
    this.probeCache.set(key, result);
    return result;
  }

  /**
   * 启动前配置校验 gate：对已写盘配置跑 `sing-box check`，把会致整体启动 FATAL 的坏节点（未知 cipher /
   * ss2022 坏 key / 未知 plugin / naive alpn 等字段级问题）迭代剔除后重写盘，直到 check 通过或触上限。
   *
   * 设计要点（见 docs/design/config-validation-startup-gate.md）：
   * - 插在 writeSingBoxConfig 后、retry(startSingBoxProcess) 前 → 抛错由 start() catch 收口，不进 retry。
   * - check fail-fast 一次报一个下标 → 逐轮剔除收敛；上限 min(50, 节点数)。
   * - 选中节点被 check 标中 → throw「请更换节点」（决策①，不自动回退，与 naive M1 同语义）。
   * - 正则不命中 / 越界 / 命中非节点出站（selector/direct/block/probe）→ 降级 throw「配置校验失败」不启动
   *   （不比现状差，且不误剔）；spawn 错 / 超时 → fail-open 跳过 gate。
   */
  private async checkAndPruneConfig(
    singboxConfig: SingBoxConfig,
    config: UserConfig
  ): Promise<void> {
    const maxPrunes = Math.min(50, config.servers.length || 0);
    let prunes = 0;

    while (true) {
      const res = await this.runSingBoxCheck(this.configPath);
      if (res.ok) break;
      if (res.failOpen) {
        this.logToManager(
          'warn',
          '启动前配置校验跳过（核心不可执行/校验超时），按现有配置直接启动'
        );
        break;
      }

      const stderr = res.stderr || '';
      const firstLine = stderr.split('\n')[0]?.trim() || stderr.trim();

      if (prunes >= maxPrunes) {
        throw new Error(`配置校验失败：已剔除 ${prunes} 个非法节点仍无法通过校验（${firstLine}）`);
      }

      // 先按 outbounds[N] 反查；未命中再按 endpoints[N]（自定义 endpoint 用不兼容 type → endpoints[N] 报错，
      // 否则整体启动失败而非剪单点）。两者命中域互斥（'endpoints' 不含 'outbound'）。
      const obIdx = parseCheckOutboundIndex(stderr);
      const epIdx = obIdx === null ? parseCheckEndpointIndex(stderr) : null;
      let flagged: { type: string; tag: string } | undefined;
      if (obIdx !== null && obIdx >= 0 && obIdx < singboxConfig.outbounds.length) {
        flagged = singboxConfig.outbounds[obIdx];
      } else if (epIdx !== null && epIdx >= 0 && epIdx < (singboxConfig.endpoints?.length ?? 0)) {
        flagged = singboxConfig.endpoints![epIdx];
      }
      if (!flagged) {
        throw new Error(`配置校验失败：${firstLine}`);
      }
      // 命中非节点出站（内置出站/探针）→ 不是坏节点问题，降级不启动（避免误剔内置出站致更大故障）。
      const NON_NODE_TYPES = new Set(['selector', 'urltest', 'direct', 'block']);
      const isProbeOrBuiltin =
        NON_NODE_TYPES.has(flagged.type) ||
        flagged.tag === 'proxy-selector' ||
        flagged.tag === 'probe-direct-in' ||
        flagged.tag === 'probe-proxy-in';
      if (isProbeOrBuiltin) {
        throw new Error(`配置校验失败：${firstLine}`);
      }

      // tag 反查 serverId：shadowtls 外层出站 tag 形如 `stls-out-<id>`，截前缀；其余经 idToTagMap 反查。
      let serverId: string | undefined;
      if (flagged.tag.startsWith('stls-out-')) {
        serverId = flagged.tag.slice('stls-out-'.length);
      } else {
        for (const [id, tag] of this.currentIdToTagMap ?? []) {
          if (tag === flagged.tag) {
            serverId = id;
            break;
          }
        }
      }
      // 反查不到 serverId（理论不应发生）→ 降级不启动，不盲剔。
      if (!serverId) {
        throw new Error(`配置校验失败：${firstLine}`);
      }
      // 决策①：选中节点被标中 → 报错让用户换，不自动回退到其它节点。
      if (serverId === config.selectedServerId) {
        throw new Error(`选中节点「${flagged.tag}」配置无效，无法启动，请更换节点后重试`);
      }

      // 级联剔除该节点（含 detour 引用方、shadow-tls 配对）+ 重写盘后进入下一轮 check。
      this.pruneTagsClosure(singboxConfig, config, new Set([flagged.tag]), 'check');
      prunes++;
      await this.writeSingBoxConfig(singboxConfig);
    }

    if (prunes > 0) {
      this.logToManager('warn', `启动前配置校验剔除了 ${prunes} 个非法节点，已用剩余节点启动`);
    }
    // 空数组也发：清除上次启动遗留的标灰（节点修好/换核复活后 UI 即恢复）。
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_INVALID_NODES, [
      ...this.gateInvalidNodes.values(),
    ]);
  }

  /**
   * 剔除指定 tag 的节点出站并级联修正（gate 主路径与 run-FATAL 备用腿共用）：
   * ① 级联闭包：detour 指向被剔 tag 的节点出站一并剔（**不删 detour 字段**——静默降级为直连会改变流量
   *    路径、有隐私风险，与 M1 不静默切换一致）；shadow-tls 内层节点与其 `stls-out-*` 外层互相配对同剔；
   *    若级联触及选中节点 → throw（决策①）。
   * ② 删 outbound（含 stls 孤儿）。
   * ③ group（selector/urltest）成员删 tag + default 修正 + proxy-selector 剔空 throw。
   * ④ fixRouteDeadReferences（route 死引用 → proxy-selector）。
   * ⑤ idToTagMap 删 entry（防 hotSwitchNode PUT 幽灵 tag）+ gateInvalidNodes 记录 + warn。
   *
   * @param seedTags 起始要剔除的 outbound tag 集合
   * @param origin   'check'=被 check 直接标中 / 'detour'=detour 死引用预校验标中（仅影响 reason 文案）
   */
  private pruneTagsClosure(
    singboxConfig: SingBoxConfig,
    config: UserConfig,
    seedTags: Set<string>,
    origin: 'check' | 'detour'
  ): void {
    // tag → serverId 反查（含 stls-out- 前缀），用于级联与 gateInvalidNodes 记录。
    const tagToServerId = (tag: string): string | undefined => {
      if (tag.startsWith('stls-out-')) return tag.slice('stls-out-'.length);
      for (const [id, t] of this.currentIdToTagMap ?? []) {
        if (t === tag) return id;
      }
      return undefined;
    };

    // ① 级联闭包：BFS 收集所有需剔除的 tag。
    const toRemove = new Set<string>();
    const queue: string[] = [...seedTags];
    while (queue.length > 0) {
      const tag = queue.shift() as string;
      if (toRemove.has(tag)) continue;
      toRemove.add(tag);

      // shadow-tls 配对：内层节点 tag ↔ 其外层 `stls-out-<id>` 互相牵连。
      const sid = tagToServerId(tag);
      if (sid) {
        const stlsTag = `stls-out-${sid}`;
        if (singboxConfig.outbounds.some((o) => o.tag === stlsTag) && !toRemove.has(stlsTag)) {
          queue.push(stlsTag);
        }
      }
      // 若被剔的是某节点的 stls 外层，则其内层主节点（detour 指向它者）会在下面 detour 扫描里被牵出。

      // detour 引用方级联：任何 detour 指向 toRemove 中 tag 的节点出站，一并剔（不静默改直连）。
      for (const ob of singboxConfig.outbounds) {
        if (ob.detour && toRemove.has(ob.detour) && !toRemove.has(ob.tag)) {
          queue.push(ob.tag);
        }
      }
    }

    // 级联触及选中节点 → throw（决策①）：选中节点不可被静默剔除/降级。
    const selectedTag = config.selectedServerId
      ? this.currentIdToTagMap?.get(config.selectedServerId)
      : undefined;
    if (selectedTag && toRemove.has(selectedTag)) {
      throw new Error(`选中节点「${selectedTag}」配置无效或其代理链依赖无效节点，请更换节点后重试`);
    }

    // ② 删 outbound（含 endpoint）。
    singboxConfig.outbounds = singboxConfig.outbounds.filter((o) => !toRemove.has(o.tag));
    if (singboxConfig.endpoints) {
      singboxConfig.endpoints = singboxConfig.endpoints.filter((e) => !toRemove.has(e.tag));
    }

    // ③ group 成员删 tag + default 修正 + proxy-selector 剔空 throw。
    for (const ob of singboxConfig.outbounds) {
      if ((ob.type === 'selector' || ob.type === 'urltest') && Array.isArray(ob.outbounds)) {
        ob.outbounds = ob.outbounds.filter((t) => !toRemove.has(t));
        if (ob.tag === 'proxy-selector' && ob.outbounds.length === 0) {
          throw new Error('没有可用的代理节点出站（全部节点未通过启动前配置校验）');
        }
        if (ob.default && toRemove.has(ob.default)) {
          ob.default = prunedSelectorDefault(ob.tag, ob.outbounds);
        }
      }
    }

    // ④ route 死引用修正回 proxy-selector。
    this.fixRouteDeadReferences(singboxConfig);

    // ⑤ idToTagMap 删 entry + gateInvalidNodes 记录 + warn。
    for (const tag of toRemove) {
      const sid = tagToServerId(tag);
      if (sid) {
        this.currentIdToTagMap?.delete(sid);
        if (!this.gateInvalidNodes.has(sid)) {
          const reason =
            origin === 'detour'
              ? '代理链依赖的前置节点无效（detour 引用不存在）'
              : seedTags.has(tag)
                ? '配置无法通过 sing-box 校验'
                : '所依赖的节点被剔除（级联）';
          this.gateInvalidNodes.set(sid, { id: sid, tag, reason });
        }
      }
      this.logToManager('warn', `启动前配置校验已剔除非法出站「${tag}」`);
    }
  }

  /**
   * selector default 命中被剔节点时的回落（MED-1）：
   * - rule-sel-*：回落 'proxy-selector'（跟全局，与 generateRuleSelectors「目标无效→proxy-selector」语义一致），
   *   而非剩余首个**节点**——后者会令固定节点规则静默绑到「碰巧排第一的节点」、违背 anti-drift 设计意图。
   * - proxy-selector / urltest 自身：仍落剩余首成员（首存活节点是正确兜底）。
   * 注：rule-sel 的 outbounds 恒含 'proxy-selector'（generateRuleSelectors emit），故该回落目标必有效。
   */
  /**
   * route 规则指向「已被剔除/不存在的出站」（死引用）→ 统一修正为 proxy-selector，避免 sing-box 以
   * "outbound not found" 启动失败。从 generateSingBoxConfig 末尾抽出的纯等价重构（A5），gate 剔除后复用。
   */
  private fixRouteDeadReferences(singboxConfig: SingBoxConfig): void {
    const validTags = new Set(
      [
        ...singboxConfig.outbounds.map((o) => o.tag),
        ...(singboxConfig.endpoints ?? []).map((e) => e.tag),
      ].filter((t): t is string => !!t)
    );
    for (const rule of singboxConfig.route?.rules ?? []) {
      const r = rule as { action?: string; outbound?: string };
      if (r.action === 'route' && r.outbound && !validTags.has(r.outbound)) {
        r.outbound = 'proxy-selector';
      }
    }
  }

  /**
   * 【fail-closed 后通常为 no-op】运行期已不生成 type:'remote' rule_set，此函数 remote.length===0 恒早退；
   * 保留作纵深防御（防未来/旁路意外注入 remote）+ 回滚锚点。applyRuleSetPrune 仍被「悬空引用剪枝」复用。
   *
   * 远程 geo rule_set 可达性预检 + 剪枝（防"资源不存在→sing-box initialize rule-set 404 FATAL→整个代理崩溃"）。
   * sing-box 对任一 remote rule_set 取回 404 会**整体 FATAL**（非跳过）。内置预设标签均已对 MetaCubeX 实测可达，
   * 但用户自定义规则/预设引用的非常规分类仍可能 404。此处对所有 type:'remote' 的 rule_set 做 HEAD 预检：
   *   - 确定缺失（404/403/410）→ 丢弃该 rule_set 定义 + 从路由规则的 rule_set 引用中剔除；rule_set 清空的规则整条丢弃
   *     （即"资源不存在则该规则停止生效"，对齐需求；应用分流的 process_name 规则是独立规则、仍覆盖该 app）。
   *   - 瞬时错误（超时/5xx/网络错）→ 乐观保留（不剪），交由 sing-box 自带下载重试/缓存（避免一次抖动丢有效路由）。
   * 仅在存在 remote rule_set 时才有网络开销；默认 smart 模式（geo 走本地 bundled .srs）零开销。
   */
  private async pruneUnreachableRemoteRuleSets(singboxConfig: SingBoxConfig): Promise<void> {
    const remote = (singboxConfig.route?.rule_set ?? []).filter(
      (rs) => rs.type === 'remote' && typeof rs.url === 'string' && !!rs.tag
    );
    if (remote.length === 0) return;
    // 总超时上限(6s)：弱网首次冷启动(无缓存)不阻塞数十秒——超时则乐观全保留(不剪,交 sing-box 下载重试)。
    // 各 HEAD 仍有 4s 自超时,这里只是 wall-clock 兜底;Promise.all 先到用真实结果,6s 到用乐观(全 reachable)。
    const optimistic: { tag: string; reachable: boolean }[] = remote.map((rs) => ({
      tag: rs.tag,
      reachable: true,
    }));
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutFallback = new Promise<{ tag: string; reachable: boolean }[]>((resolve) => {
      raceTimer = setTimeout(() => resolve(optimistic), 6000);
    });
    const checks = await Promise.race([
      Promise.all(
        remote.map(async (rs) => ({
          tag: rs.tag,
          reachable: await this.isRemoteRuleSetReachable(rs.url as string),
        }))
      ),
      timeoutFallback,
    ]);
    if (raceTimer) clearTimeout(raceTimer);
    const unreachable = new Set(checks.filter((c) => !c.reachable).map((c) => c.tag));
    const dropped = applyRuleSetPrune(singboxConfig, unreachable);
    if (dropped.length > 0) {
      this.logToManager(
        'warn',
        `规则资源：${dropped.length} 个远程规则集在源上不存在(404)，已停用相关规则以避免代理启动失败：` +
          `${dropped.join(', ')}（应用分流仍按进程名等其余规则生效）`
      );
    }
  }

  /**
   * 纯逻辑剪枝（无 I/O，可单测）：从 singbox 配置中剔除 `unreachable` 集合内的 rule_set tag —
   *   ① 删 route.rule_set 中的对应定义；
   *   ② 路由规则的 `rule_set`（string | string[]）剔除这些 tag；剔空则整条规则丢弃（含 logical 子规则递归）。
   * 返回实际丢弃的 rule_set tag 列表。本地 bundled rule_set（geosite-cn 等，非 remote）永不入 `unreachable`，不受影响。
   */

  /**
   * HEAD 预检单个远程 rule_set URL 是否存在。仅"确定缺失"(404/403/410) 返回 false→剪枝；2xx/3xx 返回 true；
   * 瞬时错误（超时/5xx/网络错）乐观返回 true（不剪，交 sing-box 下载重试）。结果按"确定结论"缓存（见 ruleSetReachCache）。
   */
  private isRemoteRuleSetReachable(url: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.ruleSetReachCache.get(url);
    if (cached && now - cached.at < (cached.reachable ? 6 * 3600_000 : 30 * 60_000)) {
      return Promise.resolve(cached.reachable);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (reachable: boolean, definitive: boolean) => {
        if (settled) return;
        settled = true;
        if (definitive) this.ruleSetReachCache.set(url, { reachable, at: now });
        resolve(reachable);
      };
      try {
        const u = new URL(url);
        const req = https.request(
          { method: 'HEAD', host: u.host, path: u.pathname + u.search, timeout: 4000 },
          (res) => {
            const code = res.statusCode ?? 0;
            res.resume(); // 释放 socket
            if (code === 404 || code === 403 || code === 410) done(false, true);
            else if (code >= 200 && code < 400) done(true, true);
            else done(true, false); // 5xx 等瞬时 → 乐观保留、不缓存
          }
        );
        req.on('timeout', () => {
          req.destroy();
          done(true, false);
        });
        req.on('error', () => done(true, false));
        req.end();
      } catch {
        done(true, false);
      }
    });
  }

  /**
   * 检查当前配置是否需要 root/admin 权限（TUN 模式）。
   * Windows/macOS/Linux TUN 模式都需要管理员权限。
   *
   * T16 子 commit 5：实现迁入 PlatformPrivilegeService.needsPrivilege，此处 thin wrapper delegate
   * （resolveClashApiPortConflict / startSingBoxProcess / ensureLinuxTunCapabilities 等多处调用零改动）；
   * 未注入时保留原实现兜底（防 index.ts 装配前调用）。
   */
  private needsRootPrivilege(): boolean {
    if (this.privilegeService) return this.privilegeService.needsPrivilege();
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    // Windows, macOS, and Linux TUN 模式都需要管理员权限
    return (
      isTunMode &&
      (process.platform === 'darwin' ||
        process.platform === 'win32' ||
        process.platform === 'linux')
    );
  }

  /**
   * 检查是否需要使用 osascript 运行（仅 macOS）。
   * T16 子 commit 5：thin wrapper，内部经 needsRootPrivilege delegate 到 service.needsPrivilege。
   * 保留 wrapper：resolveClashApiPortConflict / startSingBoxProcess 等 ~10 处调用零改动。
   */
  private needsOsascript(): boolean {
    return process.platform === 'darwin' && this.needsRootPrivilege();
  }

  /**
   * 检查是否需要使用 UAC 提升权限运行（仅 Windows TUN 模式）。
   * T16 子 commit 5：thin wrapper（同 needsOsascript），内部 delegate 到 service.needsPrivilege。
   */
  private needsWindowsUAC(): boolean {
    return process.platform === 'win32' && this.needsRootPrivilege();
  }

  /** shell 单引号转义（防注入），与 HelperManager.shq 同形。delegate → PlatformPrivilegeService（T16 子 commit 1）。 */
  private shq(s: string): string {
    return this.privilegeService?.shq(s) ?? `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /**
   * 运行命令并捕获 stdout（出错 reject）。用于 getcap 探测。
   * delegate → PlatformPrivilegeService（T16 子 commit 1）；未注入时保留原实现兜底（防 index.ts 装配前调用）。
   */
  private execCapture(bin: string, args: string[]): Promise<string> {
    if (this.privilegeService) return this.privilegeService.execCapture(bin, args);
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args);
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('exit', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  /**
   * 以 pkexec(root) 跑 bash 脚本（弹一次密码框）。区分取消(126)/无认证代理(127)。
   * delegate → PlatformPrivilegeService（T16 子 commit 1）；未注入时保留原实现兜底。
   */
  private runPkexecScript(scriptPath: string): Promise<{ success: boolean; error?: string }> {
    if (this.privilegeService) return this.privilegeService.runPkexecScript(scriptPath);
    return new Promise((resolve) => {
      const proc = spawn('/usr/bin/pkexec', ['/bin/bash', scriptPath]);
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('exit', (code) => {
        if (code === 0) resolve({ success: true });
        else if (code === 126) resolve({ success: false, error: '授权被取消' });
        else if (code === 127)
          resolve({ success: false, error: '授权失败或系统缺少 polkit 认证代理' });
        else if (code === 3) resolve({ success: false, error: '系统缺少 setcap（libcap2-bin）' });
        else resolve({ success: false, error: stderr.trim() || `pkexec 退出码 ${code}` });
      });
      proc.on('error', (err) => resolve({ success: false, error: err.message }));
    });
  }

  /**
   * 生成 Linux TUN 提权脚本：setcap 赋权 + 安装限定用户的 resolve1 polkit 规则（含 0.105 .pkla 回退）。
   * delegate → PlatformPrivilegeService（T16 子 commit 1）；未注入时保留原实现兜底。
   */
  private buildLinuxTunSetupScript(corePath: string, user: string, rulesFile: string): string {
    if (this.privilegeService)
      return this.privilegeService.buildLinuxTunSetupScript(corePath, user, rulesFile);
    // user 已经白名单校验（[a-z0-9_.@-]），可安全嵌入 heredoc 字面量
    return `#!/bin/bash
set -e
CORE=${this.shq(corePath)}
RULES=${this.shq(rulesFile)}
SETCAP="$(command -v setcap || echo /usr/sbin/setcap)"
# setcap 缺失（精简 Debian 无 libcap2-bin）→ 用退出码 3 区分于 pkexec 的 126/127（P3-1）
[ -x "$SETCAP" ] || { echo "setcap 未安装(libcap)" >&2; exit 3; }
"$SETCAP" 'cap_net_admin,cap_net_bind_service,cap_net_raw=+ep' "$CORE"
mkdir -p /etc/polkit-1/rules.d
cat > "$RULES" <<'EOF'
// FlowZ: 允许指定用户改 systemd-resolved 链路 DNS（TUN auto_route 免逐条密码框）。手动删除本文件即恢复默认。
polkit.addRule(function(action, subject) {
  if (action.id.indexOf("org.freedesktop.resolve1.") === 0 &&
      subject.user === "${user}" && subject.local && subject.active) {
    return polkit.Result.YES;
  }
});
EOF
# 0.105 .pkla 回退：只要 polkit localauthority 父目录在就建 50-local.d 并写（P3-2，放宽过严条件）
PKLA_DIR=/etc/polkit-1/localauthority/50-local.d
if [ -d /etc/polkit-1/localauthority ]; then
  mkdir -p "$PKLA_DIR"
  cat > "$PKLA_DIR/49-flowz-resolved.pkla" <<'EOF2'
[FlowZ resolved DNS]
Identity=unix-user:${user}
Action=org.freedesktop.resolve1.*
ResultActive=yes
EOF2
fi
echo flowz-linux-tun-setup-ok
`;
  }

  /**
   * Linux TUN：确保打包核心具备 TUN 所需 capabilities，并安装一条「仅当前用户改 systemd-resolved
   * 链路 DNS」的 polkit 规则——否则 sing-box(auto_route) 经 resolve1 D-Bus 设 DNS 时，polkit 按 uid
   * （非 root）逐条弹 4 次密码框（issue #33）。一次 pkexec 同做 setcap + 写规则；幂等：caps 已具备且
   * 规则文件已存在则零弹窗直接返回。授权取消 → 抛含「权限」的错误命中 nonRetryableErrors，不重试连弹。
   * 仅 Linux TUN 生效；root 运行整 app 时跳过。
   *
   * T16 子 commit 4：实现迁入 PlatformPrivilegeService.ensureCapabilities，此处 delegate；
   * 未注入时保留原实现兜底（防 index.ts 装配前调用）。
   */
  private async ensureLinuxTunCapabilities(): Promise<void> {
    if (this.privilegeService) return this.privilegeService.ensureCapabilities();
    if (process.platform !== 'linux' || !this.needsRootPrivilege()) return;
    // 以 root 跑整个 app → 已有全部权限，无需 pkexec
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const fs = require('fs');
    const corePath = this.singboxPath;
    const rulesFile = '/etc/polkit-1/rules.d/49-flowz-resolved.rules';

    // 核心不存在 → 直接报「找不到」（命中 nonRetryableErrors），不白弹密码框（P2-3）
    if (!fs.existsSync(corePath)) {
      throw new Error(`找不到 sing-box 可执行文件: ${corePath}`);
    }

    // 定位 getcap（普通用户 PATH 常不含 /usr/sbin）；绝对路径都不在则退回裸名走 PATH（P2-1）
    const getcapBin =
      ['/usr/sbin/getcap', '/sbin/getcap', '/usr/bin/getcap'].find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) || 'getcap';

    // true=有 caps，false=无 caps，null=getcap 不可用（无法判定，复检时以脚本退出码为准）
    const probeCaps = async (): Promise<boolean | null> => {
      try {
        return /cap_net_admin/.test(await this.execCapture(getcapBin, [corePath]));
      } catch {
        return null;
      }
    };

    let rulesExist = false;
    try {
      rulesExist = fs.existsSync(rulesFile);
    } catch {
      /* ignore */
    }

    // 已具备 caps 且规则文件已存在 → 零弹窗
    if ((await probeCaps()) === true && rulesExist) return;

    // 当前用户名（白名单校验，杜绝注入）。允许企业目录用户名常见的 . 与 @（SSSD/AD），
    // 三处嵌入上下文（quoted-heredoc / JS 双引号串 / .pkla 值）对 . @ 均安全。
    let user = '';
    try {
      user = require('os').userInfo().username;
    } catch {
      /* fallthrough */
    }
    if (!user) {
      throw new Error('TUN 模式需要管理员权限：无法确定当前用户名，请手动配置 setcap');
    }
    if (!/^[a-z_][a-z0-9_.@-]*$/i.test(user)) {
      throw new Error(`TUN 模式需要管理员权限：用户名 "${user}" 含不支持的字符，请手动配置 setcap`);
    }

    this.logToManager(
      'info',
      'Linux TUN 首次配置：请求一次管理员授权（赋核心网络权限 + 安装 DNS polkit 规则）...'
    );

    const scriptPath = path.join(getUserDataPath(), 'flowz-linux-tun-setup.sh');
    try {
      fs.writeFileSync(scriptPath, this.buildLinuxTunSetupScript(corePath, user, rulesFile), {
        mode: 0o755,
      });
    } catch (e) {
      throw new Error(
        `TUN 模式需要管理员权限：无法写入提权脚本 (${e instanceof Error ? e.message : String(e)})`
      );
    }

    const result = await this.runPkexecScript(scriptPath);
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* 忽略 */
    }

    // 复检 caps。getcap 不可用（null）时无法验证 → 信任脚本退出码（set -e + 末行 echo 保证 setcap
    // 成功才退 0）。仅当「getcap 明确说无 caps」或「getcap 不可用且脚本失败」才判失败（P2-1）。
    const post = await probeCaps();
    if (post === false || (post === null && !result.success)) {
      throw new Error(
        `TUN 模式需要管理员权限：${result.error || '授权被取消或系统缺少 polkit 认证代理'}。` +
          `可手动执行: sudo setcap 'cap_net_admin,cap_net_bind_service,cap_net_raw=+ep' "${corePath}"`
      );
    }
    this.logToManager('info', 'Linux TUN 提权配置完成（核心已赋权，DNS polkit 规则已安装）');
  }

  /**
   * 修复可能被 root 创建的文件权限（macOS）
   * 当从 TUN 模式切换到系统代理模式时，某些文件可能仍然属于 root
   * 需要在普通用户模式下修复这些文件的权限
   */
  private async fixFilePermissions(): Promise<void> {
    // delegate → PlatformPrivilegeService（T16 子 commit 1：ctx.isTunMode 替代原 needsRootPrivilege 读取）；
    // 未注入时保留原实现兜底（防 index.ts 装配前调用）。
    if (this.privilegeService) return this.privilegeService.fixFilePermissions();
    // 只在 macOS 上需要处理
    if (process.platform !== 'darwin') {
      return;
    }

    // 如果是 TUN 模式，不需要修复（会以 root 权限运行）
    if (this.needsRootPrivilege()) {
      return;
    }

    const userDataPath = getUserDataPath();
    const filesToFix = [
      getCachePath(),
      getSingBoxLogPath(),
      getSingBoxPidPath(),
      path.join(userDataPath, 'singbox_startup.log'),
    ];

    const fsSync = require('fs');
    const { execSync } = require('child_process');

    for (const filePath of filesToFix) {
      try {
        if (fsSync.existsSync(filePath)) {
          const stats = fsSync.statSync(filePath);
          // 检查文件是否属于 root (uid 0)
          if (stats.uid === 0) {
            this.logToManager('info', `修复文件权限: ${filePath}`);
            // 使用 chown 修改文件所有权为当前用户
            const currentUser = process.env.USER || process.env.LOGNAME;
            if (currentUser) {
              try {
                // 尝试使用 chown（可能需要密码）
                execSync(`chown ${currentUser} "${filePath}"`, { stdio: 'ignore' });
              } catch {
                // 如果 chown 失败，尝试删除文件让 sing-box 重新创建
                try {
                  fsSync.unlinkSync(filePath);
                  this.logToManager('info', `已删除需要重新创建的文件: ${filePath}`);
                } catch {
                  this.logToManager(
                    'warn',
                    `无法修复文件权限: ${filePath}，请手动删除或运行: sudo chown ${currentUser} "${filePath}"`
                  );
                }
              }
            }
          }
        }
      } catch {
        // 忽略检查错误
      }
    }
  }

  /**
   * 启动 sing-box 进程
   */
  /** macOS root 看护脚本路径（osascript 以 root 执行它来托管 sing-box）。 */
  private getWrapperScriptPath(): string {
    return path.join(getUserDataPath(), 'singbox-wrapper.sh');
  }

  /**
   * 停止信号文件：app 以普通用户写入，root 看护脚本检测到后自杀 sing-box —— 停止无需再次提权。
   * T16 子 commit 3：改 public 供 PlatformPrivilegeService.ctx.stopFlagPath 回调注入。
   */
  getStopFlagPath(): string {
    return path.join(getUserDataPath(), 'singbox.stopflag');
  }

  /**
   * 写出 macOS root 看护脚本。设计：osascript 一次授权后以 root 跑此脚本 → 它起 sing-box 并循环监听
   * stopflag(普通用户可写)与父进程(Electron)存活；二者任一触发即 TERM→(等待)→KILL sing-box 并清理。
   * 收益：停止/退出/崩溃回收均无需再次管理员授权（仅启动那一次）。app 退出时父进程消失 → 不留孤儿。
   */
  private writeWrapperScript(): void {
    // delegate → PlatformPrivilegeService（T16 子 commit 1）；未注入时保留原实现兜底。
    if (this.privilegeService) {
      this.privilegeService.writeWrapperScript();
      return;
    }
    const script = `#!/bin/bash
# FlowZ 看护脚本（osascript 以 root 执行）；勿手改。
SB="$1"; CFG="$2"; LOG="$3"; PIDFILE="$4"; STOPFLAG="$5"; PARENT="$6"; FWD="$7"
if [ "$FWD" = "1" ]; then sysctl -w net.inet.ip.forwarding=1 >/dev/null 2>&1; sysctl -w net.inet6.ip6.forwarding=1 >/dev/null 2>&1; fi
"$SB" run -c "$CFG" > "$LOG" 2>&1 &
SBPID=$!
echo "$SBPID" > "$PIDFILE"
while kill -0 "$SBPID" 2>/dev/null; do
  [ -f "$STOPFLAG" ] && break
  kill -0 "$PARENT" 2>/dev/null || break
  sleep 0.5
done
kill -TERM "$SBPID" 2>/dev/null
for i in $(seq 1 10); do kill -0 "$SBPID" 2>/dev/null || break; sleep 0.5; done
kill -9 "$SBPID" 2>/dev/null
rm -f "$STOPFLAG"
`;
    require('fs').writeFileSync(this.getWrapperScriptPath(), script, { mode: 0o755 });
  }

  /** Windows 提权看护脚本路径（UAC 提权的 PowerShell 以 -File 执行它来托管 sing-box）。 */
  private getWindowsWatchdogScriptPath(): string {
    return path.join(getUserDataPath(), 'flowz-win-watchdog.ps1');
  }

  /**
   * 写出 Windows 提权看护脚本（镜像 macOS writeWrapperScript）。UAC 一次授权后以管理员执行：
   * (a) 按本应用核心路径清扫提权遗留 sing-box（复用本次提权——非提权 taskkill 对提权孤儿恒
   *     Access denied，wmic 在 Win11 24H2 已移除故用 Get-CimInstance）；
   * (b) 起 sing-box 并写 PID 文件（与 waitForPidFile 协议完全一致：ASCII、无换行）；
   * (c) ~1s 轮询 stopflag（普通用户可写）与父进程存活（校验进程名防 PID 复用）→ 任一触发
   *     Stop-Process -Force 收割并清理 stopflag。
   * 收益：正常停止/退出零 UAC；GUI 崩溃/强杀 ~1s 内收割提权 sing-box，不留孤儿。
   * 注意：脚本须保持纯 ASCII；模板字符串内禁用 PS 花括号变量写法（会被 JS 当插值），统一用 $var。
   */
  private writeWindowsWatchdogScript(): void {
    // delegate → PlatformPrivilegeService（T16 子 commit 1）；未注入时保留原实现兜底。
    if (this.privilegeService) {
      this.privilegeService.writeWindowsWatchdogScript();
      return;
    }
    const script = `# FlowZ elevated watchdog (run by UAC-elevated PowerShell via -File). Do not edit manually.
param(
  [Parameter(Mandatory = $true)][string]$SbPath,
  [Parameter(Mandatory = $true)][string]$CfgPath,
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$StopFlag,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$ParentName,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [string]$Forward = '0'
)
$ErrorActionPreference = 'Continue'
function Log([string]$Msg) {
  try { ((Get-Date -Format 'HH:mm:ss') + ' [watchdog] ' + $Msg) | Out-File -FilePath $LogFile -Append -Encoding UTF8 } catch {}
}
try { 'FlowZ watchdog starting...' | Out-File -FilePath $LogFile -Encoding UTF8 } catch {}
if (-not (Test-Path -LiteralPath $SbPath)) { Log 'ERROR: sing-box not found'; exit 1 }
if (-not (Test-Path -LiteralPath $CfgPath)) { Log 'ERROR: config not found'; exit 1 }

# (a) sweep leftover sing-box started from OUR core path (reuses this elevation).
try {
  $orphans = @(Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | Where-Object { $_.ExecutablePath -eq $SbPath })
  foreach ($o in $orphans) {
    Log ('Killing leftover sing-box PID ' + $o.ProcessId)
    Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($orphans.Count -gt 0) { Start-Sleep -Milliseconds 500 }
} catch { Log ('Orphan sweep failed: ' + $_.Exception.Message) }

if ($Forward -eq '1') {
  try {
    Set-NetIPInterface -Forwarding Enabled
    Set-NetIPInterface -AddressFamily IPv6 -Forwarding Enabled
    Log 'IP forwarding enabled'
  } catch { Log ('Enable IP forwarding failed: ' + $_.Exception.Message) }
}

# (b) start sing-box (already elevated, no inner RunAs); PID file protocol unchanged.
# Config path is explicitly quoted: -ArgumentList does NOT auto-quote elements with spaces.
try {
  $proc = Start-Process -FilePath $SbPath -ArgumentList 'run', '-c', ('"' + $CfgPath + '"') -PassThru -WindowStyle Hidden
} catch {
  Log ('ERROR: failed to start sing-box: ' + $_.Exception.Message)
  exit 1
}
if (-not ($proc -and $proc.Id)) { Log 'ERROR: Start-Process returned null'; exit 1 }
$sbId = $proc.Id
try {
  $sbId | Out-File -FilePath $PidFile -Encoding ASCII -NoNewline
} catch {
  Log ('ERROR: failed to write PID file: ' + $_.Exception.Message)
  Stop-Process -Id $sbId -Force -ErrorAction SilentlyContinue
  exit 1
}
Log ('sing-box started, PID ' + $sbId)

# (c) babysit: exit when core dies; kill core on stopflag or parent death (name check vs PID reuse).
while ($true) {
  $sb = Get-Process -Id $sbId -ErrorAction SilentlyContinue
  if (-not $sb -or $sb.ProcessName -ne 'sing-box') { Log 'sing-box exited by itself'; break }
  if (Test-Path -LiteralPath $StopFlag) { Log 'Stopflag detected'; break }
  $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if (-not $parent -or $parent.ProcessName -ne $ParentName) { Log 'Parent process gone'; break }
  Start-Sleep -Seconds 1
}
$sb = Get-Process -Id $sbId -ErrorAction SilentlyContinue
if ($sb -and $sb.ProcessName -eq 'sing-box') {
  Stop-Process -Id $sbId -Force -ErrorAction SilentlyContinue
  Log 'sing-box stopped by watchdog'
}
Remove-Item -LiteralPath $StopFlag -Force -ErrorAction SilentlyContinue
Log 'Watchdog exit'
exit 0
`;
    require('fs').writeFileSync(this.getWindowsWatchdogScriptPath(), script);
  }

  /** 停止收尾：删 PID 文件 + 资源清理 + 通知前端。 */
  private finishStop(): void {
    try {
      require('fs').unlinkSync(this.getPidFilePath());
    } catch {
      /* 忽略 */
    }
    this.cleanup();
    this.emit('stopped');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
  }

  /**
   * macOS 提权 helper 路径：经 socket 让 root daemon 启动 sing-box（免授权）。
   * 成功 resolve；失败 throw（交给 start() 的 retry 决策）。停止/退出/崩溃回收均免授权。
   */
  private async startViaHelper(startGen: number): Promise<void> {
    const helper = this.helperManager!;
    const fs = require('fs');
    if (!fs.existsSync(this.singboxPath)) {
      throw new Error(`找不到 sing-box 可执行文件: ${this.singboxPath}`);
    }
    const pidFile = getSingBoxPidPath();
    const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
    const forward = !!this.currentConfig?.allowLan;
    this.logToManager(
      'info',
      `TUN 模式经提权 helper 启动 sing-box（免授权）${forward ? '，并开启 IP 转发' : ''}...`
    );

    const res = await helper.startCore(this.configPath, startupLogFile, forward);
    if (!res.ok || !res.pid) {
      throw new Error(res.error || 'helper 启动 sing-box 失败');
    }

    this.singboxPid = res.pid;
    this.pid = res.pid;
    this.startTime = new Date();
    this.startedViaHelper = true;
    // 写 PID 文件，保持与 osascript 路径一致（健康检查/孤儿清理读它）
    try {
      fs.writeFileSync(pidFile, String(res.pid));
    } catch {
      /* 忽略 */
    }

    if (!this.isProcessAlive(res.pid)) {
      this.cleanup();
      throw new Error('helper 报告已启动但进程不存在');
    }

    // issue #159：等核真就绪（管理 API 绑定）再判成功，而非「spawn 即 started」。起核期内核死/超时 → 抛可重试
    // 错误交 runStartWithRetry 快速重起（届时 wintun 适配器/端口已释放），替代「假成功 + 10s 健康检查兜底」。
    // watcher/健康检查移到就绪后启动：只监控已确认运行的核，起核期死由本就绪门控直接捕获。
    await this.waitForCoreReadyOrThrow(res.pid, startGen);

    this.startLogFileWatcher();
    this.startHealthCheck();
    this.emit('started');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
      pid: res.pid,
      startTime: this.startTime,
    });
    this.logToManager('info', 'sing-box 已由提权 helper 启动成功（免授权）');
  }

  /**
   * issue #159：等核真就绪（管理 API 端口可连）再放行。起核期进程死 / 超时未绑 API → 停掉半死核（其 wintun
   * 适配器随即开始释放，给 retry 让路）+ 抛可重试错误（文案不含 nonRetryable 关键词 → runStartWithRetry 会重试）。
   * 无管理 API 端口（异常）→ fail-open 放行（退回旧 spawn 即成行为，绝不卡死启动）。仅 startViaHelper 调用。
   * issue #176：就绪等待期被更新的 start/stop 接管（startGen≠lifecycleGeneration）→ 抛 CoreStartSupersededError
   *   静默让位，**不调 stopCore()**（接管方已/正在拆核，本腿再 stopCore 会与之抢放 wintun 适配器、加剧风暴）。
   */
  private async waitForCoreReadyOrThrow(pid: number, startGen: number): Promise<void> {
    const port = this.tailscaleApiPort;
    if (!port) return; // 无管理 API 端口 → 不阻断
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const outcome = await waitForCoreReady(
      { timeoutMs: ProxyManager.CORE_READY_TIMEOUT_MS, pollMs: ProxyManager.CORE_READY_POLL_MS },
      {
        isAlive: () => this.isProcessAlive(pid),
        isReady: () => this.coreReadyProbe('127.0.0.1', port),
        sleep,
        isSuperseded: () => this.lifecycleGeneration !== startGen,
      }
    ).catch(() => 'timeout' as const);
    if (outcome === 'ready') return;
    // issue #176：被接管 → 静默让位，绝不 stopCore（接管方拥有拆核权，避免抢放适配器）。由 start() 包装吞掉。
    if (outcome === 'superseded') {
      throw new CoreStartSupersededError();
    }
    // 失败：尽力停掉这个起不来的核（best-effort，其 wintun 适配器随即开始释放，给 retry 让路），再抛 CoreStartRetryError
    // ——startSingBoxProcess 的 helper catch 会透传它给 runStartWithRetry 静默重起（而非误判 helper 启动失败弹 UAC/osascript）。
    await this.helperManager?.stopCore().catch(() => {});
    if (outcome === 'dead') {
      throw new CoreStartRetryError('sing-box 启动期退出（TUN 初始化未完成），正在自动重试');
    }
    // issue #176：软化文案——「未绑定」多因 Windows 重启争用下 wintun 适配器未及时释放致起核慢，非真失败。
    throw new CoreStartRetryError('sing-box 起核较慢（管理接口尚未就绪），正在自动重试');
  }

  private async startSingBoxProcess(startGen: number): Promise<void> {
    // 复位 helper 启动标志：本次启动尚未确定走 helper 还是直起，由实际启动路径置位（startViaHelper 成功置 true，
    //   直起 UAC/osascript 路径保持 false）。修复 issue #159 就绪门控失败、重试腿回退直起时 startedViaHelper 残留 true
    //   → 后续 stop() 误走 helper 停核分支（停不动→回退提权 taskkill/osascript，降级但自愈）。每次启动腿都从干净态判定。
    this.startedViaHelper = false;

    // issue #159：起核前（win32&&TUN）等上一轮自家 wintun 适配器释放。置于本方法顶部（而非 startInternal）→ 每次
    //   runStartWithRetry 重启腿、以及下方 helper / UAC 两条启动支路都经此门控（不止首次），杜绝重试立刻再撞僵尸适配器。
    const launchCfg = this.currentConfig;
    if (launchCfg && process.platform === 'win32' && launchCfg.proxyModeType === 'tun') {
      await this.waitForOwnTunAdapterReleased(launchCfg);
    }

    // macOS TUN 模式 + helper 就绪 → 走零提权路径（避免每次启停弹 osascript 授权框）。
    // helper 就绪但启动失败（如 .app 被移动致锁定的 singbox 路径失效）→ 回退 osascript 看护脚本，
    // 不在 helper 路径死循环（startViaHelper 抛出前不会残留状态：未到设标志处，或经 cleanup 复位）。
    if (this.needsOsascript() && this.helperManager) {
      // 先判后台开关：backgroundDisabled 时即便 install-over-top 让 daemon 此刻活着(isReady=true)，BTM 也会在 ~20s 后
      // 收割这个 disallowed daemon → sing-box 被收割、自动重启 F10 失败（真机实测）。故**跳过 helper 路径**（不论
      // ready），走 osascript root 看护脚本（不受 BTM 管、会话稳定）。getStatus 经 SMAppService 判 backgroundDisabled，~30ms。
      const st = await this.helperManager.getStatus().catch(() => null);
      if (st?.backgroundDisabled) {
        this.logToManager(
          'warn',
          'helper「允许在后台」被系统关闭：本次走 osascript 看护脚本（不依赖 BTM，避免 daemon 被系统收割）。请在「系统设置 > 通用 > 登录项与扩展」重新打开开关以恢复免授权启停'
        );
      } else if (await this.helperManager.isReady()) {
        try {
          return await this.startViaHelper(startGen);
        } catch (e) {
          // 起核期未就绪/退出（CoreStartRetryError）≠ helper 启动失败：透传给 runStartWithRetry 静默重起，不回退 osascript。
          if (e instanceof CoreStartRetryError || e instanceof CoreStartSupersededError) throw e;
          this.logToManager(
            'warn',
            `helper 启动失败，回退 osascript 看护脚本: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      } else if (st?.installed) {
        this.logToManager('warn', 'helper 已安装但未就绪，本次回退 osascript 授权路径');
      }
    }

    // Windows TUN 模式 + helper 服务就绪 → 走零提权路径（镜像上方 macOS 逻辑，避免每次 UAC）。就绪即经服务起核；
    // 启动失败 → 回退 buildWindowsUacLaunchCommand（每次 UAC）兜底，不在 helper 路径死循环。Windows 无「允许在
    // 后台」概念（backgroundDisabled 恒 false），无需该前置判定；未装 helper → isReady=false → 落下方 UAC 路径。
    if (this.needsWindowsUAC() && this.helperManager && (await this.helperManager.isReady())) {
      try {
        return await this.startViaHelper(startGen);
      } catch (e) {
        // 起核期未就绪/退出（CoreStartRetryError）≠ helper 启动失败：透传给 runStartWithRetry 静默重起，不回退 UAC。
        // issue #176：就绪等待期被接管（CoreStartSupersededError）同样透传让位——绝不回退 UAC 起第二条流抢适配器
        //   （这是 #176 风暴的 Windows 主路径；与上方 macOS 分支 :3559 对齐）。
        if (e instanceof CoreStartRetryError || e instanceof CoreStartSupersededError) throw e;
        this.logToManager(
          'warn',
          `helper 服务启动失败，回退 UAC 路径: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // F10：非交互启动（崩溃自动重启）且 macOS TUN 需 osascript（helper 不可用/未就绪/路径失效）→ 不弹密码框。
    // 崩溃循环里凭空弹管理员授权（最多连弹 MAX_RESTART_COUNT 次）比断流更糟；抛含「权限」的非重试错误进入
    // 停止终态，待用户手动经 start gate 重新安装/修复 helper。交互式启动（按钮/托盘/切模式）不受影响。
    if (this.needsOsascript() && !this.startInteractive) {
      throw new Error(
        '提权助手不可用，已跳过非交互（崩溃自动重启）的管理员权限授权——请手动重启代理以经引导安装/修复 helper'
      );
    }

    // Linux TUN：在 spawn 前确保核心具备 capabilities + 安装 polkit 规则（首次弹 1 次密码，之后启停零
    // 弹窗）。非 Linux / 非 TUN 为 no-op。授权取消 → 抛含「权限」的非重试性错误（见 nonRetryableErrors）。
    await this.ensureLinuxTunCapabilities();

    return new Promise((resolve, reject) => {
      // 启动是否已判定成功（resolve）：分离「启动期退出=启动失败，只 reject 交外层 retry」与「成功后退出=
      // 运行中崩溃 → handleProcessExit 自动重启」，杜绝启动期 reject 与 attemptAutoRestart 双启动流并发竞跑。
      let startupResolved = false;
      try {
        // 检查 sing-box 可执行文件是否存在
        const fs = require('fs');
        if (!fs.existsSync(this.singboxPath)) {
          const error = new Error(`找不到 sing-box 可执行文件: ${this.singboxPath}`);
          this.logToManager('error', error.message);
          reject(error);
          return;
        }

        // 根据平台和模式选择启动方式：
        // - macOS TUN 模式: 使用 osascript 请求管理员权限
        // - Windows TUN 模式: 使用 PowerShell Start-Process -Verb RunAs 请求 UAC 权限
        // - 其他情况: 直接运行
        let command: string;
        let args: string[];

        if (this.needsOsascript()) {
          // macOS: osascript 一次授权 → 以 root 跑「看护脚本」托管 sing-box（停止/退出/崩溃回收无需再提权）。
          // 路径单引号包裹以容忍空格（与原实现一样不处理路径内引号——FlowZ 路径不含单/双引号）。
          const pidFile = getSingBoxPidPath();
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          const stopFlag = this.getStopFlagPath();
          const fwd = this.currentConfig?.allowLan ? '1' : '0';
          const parentPid = process.pid; // Electron 主进程 PID：退出即让看护脚本联动停 sing-box，杜绝孤儿

          // 清掉上轮残留 stopflag
          try {
            require('fs').unlinkSync(stopFlag);
          } catch {
            /* 不存在则忽略 */
          }

          // T16 子 commit 4：看护脚本写出 + 提权命令构造委托 service（generateWatchdogScript +
          // buildElevatedLaunchCommand）。spawn + stdout 监听 + exit 处理（startupResolved 门控、
          // 双启动流防护）+ waitForPidFile 留此处。未注入 service 时走原 inline 兜底。
          if (this.privilegeService) {
            const wd = this.privilegeService.generateWatchdogScript();
            const built = this.privilegeService.buildElevatedLaunchCommand({
              singboxPath: this.singboxPath,
              configPath: this.configPath,
              pidFile,
              startupLogFile,
              stopFlag,
              wrapper: wd.path,
              watchdog: wd.path,
              parentPid,
              parentName: '',
              fwd,
            });
            command = built.command;
            args = built.args;
          } else {
            const wrapper = this.getWrapperScriptPath();
            this.writeWrapperScript();
            command = '/usr/bin/osascript';
            args = [
              '-e',
              `do shell script "/bin/bash '${wrapper}' '${this.singboxPath}' '${this.configPath}' '${startupLogFile}' '${pidFile}' '${stopFlag}' ${parentPid} '${fwd}' >/dev/null 2>&1 &" with administrator privileges`,
            ];
          }
          this.logToManager(
            'info',
            `TUN 模式需要管理员权限${this.currentConfig?.allowLan ? '及开启 IP 转发' : ''}，正在请求（仅此一次，后续启停免授权）...`
          );
        } else if (this.needsWindowsUAC()) {
          // Windows TUN 模式：UAC 一次授权 → 以管理员跑「看护脚本」托管 sing-box（镜像 macOS
          // osascript 看护路径）。正常停止经 stopflag 零 UAC；GUI 崩溃/强杀由看护脚本按父 PID
          // 联动收割，杜绝提权孤儿。UAC 次数与旧实现一致（每次 TUN 启动仍 1 次）。
          const pidFile = getSingBoxPidPath();
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          const stopFlag = this.getStopFlagPath();
          const parentPid = process.pid; // Electron 主进程 PID：父死即看护脚本收割 sing-box
          // 父进程名（无扩展名，对应 PS Get-Process 的 ProcessName）：配合 PID 校验防 PID 复用误判
          const parentName = path.basename(process.execPath, path.extname(process.execPath));
          const fwd = this.currentConfig?.allowLan ? '1' : '0';

          // 清掉上轮残留 stopflag
          try {
            require('fs').unlinkSync(stopFlag);
          } catch {
            /* 不存在则忽略 */
          }

          // T16 子 commit 4：看护脚本写出 + 提权命令构造委托 service（同 macOS 分支）。未注入时走原 inline 兜底。
          if (this.privilegeService) {
            const wd = this.privilegeService.generateWatchdogScript();
            const built = this.privilegeService.buildElevatedLaunchCommand({
              singboxPath: this.singboxPath,
              configPath: this.configPath,
              pidFile,
              startupLogFile,
              stopFlag,
              wrapper: wd.path,
              watchdog: wd.path,
              parentPid,
              parentName,
              fwd,
            });
            command = built.command;
            args = built.args;
          } else {
            this.writeWindowsWatchdogScript();
            const watchdog = this.getWindowsWatchdogScriptPath();
            // 外层 powershell（非提权）只负责发起 UAC：Start-Process -Verb RunAs 拉起提权 powershell
            // 执行看护脚本。参数经 -File 传递（不走 -Command 内联，避免多层转义）；-ArgumentList 不会
            // 给含空格元素自动加引号 → 路径元素显式内嵌双引号（FlowZ 路径不含单/双引号）。
            // 授权成功外层立即退 0（不 -Wait，看护脚本常驻）；取消 UAC 时 Start-Process 抛错 → 退 1，
            // 与旧实现的退出码协议一致（见下方 singboxProcess 'exit' 处理）。PID 文件由提权侧写出，
            // waitForPidFile 协议不变。
            const q = (s: string) => `'"${s.replace(/'/g, "''")}"'`;
            const watchdogArgs = [
              "'-NoProfile'",
              // -NonInteractive：看护脚本含 Mandatory 参数，若引号链失效缺参，避免在隐藏窗口交互式提示→永久挂起
              "'-NonInteractive'",
              "'-ExecutionPolicy'",
              "'Bypass'",
              "'-WindowStyle'",
              "'Hidden'",
              "'-File'",
              q(watchdog),
              q(this.singboxPath),
              q(this.configPath),
              q(pidFile),
              q(stopFlag),
              `'${parentPid}'`,
              q(parentName),
              q(startupLogFile),
              `'${fwd}'`,
            ].join(',');
            const logFileEsc = startupLogFile.replace(/'/g, "''");
            const psScript = [
              "$ErrorActionPreference = 'Stop'",
              'try {',
              `  Start-Process -FilePath '${powershellPath()}' -Verb RunAs -WindowStyle Hidden ` +
                '-ArgumentList ' +
                watchdogArgs,
              '  exit 0',
              '} catch {',
              "  'ERROR launching watchdog: ' + $_.Exception.Message | Out-File -FilePath '" +
                logFileEsc +
                "' -Encoding UTF8",
              '  exit 1',
              '}',
            ].join('; ');

            command = powershellPath();
            args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];
          }
          this.logToManager(
            'info',
            `TUN 模式需要管理员权限${
              this.currentConfig?.allowLan ? '及开启 IP 转发' : ''
            }，正在请求 UAC 授权（仅启动这一次，停止/退出免授权）...`
          );
        } else {
          // 系统代理模式或 Linux：直接运行
          command = this.singboxPath;
          args = ['run', '-c', this.configPath];
        }

        // 启动进程（spawn 环境继承主进程；旧 1.12.x 的 ENABLE_DEPRECATED_DESTINATION_OVERRIDE_FIELDS env 已随
        // 硬切 1.14 + §5 守卫剥离——live 核恒 ≥1.14、配置亦不再含 sniff_override_destination，U盾域名走路由规则）。
        const spawnEnv = { ...process.env };

        this.singboxProcess = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spawnEnv,
          // Windows：隐藏子进程控制台窗口。GUI 进程（Electron 无控制台）spawn 控制台程序会新建并显示黑窗——
          // TUN 模式下外层 powershell.exe（触发 UAC 的非提权壳）每次都会闪一个黑色 PS 控制台（与内层看护脚本的
          // -WindowStyle Hidden 无关，那是 Start-Process 的子窗口）。systemProxy 直起 sing-box 同样隐藏其控制台
          // （stdio 已 pipe，无功能影响）。macOS/Linux 忽略此项。
          windowsHide: true,
        });

        // 记录启动信息
        this.pid = this.singboxProcess.pid || null;
        this.startTime = new Date();

        // macOS/Windows TUN 模式下，这个 PID 是 osascript/PowerShell 的 PID，不是 sing-box 的
        // 实际的 sing-box PID 会在 waitForPidFile 中从 PID 文件读取
        if (this.needsOsascript() || this.needsWindowsUAC()) {
          this.logToManager('info', `正在启动 sing-box（权限提升进程 PID: ${this.pid}）...`);
        } else {
          this.logToManager('info', `正在启动 sing-box 进程 (PID: ${this.pid})...`);
        }

        // 监听进程输出
        if (this.singboxProcess.stdout) {
          this.singboxProcess.stdout.on('data', (data: Buffer) => {
            this.handleProcessOutput(data.toString());
          });
        }

        if (this.singboxProcess.stderr) {
          this.singboxProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            this.lastErrorOutput = output;
            this.handleProcessOutput(output);
          });
        }

        // 监听进程事件
        this.singboxProcess.on('error', (error) => {
          this.logToManager('error', `sing-box process error: ${error.message}`);
          // 同 exit 分支：置位阻止 1s setTimeout 误判成功发幻影 started（H1/L-2）。
          startupResolved = true;
          const friendlyError = this.parseLaunchError(error);
          this.logToManager('error', friendlyError);
          this.handleProcessError(error);
          reject(new Error(friendlyError));
        });

        this.singboxProcess.on('exit', (code, signal) => {
          this.logToManager('info', `sing-box process exited with code ${code}, signal ${signal}`);

          // 对于 macOS TUN 模式，osascript 退出码为 0 表示成功启动了后台进程
          if (this.needsOsascript()) {
            if (code === 0) {
              // osascript 成功执行，sing-box 在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // osascript 执行失败（用户取消或其他错误）：包装进程退出 ≠ 运行中崩溃 → 只 reject 交外层 retry，
              // **不**调 handleProcessExit（否则触发 attemptAutoRestart，与外层 retry 双启动流并发，且用户取消密码框
              // 还会多收 AUTO_RESTARTING + 自动重启失败 串扰，H2）。置 startupResolved 让 setTimeout 干净跳过。
              startupResolved = true;
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `启动失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              return;
            }
          }

          // 对于 Windows TUN 模式，PowerShell 退出码为 0 表示成功启动了 sing-box
          if (this.needsWindowsUAC()) {
            if (code === 0) {
              // PowerShell 成功执行，sing-box 以管理员权限在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // PowerShell/UAC 执行失败（用户取消或其他错误）：包装进程退出 ≠ 运行中崩溃 → 只 reject 交外层 retry，
              // 不调 handleProcessExit（同 osascript 分支，避免双启动流 + 取消授权后的自动重启串扰，H2）。
              startupResolved = true;
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `UAC 授权失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              return;
            }
          }

          // 启动未判定成功(resolve)前退出 = 启动失败：只 reject 交外层 retry，**不**走 handleProcessExit
          // 的自动重启，杜绝「外层 retry + attemptAutoRestart」双启动流并发竞跑（端口占用风暴的确定性放大源）。
          if (!startupResolved) {
            // 置位（本 attempt 已判定=失败）：阻止 1s setTimeout 见残留 singboxProcess&&pid 误判成功 →
            // 发幻影 'started'（污染核心更新基线 + UI 撒谎）+ 泄漏健康检查（10s 后见死 PID 触发 attemptAutoRestart，
            // 与外层 retry 并发——T1 要杀的双启动流换入口复活，H1）。
            startupResolved = true;
            const errorMessage =
              code !== null && code !== 0
                ? this.parseStartupError(code, this.lastErrorOutput)
                : `sing-box 启动期退出 (code=${code}, signal=${signal})`;
            this.logToManager('error', errorMessage);
            reject(new Error(errorMessage));
            return;
          }

          // 已成功启动后退出 = 运行中崩溃 → 走崩溃恢复（自动重启 / 终态）
          this.handleProcessExit(code, signal);
        });

        // 等待一小段时间确保进程启动成功
        setTimeout(async () => {
          // 本 attempt 已判定（启动期退出已 reject 并置 startupResolved）→ 不再发 'started'（修 H1 幻影启动）。
          // startupResolved 是本次 startSingBoxProcess 的局部量，故跨 retry 各 attempt 互不污染。
          if (startupResolved) return;
          // macOS TUN 模式或 Windows TUN 模式：检查 singboxPid（从 PID 文件读取）
          // 其他模式：检查 singboxProcess 和 pid
          const isMacTunMode = this.needsOsascript();
          const isWindowsTunMode = this.needsWindowsUAC();

          if (isMacTunMode || isWindowsTunMode) {
            // TUN 模式：等待 PID 文件被写入
            await this.waitForPidFile();

            if (this.singboxPid) {
              // 启动日志文件监控（macOS 和 Windows TUN 模式都需要，因为后台进程的 stdout 无法被捕获）
              this.startLogFileWatcher();
              // 启动健康检查定时器
              this.startHealthCheck();

              // 触发启动事件
              this.emit('started');
              this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
                pid: this.singboxPid,
                startTime: this.startTime,
              });
              this.logToManager('info', 'sing-box 进程启动成功');
              startupResolved = true;
              resolve();
            } else {
              const error = '启动 sing-box 进程失败：无法获取进程 PID';
              this.logToManager('error', error);
              // 启动失败，清理状态，避免健康检查使用错误的 PID
              this.cleanup();
              reject(new Error(error));
            }
          } else {
            // 系统代理模式或 Linux
            if (this.singboxProcess && this.pid) {
              // 启动健康检查定时器
              this.startHealthCheck();

              // 触发启动事件
              this.emit('started');
              this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
                pid: this.pid,
                startTime: this.startTime,
              });
              this.logToManager('info', 'sing-box 进程启动成功');
              startupResolved = true;
              resolve();
            } else {
              const error = '启动 sing-box 进程失败：进程未能正常启动';
              this.logToManager('error', error);
              // 启动失败，清理状态
              this.cleanup();
              reject(new Error(error));
            }
          }
        }, 1000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logToManager('error', `启动 sing-box 进程时发生异常: ${errorMessage}`);
        // 异常时也要清理状态
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * 启动前归一运行时目录属主(根治跨提权态属主冲突,详见 runtime-ownership)。
   * 仅在「本次将以登录用户(非提权)运行 sing-box」时执行——提权(root/SYSTEM)路径能读现有 root state,不动以免
   * 每次 TUN 启动都删 state 致 Tailscale 重登。删掉上次 root 跑残留的 root 600 state → tsnet 以登录用户重建。
   * POSIX only(Windows 属主模型不同,由 helper 侧 takeown 覆盖,后续治本层)。绝不抛、不阻断启动。
   */
  private reconcileRuntimeOwnershipBeforeStart(): void {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
    // 本次走提权(osascript/UAC)→ root/elevated 跑,能读现有 root state → 不归一(避免每次 TUN 删 state→Tailscale 重登)。
    if (this.needsOsascript() || this.needsWindowsUAC()) return;
    try {
      const uid = process.getuid();
      const gid = typeof process.getgid === 'function' ? process.getgid() : uid;
      const tsRoot = path.join(getUserDataPath(), 'tailscale');
      const r = reconcileTreeOwnership(tsRoot, uid, gid);
      if (r.deleted.length > 0 || r.chowned.length > 0) {
        this.logToManager(
          'info',
          `已归一 tailscale state 属主（删 ${r.deleted.length} / chown ${r.chowned.length}）杜绝跨提权态权限冲突` +
            (r.deleted.length > 0 ? '；若该 Tailscale 节点登录态被清，需重新登录' : '')
        );
      }
      // 删了某节点 state（<userData>/tailscale/<serverId>/...）→ 该节点登录态已失效。通知渲染端清登录缓存，
      // 否则陈旧 loggedIn=true 与已清空的磁盘 state 撕裂（#173 review MED-4）。state_directory 键即 serverId
      // （tailscaleStateDir = <userData>/tailscale/<serverId>），取 tsRoot 下首段路径段还原 serverId。渲染端消费另接。
      const clearedServerIds = new Set<string>();
      for (const deletedPath of r.deleted) {
        const rel = path.relative(tsRoot, deletedPath);
        // 越界（rel 以 .. 开头或绝对路径）= 不在 tsRoot 下，跳过（防御，正常不发生）。
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const serverId = rel.split(path.sep)[0];
        if (serverId) clearedServerIds.add(serverId);
      }
      for (const serverId of clearedServerIds) {
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_TAILSCALE_STATE_CLEARED, { serverId });
      }
    } catch {
      /* 尽力而为，绝不阻断启动 */
    }
  }

  /**
   * 解析进程启动错误
   */
  private parseLaunchError(error: Error): string {
    const errorCode = (error as NodeJS.ErrnoException).code;

    switch (errorCode) {
      case 'ENOENT':
        return '找不到 sing-box 可执行文件，请检查安装是否完整';
      case 'EACCES':
        return 'sing-box 可执行文件没有执行权限，请检查文件权限';
      case 'EPERM':
        return '权限不足，无法启动 sing-box 进程。TUN 模式需要管理员权限';
      default:
        return `启动 sing-box 进程失败: ${error.message}`;
    }
  }

  /**
   * 解析启动阶段的错误
   */
  private parseStartupError(exitCode: number, errorOutput: string): string {
    // 首先尝试从错误输出中提取有用信息
    if (errorOutput) {
      const lowerOutput = errorOutput.toLowerCase();

      if (lowerOutput.includes('permission denied') || lowerOutput.includes('access denied')) {
        // 细分：tailscale tsnet / state 文件的权限错误是「跨提权态 state 属主冲突」(root 跑留下 root 600
        // state、登录用户跑读不了)，已由启动前 reconcileRuntimeOwnershipBeforeStart 兜底；它**不是** TUN 设备
        // 提权问题，误报「以管理员运行」会把排查带偏(真机踩坑根因)。给准确提示 + 引导重试。
        if (/logpolicy|tailscaled|tailscale|state_directory/i.test(errorOutput)) {
          return `Tailscale 状态文件权限异常（跨提权态属主冲突），已尝试自动归一，请重试启动 [${errorOutput}]`;
        }
        return `TUN 模式需要管理员权限，请以管理员身份运行应用 [${errorOutput}]`;
      }

      if (lowerOutput.includes('address already in use') || lowerOutput.includes('bind')) {
        return `端口已被占用，请在设置中更换其他端口或关闭占用端口的程序 [${errorOutput}]`;
      }

      if (
        lowerOutput.includes('invalid config') ||
        lowerOutput.includes('parse') ||
        lowerOutput.includes('json')
      ) {
        return `sing-box 配置文件格式错误，请检查服务器配置 [${errorOutput}]`;
      }

      if (lowerOutput.includes('connection refused') || lowerOutput.includes('dial')) {
        return `无法连接到代理服务器，请检查服务器地址和端口 [${errorOutput}]`;
      }

      if (lowerOutput.includes('certificate') || lowerOutput.includes('x509')) {
        return `TLS 证书验证失败，请检查服务器 TLS 配置 [${errorOutput}]`;
      }

      // 如果有具体的错误信息，翻译后返回
      const friendlyMessage = this.translateErrorMessage(errorOutput);
      if (friendlyMessage !== errorOutput) {
        return `sing-box 启动失败: ${friendlyMessage}`;
      }
    }

    // 根据退出码返回通用错误信息
    switch (exitCode) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件和服务器设置';
      case 2:
        return 'sing-box 配置文件格式错误，请检查服务器配置';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      default:
        return `sing-box 启动失败，退出码: ${exitCode}`;
    }
  }

  /**
   * 停止 sing-box 进程
   */
  private async stopSingBoxProcess(opts?: { quitting?: boolean }): Promise<void> {
    // 杀核前先静默 StatsService：停其到管理 API 的 Status/Connections gRPC 流（核将死，提前 cancel 避免 RST 噪音）。
    // 同步、不阻塞。tailscaleApiClient 自身的 Tailscale 状态流由上层 stop() 另行 stop（gRPC 客户端各自管理生命周期）。
    try {
      this.quiesceStats?.();
    } catch {
      /* 忽略 */
    }

    // macOS TUN 模式：sing-box 以 root 权限在后台运行，需要用 osascript 终止。
    // T16 子 commit 3：实现迁入 PlatformPrivilegeService.stopElevated（darwin 分支），此处 delegate。
    // 进程状态收尾（finishStop）据返回 stopped 统一做：true→finishStop，false→不收尾（取消授权不谎报已停止，M3）。
    // STOP_AUTH_CANCELLED 事件副作用由 service 内部 ctx.onStopAuthCancelled 触发（service 不持 IPC 通道）。
    if (this.singboxPid && process.platform === 'darwin') {
      if (this.privilegeService) {
        const { stopped } = await this.privilegeService.stopElevated(this.singboxPid, opts);
        if (stopped) this.finishStop();
        return;
      }
      return this.stopSingBoxWithSudo(opts);
    }

    // Windows TUN 模式：sing-box 以 SYSTEM/管理员权限在后台运行。
    if (this.singboxPid && process.platform === 'win32') {
      // 经 helper 服务启动的 → 经 helper.stopCore() 停（零 UAC、快）。helper 是 SYSTEM、能停自己的 SYSTEM child；
      // 否则非提权 taskkill 杀不动 SYSTEM sing-box → 下方 stopElevated 落 RunAs taskkill 弹 UAC 且慢（先试非提权再升级）。
      // 镜像 macOS stopSingBoxWithSudo 的 helper 分支。注意：PlatformPrivilegeService 注入的是 macHelper（Win 上
      // supported=false），故 Windows 的 winHelper 停止必须在 ProxyManager（持 winHelper）处理，**不能**委托 stopElevated。
      if (this.startedViaHelper && this.helperManager) {
        const pidToKill = this.singboxPid;
        this.logToManager('info', `正在经提权服务停止 sing-box (PID: ${pidToKill})（免 UAC）...`);
        if (this.isProcessAlive(pidToKill)) {
          await this.helperManager.stopCore();
          // 覆盖 helper terminateChild 的「CTRL_BREAK→等≤2s→TerminateProcess」+ 收割余量。
          await this.waitForProcessExit(pidToKill, opts?.quitting ? 3000 : 8000);
        }
        if (!this.isProcessAlive(pidToKill)) {
          this.logToManager('info', 'sing-box 已由提权服务停止（免 UAC）');
          this.finishStop();
          return;
        }
        // helper 停未生效（极少）→ 落下方提权兜底（退出语境 stopElevated 内部跳过 UAC）。
        this.logToManager('warn', 'helper 服务停止未生效，回退提权路径');
      }
      // T16 子 commit 3：实现迁入 PlatformPrivilegeService.stopElevated（win32 分支），此处 delegate（同上）。
      if (this.privilegeService) {
        const { stopped } = await this.privilegeService.stopElevated(this.singboxPid, opts);
        if (stopped) this.finishStop();
        return;
      }
      return this.stopSingBoxOnWindows(opts);
    }

    if (!this.singboxProcess) {
      return;
    }

    const proc = this.singboxProcess;
    // 防御：进程已退出（exitCode/signalCode 非 null，或 pid 已不存活）→ 'exit' 早已发过，再挂 once('exit') 永不触发
    // → stop() 永挂 → 下次/退出语境卡死（修「二次点击卡死」根因 A 的兜底）。直接收尾。
    if (
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      (proc.pid != null && !this.isProcessAlive(proc.pid))
    ) {
      this.logToManager('info', 'sing-box 进程已退出，直接收尾（不等 exit 事件）');
      this.cleanup();
      return;
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimeout);
        clearTimeout(hardCap);
        this.cleanup();
        resolve();
      };

      // 设置超时强制终止
      const killTimeout = setTimeout(() => {
        if (proc.killed === false) {
          this.logToManager('warn', 'sing-box process did not exit gracefully, force killing');
          proc.kill('SIGKILL');
        }
      }, 5000);

      // 硬上限：无论如何 8s 内必 settle（绝不允许 stop 永挂拖死 start/退出链）
      const hardCap = setTimeout(() => {
        this.logToManager('warn', 'stop 等待进程退出超时（8s），强制收尾');
        done();
      }, 8000);

      // 监听退出事件
      proc.once('exit', done);

      // 发送 SIGTERM 信号优雅终止
      proc.kill('SIGTERM');
    });
  }

  /**
   * 使用 sudo 停止 sing-box 进程（macOS TUN 模式）
   */
  private async stopSingBoxWithSudo(opts?: { quitting?: boolean }): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;

    // helper 路径：经 socket 让 root daemon 停 sing-box，零提权（PR-M2）。
    if (this.startedViaHelper && this.helperManager) {
      this.logToManager('info', `正在经提权 helper 停止 sing-box (PID: ${pidToKill})（免授权）...`);
      if (this.isProcessAlive(pidToKill)) {
        await this.helperManager.stopCore();
        // 8s（非退出）覆盖 helper terminateChild 的「TERM→等≤5s→KILL」完整窗口 + 收割余量：
        // 原 5s 会在 helper 即将 SIGKILL 时正好超时 → 误判「helper 停止未生效」→ 多弹一次 osascript 强杀。
        await this.waitForProcessExit(pidToKill, opts?.quitting ? 3000 : 8000);
      }
      if (this.isProcessAlive(pidToKill)) {
        if (opts?.quitting) {
          // 退出语境零弹框：helper 未生效也不弹 osascript，交由 teardownForQuit 的 helper.cleanup() 兜底回收
          this.logToManager('warn', 'helper 停止未生效，退出语境跳过提权弹框（cleanup 兜底）');
        } else {
          // 极少触发：helper 未生效 → 退回 osascript 强杀（一次授权）。取消授权(进程仍活) → 不谎报已停止。
          this.logToManager('warn', 'helper 停止未生效，退回提权强制终止');
          if (!(await this.forceKillOrReportCancelled(pidToKill))) return;
        }
      } else {
        this.logToManager('info', 'sing-box 已由提权 helper 停止（免授权）');
      }
      this.finishStop();
      return;
    }

    // M1-a：进程已不在 → 直接收尾，免一次提权授权框
    if (!this.isProcessAlive(pidToKill)) {
      this.logToManager('info', 'sing-box 进程已不在，跳过提权终止');
      this.finishStop();
      return;
    }

    // M1-b：写 stopflag，由 root 看护脚本自杀 sing-box —— 停止无需再次提权
    this.logToManager('info', `正在停止 sing-box (PID: ${pidToKill})，通知看护脚本...`);
    try {
      require('fs').writeFileSync(this.getStopFlagPath(), '');
    } catch (e) {
      this.logToManager('warn', `写 stopflag 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (await this.waitForProcessExit(pidToKill, opts?.quitting ? 3000 : 8000)) {
      this.logToManager('info', 'sing-box 已由看护脚本停止（无需提权）');
      this.finishStop();
      return;
    }

    // Fallback：看护脚本未在预期内收口（异常/旧式直起）→ 退回 osascript 提权终止
    if (opts?.quitting) {
      // 退出语境零弹框：跳过 osascript，残留 sing-box 由下次启动的 killOrphanedProcessesMac 清扫
      this.logToManager('warn', '看护脚本未及时停止，退出语境跳过提权弹框（下次启动清扫孤儿）');
      this.finishStop();
      return;
    }
    this.logToManager('warn', '看护脚本未及时停止 sing-box，退回提权终止');
    return new Promise((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -TERM ${pidToKill}" with administrator privileges`,
      ]);

      killProcess.on('exit', async (code) => {
        let ok = true;
        if (code === 0) {
          await this.waitForProcessExit(pidToKill, 3000);
          if (this.isProcessAlive(pidToKill)) {
            this.logToManager('warn', '进程未响应 SIGTERM，尝试强制终止...');
            ok = await this.forceKillOrReportCancelled(pidToKill);
          } else {
            this.logToManager('info', 'sing-box 进程已停止');
          }
        } else {
          this.logToManager('warn', `停止 sing-box 进程可能失败，退出码: ${code}`);
          ok = await this.forceKillOrReportCancelled(pidToKill);
        }
        if (ok) this.finishStop(); // 取消授权(进程仍活) → 不谎报已停止（M3）
        resolve();
      });

      killProcess.on('error', async (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        await this.forceKillProcess(pidToKill);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 停止 sing-box 进程（Windows TUN 模式）
   * 主路径（批2 Win-B）：写 stopflag → 提权看护脚本 ~1s 内 Stop-Process 收割 —— 停止零 UAC。
   * 兜底：等待超时（跨版本旧直起无看护 / 看护异常）且非退出语境 → RunAs taskkill（一次 UAC，
   * 与旧版语义一致）；退出语境恪守零弹框不变量 → 仅 log 跳过（父进程消失后看护脚本自行收割，
   * 确无看护的残留交下次启动的提权清扫）。
   */
  private async stopSingBoxOnWindows(opts?: { quitting?: boolean }): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;

    // 进程已不在 → 直接收尾，免一次 UAC（镜像 macOS M1-a）
    if (!this.isProcessAlive(pidToKill)) {
      this.logToManager('info', 'sing-box 进程已不在，跳过提权终止');
      this.finishStop();
      return;
    }

    // 主路径：写 stopflag，由提权看护脚本收割 sing-box —— 停止无需再次 UAC
    this.logToManager('info', `正在停止 sing-box (PID: ${pidToKill})，通知看护脚本...`);
    try {
      require('fs').writeFileSync(this.getStopFlagPath(), '');
    } catch (e) {
      this.logToManager('warn', `写 stopflag 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 看护脚本 1s 轮询 + Stop-Process，5s 覆盖足够；退出语境压到 3s（cleanupResources 8s 预算内）
    if (await this.waitForProcessExit(pidToKill, opts?.quitting ? 3000 : 5000)) {
      this.logToManager('info', 'sing-box 已由看护脚本停止（无需 UAC）');
      this.finishStop();
      return;
    }

    // 超时：看护脚本未收口（跨版本边界：旧版 Start-Process 直起无看护；或看护异常退出）
    if (opts?.quitting) {
      // 退出语境零弹框（跨平台不变量）：跳过 RunAs taskkill。父进程消失后看护脚本仍会 ~1s 收割；
      // 确无看护时残留交下次启动的提权清扫（watchdog 步骤 a）。stopflag 留给看护消费/下次启动清理。
      this.logToManager(
        'warn',
        `看护脚本未及时停止 sing-box（PID ${pidToKill}），退出语境跳过 UAC 弹框（父死看护/下次启动清扫兜底）`
      );
      this.finishStop();
      return;
    }

    this.logToManager('warn', '看护脚本未及时停止 sing-box，退回提权 taskkill（需要 UAC 授权）...');
    return new Promise((resolve) => {
      // RunAs taskkill 兜底：覆盖旧版直起（无看护）与看护异常两种情形，一次 UAC（与旧版语义一致）。
      // /FI "IMAGENAME eq sing-box.exe" 防 PID 复用误杀（值含空格→ -ArgumentList 元素须内嵌双引号；VM 实测通过）。
      const psScript =
        `Start-Process -FilePath '${system32('taskkill.exe')}' -ArgumentList '/F','/PID','` +
        pidToKill.toString() +
        "','/FI','\"IMAGENAME eq sing-box.exe\"' -Verb RunAs -Wait -WindowStyle Hidden";

      const killProcess = spawn(
        powershellPath(),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        {
          windowsHide: true,
        }
      );

      killProcess.stderr?.on('data', (data) => {
        this.logToManager('warn', `taskkill stderr: ${data.toString()}`);
      });

      killProcess.on('exit', (code) => {
        if (code === 0) {
          this.logToManager('info', 'sing-box 进程已停止');
        } else {
          // 非零退出码可能是进程已退出或用户取消 UAC
          this.logToManager('warn', `停止进程结果: code=${code}`);
        }

        // 兜底路径无看护脚本消费 stopflag → 主动清掉，防下次会话看护误触发
        try {
          require('fs').unlinkSync(this.getStopFlagPath());
        } catch {
          /* 忽略 */
        }

        this.finishStop();
        resolve();
      });

      killProcess.on('error', (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 等待进程退出。
   * T16 子 commit 3：改 public 供 PlatformPrivilegeService.ctx.waitForProcessExit 回调注入（stopElevated 用）。
   */
  async waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    // win32 的 isProcessAlive 走 tasklist execSync（每次阻塞主循环 ~50-100ms）→ 放宽轮询到 400ms 降低阻塞；
    // mac/linux 走 ps（轻量）→ 维持 100ms 更快感知退出。(批2 P2-3，VM 实测收割 0.5-0.7s 远小于超时)
    const pollMs = process.platform === 'win32' ? 400 : 100;
    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return !this.isProcessAlive(pid);
  }

  /**
   * 强制终止进程
   */
  private async forceKillProcess(pid: number): Promise<boolean> {
    await new Promise<void>((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -9 ${pid}" with administrator privileges`,
      ]);

      killProcess.on('close', () => {
        resolve();
      });

      killProcess.on('error', () => {
        // 最后尝试普通 kill
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 忽略错误
        }
        resolve();
      });
    });
    // 复核：osascript 取消授权时进程仍活 → 返回 false，调用方据此不谎报已停止（L4）。
    return !this.isProcessAlive(pid);
  }

  /**
   * 提权强杀 + 诚实兜底（L4/M3）：成功（进程已死）→ 返回 true，调用方照常 finishStop。
   * 取消授权致进程仍活 → 发 STOP_AUTH_CANCELLED 非终态提示 + 返回 false，调用方**不** finishStop（不谎报已停止）。
   * 残留 sing-box 会被下次启动的 resolveClashApiPortConflict 按端口清掉。
   */
  private async forceKillOrReportCancelled(pid: number): Promise<boolean> {
    const killed = await this.forceKillProcess(pid);
    if (killed || !this.isProcessAlive(pid)) return true;
    this.notifyStopAuthCancelled();
    return false;
  }

  /**
   * 通知「停止被取消授权」（发 STOP_AUTH_CANCELLED 非终态提示）。
   * T16 子 commit 3：从原 forceKillOrReportCancelled 抽出事件发送副作用——service.stopElevated 检测到
   * 取消授权（进程仍存活）时经 ctx.onStopAuthCancelled 回调触发本方法（service 不持 IPC 通道）。
   * 原 forceKillOrReportCancelled 保留兜底版（privilegeService 未注入时），内部改调本方法去重。
   */
  notifyStopAuthCancelled(): void {
    this.logToManager('error', '强制终止被取消，sing-box 仍在运行（下次启动会自动清理占用端口）');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: '停止被取消授权，代理仍在运行。请重试停止或在下次启动时自动清理。',
      errorCode: ProxyErrorCode.STOP_AUTH_CANCELLED,
      code: -4,
    });
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.stopLogFileWatcher();
    this.stopHealthCheck();
    this.singboxProcess = null;
    this.pid = null;
    this.singboxPid = null;
    this.startTime = null;
    this.startedViaHelper = false;
    // 进程已停 → 探针端口失效，置 null 让 IpInfoService 知道代理出口不可测
    this.probeDirectPort = null;
    this.probeProxyPort = null;
    // Tailscale 登录 URL 去重集随核会话收尾清空（绑定核会话而非整进程）：下个核会话若再触发交互登录，
    // 同一 URL 应重新弹「需登录」提示。tailscaleAuthPolling 有自身 delete 收尾，不在此动（勿破在飞登录）。
    this.tailscaleAuthSeen.clear();
  }

  /** 注入 macOS 提权 helper（index.ts 启动时调用）。 */
  setHelperManager(helperManager: IPrivilegedHelper): void {
    this.helperManager = helperManager;
  }

  /** 注入系统代理管理器（index.ts 启动时调用，须为同一 singleton）。系统代理单一写者收口于 ProxyManager。 */
  setSystemProxyManager(systemProxyManager: ISystemProxyManager): void {
    this.systemProxyManager = systemProxyManager;
  }

  /** 注入系统 DNS 管理器（index.ts 启动时调用，须为同一 singleton）。仅 TUN 模式接管，收口于 ProxyManager。 */
  setSystemDnsManager(systemDnsManager: ISystemDnsManager): void {
    this.systemDnsManager = systemDnsManager;
  }

  /** 注入「杀核前静默 StatsService」回调（停其到管理 API 的 Status/Connections gRPC 流）。杀核前提前 cancel 流避免 RST 噪音。 */
  setQuiesceStats(cb: () => void): void {
    this.quiesceStats = cb;
  }

  /** 注入平台提权服务（T16：原提权纯函数迁出，delegate 后调用点零改动）。 */
  setPrivilegeService(service: PlatformPrivilegeService): void {
    this.privilegeService = service;
  }

  /**
   * 当前是否处于 TUN 模式（只读公开判定）。供 PlatformPrivilegeService.ctx.isTunMode 回调注入，
   * 替代原 needsRootPrivilege 的 private currentConfig 隐式读取被外部 service 直接访问。
   * 语义与 needsRootPrivilege 的 TUN 判定一致（不含平台门控，纯模式判定）。
   */
  isTunModeNow(): boolean {
    return this.currentConfig?.proxyModeType === 'tun';
  }

  // ─── T16 子 commit 2：killOrphans 链迁出后的只读 getter（供 PlatformPrivilegeService.ctx 回调注入）──

  /** 本次 start 是否交互式（非交互=崩溃自动重启）。供 service.escalateKillRootOrphans 非交互保护。 */
  isStartInteractive(): boolean {
    return this.startInteractive;
  }

  /** sing-box 配置文件路径（macOS 系统代理模式 pgrep 匹配 orphan 用）。 */
  getConfigPath(): string {
    return this.configPath;
  }

  /** sing-box 核心可执行路径（Linux pgrep 匹配 orphan 用）。 */
  getSingboxPath(): string {
    return this.singboxPath;
  }

  /** 当前管理的 sing-box PID（singboxPid || pid），供 killOrphans 排除避免误杀自己；null 表示无。 */
  getCurrentManagedPid(): number | null {
    return this.singboxPid || this.pid;
  }

  /** 注入 helper 引导门控回调（index.ts 启动时调用）。收敛单点，见 maybePromptHelperGate。 */
  setHelperGate(fn: (hs: HelperStatus, config: UserConfig) => Promise<'proceed' | 'abort'>): void {
    this.helperGate = fn;
  }

  /** 本次代理是否经 helper 启动（供「卸载 helper 前先零提权停核」判定，避免卸载后 stop 裸弹 osascript）。 */
  isStartedViaHelper(): boolean {
    return this.startedViaHelper;
  }

  /**
   * 清理可能残留的 sing-box 进程（顶层平台分发）。
   * T16 子 commit 2：实现迁入 PlatformPrivilegeService.killOrphans，此处 delegate。
   * startInternal:658 调用点不变；ROOT_ORPHAN_BLOCKED 异常仍从此冒泡到 attemptAutoRestart 判终态。
   */
  private async killOrphanedSingBoxProcesses(isTunMode: boolean): Promise<void> {
    // Windows：先经 helper 服务(SYSTEM)清掉孤儿 sing-box（含 SYSTEM 提权孤儿，零 UAC）—— privilegeService 的
    // 非提权 taskkill 对 SYSTEM 孤儿 Access denied 杀不动。镜像 macOS killOrphans 经 helper.cleanup 的零提权清理。
    // 未装/未就绪则 cleanup 经管道 ENOENT 快速失败、无额外延迟、不弹框。
    if (process.platform === 'win32' && this.helperManager) {
      try {
        await this.helperManager.cleanup();
      } catch {
        /* best-effort */
      }
    }
    await this.privilegeService?.killOrphans(isTunMode);
  }

  /**
   * 等待网络清理完成（sing-box 进程终止后系统清理 TUN 接口/路由表）。
   * T16 子 commit 2：随 killOrphans 链迁出后，此方法被 PlatformPrivilegeService.ctx 回调注入；
   * 仅 ~6 行实现 + 无私有状态依赖，留 ProxyManager（与 isProcessAlive 同属进程状态判定工具）。
   */
  async waitForNetworkCleanup(): Promise<void> {
    // 等待 2 秒让系统清理 TUN 接口
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 可选：刷新 DNS 缓存（macOS）
    if (process.platform === 'darwin') {
      try {
        const { exec } = require('child_process');
        exec('dscacheutil -flushcache; killall -HUP mDNSResponder', (error: Error | null) => {
          if (error) {
            this.logToManager('debug', `刷新 DNS 缓存失败: ${error.message}`);
          } else {
            this.logToManager('debug', 'DNS 缓存已刷新');
          }
        });
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 检查进程是否存活
   *
   * 统一使用系统命令检测进程，避免 Node.js process.kill(pid, 0) 在检测
   * 特权进程时的不可靠性（macOS/Windows TUN 模式下 sing-box 以管理员权限运行）
   *
   * T16 子 commit 2：改 public 供 PlatformPrivilegeService.ctx 回调注入（killOrphans 复核存活用）。
   */
  isProcessAlive(pid: number): boolean {
    try {
      const { execSync } = require('child_process');

      if (process.platform === 'win32') {
        // Windows: 使用 tasklist 检测进程
        // /FI "PID eq xxx" 过滤指定 PID，/NH 不显示表头
        const result = execSync(`"${system32('tasklist.exe')}" /FI "PID eq ${pid}" /NH`, {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        // 如果进程存在，输出会包含进程信息；不存在则输出 "INFO: No tasks..."
        return !result.includes('No tasks') && result.includes(String(pid));
      } else {
        // macOS/Linux: 使用 ps 检测进程
        const result = execSync(`ps -p ${pid} -o pid=`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return result.trim() === String(pid);
      }
    } catch {
      // 命令执行失败，进程不存在
      return false;
    }
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, ProxyManager.HEALTH_CHECK_INTERVAL);

    this.logToManager('debug', '已启动进程健康检查');
  }

  /**
   * 停止健康检查定时器
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * 执行健康检查
   */
  private performHealthCheck(): void {
    // 如果正在重启中，跳过检查
    if (this.isRestarting) {
      return;
    }

    // 判定依据与 getStatus 一致：经包装进程(osascript/UAC)启动才取 singboxPid，否则取 pid。
    // 修复 Linux TUN（直接 spawn，singboxPid 恒 null）下健康检查/自动重启完全失效（issue #33）。
    const wrapperMode = this.needsOsascript() || this.needsWindowsUAC();
    const activePid = wrapperMode ? this.singboxPid : this.singboxPid || this.pid;

    if (!activePid) {
      return;
    }

    if (!this.isProcessAlive(activePid)) {
      // 尝试获取更多退出信息
      const exitInfo = this.getProcessExitInfo();
      this.logToManager(
        'error',
        `检测到 sing-box 进程 (PID: ${activePid}) 已意外退出${exitInfo ? `，${exitInfo}` : ''}`
      );

      // 清理资源（但不停止健康检查，因为可能要重启）
      this.singboxProcess = null;
      this.pid = null;
      this.singboxPid = null;
      // 进程已死 → 复位 helper 标志，避免随后自动重启若回退非 helper 路径时，停止仍误走 helper 分支。
      this.startedViaHelper = false;
      this.stopLogFileWatcher();

      // 尝试自动重启
      if (this.shouldAutoRestart()) {
        this.attemptAutoRestart();
      } else {
        // 无法自动重启，通知用户
        this.emit('error', {
          message: 'sing-box 进程意外退出，已达到最大重启次数，请手动重启',
          code: -1,
        });

        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: 'sing-box 进程多次异常退出，请检查网络或服务器配置后手动重启',
          errorCode: ProxyErrorCode.RESTART_LIMIT_REACHED,
          code: -1,
        });

        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        // 终态：清掉曾指向我们的系统代理，避免进程已死但系统代理仍指向死端口致全网断（marker 门控、单飞）。
        void this.ensureSystemProxyCleared();

        // 完全清理
        this.cleanup();
      }
    }
  }

  /**
   * 检查是否应该自动重启
   */
  private shouldAutoRestart(): boolean {
    if (!this.autoRestartEnabled || !this.currentConfig) {
      return false;
    }
    // 核心更新待验证窗口：禁止自动重启，使新核心首次异常退出立即上报 error → 触发回滚
    if (this.autoRestartSuppressed) {
      return false;
    }

    const now = Date.now();

    // 如果距离上次重启超过冷却时间，重置计数
    if (now - this.lastRestartTime > ProxyManager.RESTART_COOLDOWN) {
      this.restartCount = 0;
    }

    // 检查是否超过最大重启次数
    return this.restartCount < ProxyManager.MAX_RESTART_COUNT;
  }

  /** 核心更新待验证窗口内由 CoreUpdateService 置 true：抑制自动重启，首次失败即上报触发回滚。 */
  setAutoRestartSuppressed(suppressed: boolean): void {
    this.autoRestartSuppressed = suppressed;
  }

  /** 核心更新二进制替换窗口内置位（CoreUpdateService.installCoreFromDir 调）：拒绝手动启动/重启/切模式，防撞半替换核。 */
  setCoreSwapInProgress(inProgress: boolean): void {
    this.coreSwapInProgress = inProgress;
  }

  /**
   * core-swap 手动轴门控：内核二进制替换进行中时拒绝手动 start/restart/switchMode。抛带 CORE_UPDATE_IN_PROGRESS
   * code 的错，经 IPC 链（register wrappedHandler 转 ApiResponse.code）让渲染端提示「内核更新中」（H-2：勿静默 reject
   * 致 UI 卡「未连接」）。仅拦手动轴——崩溃轴（install-vs-autoRestart）已由 shouldAutoRestart 检 autoRestartSuppressed 覆盖。
   */
  private rejectIfCoreSwapInProgress(action: string): void {
    if (this.coreSwapInProgress) {
      this.logToManager('warn', `内核更新进行中，已拒绝手动${action}（防撞半替换核）`);
      const err = new Error('内核更新进行中，请稍候再试') as Error & { code?: ProxyErrorCode };
      err.code = ProxyErrorCode.CORE_UPDATE_IN_PROGRESS;
      throw err;
    }
  }

  /** 当前配置是否含 naive 节点（naive 依赖随 app 打包的 libcronet，核心更新可能引入 ABI 漂移）。 */
  hasNaiveNodes(): boolean {
    return (this.currentConfig?.servers || []).some(
      (s) => (s.protocol || '').toLowerCase() === 'naive'
    );
  }

  /**
   * 尝试自动重启
   */
  private async attemptAutoRestart(): Promise<void> {
    // 幂等去重：进程 exit 事件与健康检查轮询可能对同一次崩溃同时触发，已有重启在途则跳过
    if (this.isRestarting) {
      return;
    }
    if (!this.currentConfig) {
      return;
    }
    // 用户已主动停止 → 不再自动重启（M3）。覆盖「自循环 setTimeout 唤醒」与「健康检查再次触发」两个入口。
    // 不是裸 return：若标记是「自动重启 start 腿窗口内用户停止」遗留（stop 因 refs null 早退而 start 已完成），
    // 此后二次崩溃会走到这里——必须做终态收尾（emit stopped + 清系统代理 + cleanup），否则 UI 卡「已连接」、
    // systemProxy 指向死端口静默断网（M-1′）。幂等：cleanup 后 refs 清空、健康检查不再触发。
    if (this.autoRestartAborted) {
      this.finalizeUserAbortedRestart();
      return;
    }
    // 快照生命周期世代：退避后比对，若被更新的 start/stop 接管则让位（M-2′）。在 isRestarting 置位前取，
    // 这样本方法稍后自己调的 start() 对 gen 的递增不影响本次比对基线。
    const myGen = this.lifecycleGeneration;

    this.isRestarting = true;
    this.restartingGen = myGen; // 记在途腿世代，供 handleProcessExit 判 supersede（M-2′-G1）
    this.restartCount++;
    this.lastRestartTime = Date.now();

    // 退避：第 1 次 2s、第 2 次 5s、第 3 次 15s——端口/helper 等外部资源需时间释放，固定 2s 纯刷屏。
    const backoffMs = this.restartCount <= 1 ? 2000 : this.restartCount === 2 ? 5000 : 15000;
    this.logToManager(
      'warn',
      `正在尝试自动重启 sing-box (第 ${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT} 次，${Math.round(backoffMs / 1000)}s 后)...`
    );

    // 通知前端正在重启
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: `sing-box 进程异常退出，正在自动重启 (${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT})...`,
      errorCode: ProxyErrorCode.AUTO_RESTARTING,
      errorParams: { attempt: this.restartCount, max: ProxyManager.MAX_RESTART_COUNT },
      code: -2, // 特殊代码表示正在重启
    });

    let retryScheduled = false;
    try {
      // 退避等待，让系统/端口/helper 释放
      await new Promise((resolve) => setTimeout(resolve, backoffMs));

      // 退避期间用户已主动停止 → 放弃本次自动重启（用户意图优先，M3：否则停了又被拉起）。
      if (this.autoRestartAborted) {
        this.finalizeUserAbortedRestart();
        return; // finally 复位 isRestarting；retryScheduled 仍 false → 不再自循环调度
      }
      // 退避期间已有更新的 start/stop 接管生命周期（如用户手动 start——它会 reset autoRestartAborted 绕过上面的
      // 检查）→ 让位，不起第二条 start 流（杜绝双启动流互杀进程/撞 9090/误清对方系统代理，M-2′）。
      // 注：stop 接管会先置 autoRestartAborted=true 走上面的 abort 分支，故到这里的 supersede 必是 start 接管。
      if (this.lifecycleGeneration !== myGen) {
        // 精确判据用 crashWhileSuperseded（仅 handleProcessExit 真崩溃时置位），不用 refs 快照——否则「接管 start
        // 尚未 spawn（如卡在 helper 引导框）refs 暂为 null」会被误判成接管已死 → 补发重启与接管 start 双流。
        const recover = this.crashWhileSuperseded;
        this.crashWhileSuperseded = false;
        if (recover) {
          // 接管会话在本腿退避期内崩溃、其崩溃信号被本腿 isRestarting dedup 吞掉 → 无人恢复 → 补发一次自动重启
          // 兜底，避免 limbo/死端口断网（M-2′-G1）。schedGen + refs 守卫：补发前若又被新操作接管/已起来则不补。
          this.logToManager('warn', '接管会话在退避期内崩溃，补发一次自动重启兜底');
          const schedGen = this.lifecycleGeneration;
          setTimeout(() => {
            if (this.lifecycleGeneration !== schedGen) return; // 已被更新的 start/stop 接管
            if (this.singboxProcess || this.singboxPid) return; // 期间已起来
            void this.attemptAutoRestart();
          }, 0);
        } else {
          this.logToManager('info', '自动重启已让位（检测到更新的启动/停止操作接管）');
        }
        return; // finally 复位 isRestarting
      }

      // 重新启动（崩溃自动重启：interactive:false，禁 helper 引导模态，防崩溃循环弹窗风暴）
      await this.start(this.currentConfig, { interactive: false });

      // issue #176：本腿 start 在就绪等待期被用户手动 start/stop 接管 → start() 已静默让位返回（未真起核），
      //   不能误报「自动重启成功」+ 发陈旧 started 事件（接管方会自己发终态）。让位时直接退场，finally 复位 isRestarting。
      if (this.lastStartSuperseded) {
        this.logToManager('info', '自动重启已让位（start 期被更新的启动/停止操作接管）');
        return;
      }

      this.logToManager('info', 'sing-box 自动重启成功');

      // 通知前端重启成功
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
        pid: this.singboxPid || this.pid,
        startTime: this.startTime,
        autoRestarted: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `自动重启失败: ${errorMessage}`);

      // 不可恢复（helper 不可用 / 权限 / gate 取消）或已达上限 → 立即终态；否则退避后再试。
      // 修 limbo：原实现 count<MAX 时什么都不做，而 performHealthCheck 因 pid 已清空永不再触发 →
      // UI 永久卡在 AUTO_RESTARTING(x/3)、且系统代理永不回滚。现由本方法自循环驱动重试直到成功或终态。
      if (
        this.restartCount >= ProxyManager.MAX_RESTART_COUNT ||
        this.isUnrecoverableRestartError(errorMessage)
      ) {
        await this.giveUpAutoRestart(errorMessage);
      } else {
        retryScheduled = true;
      }
    } finally {
      this.isRestarting = false;
      this.restartingGen = -1; // 本腿离场 → 清在途世代（M-2′-G1）
    }

    // isRestarting 已复位后再调度下一次（否则被入口幂等去重挡掉）；退避在下一次 attemptAutoRestart 内部按计数计算。
    // 快照世代并在 fire 时比对：覆盖「finally 复位 isRestarting 到本回调 fire」之间的 macrotask 缝隙——
    // 该缝隙内 refs=null+isRestarting=false，stop() 不置 autoRestartAborted，仅靠世代变化拦下重试（L-1′）。
    if (retryScheduled) {
      const schedGen = this.lifecycleGeneration;
      setTimeout(() => {
        if (this.lifecycleGeneration !== schedGen) return; // 调度后已被 start/stop 接管 → 不再重试
        void this.attemptAutoRestart();
      }, 0);
    }
  }

  /**
   * 自动重启被用户主动停止打断 → 终态收尾：emit stopped + 清系统代理（marker 门控，非主动 stop 语境 stopping=false
   * → 会真清，覆盖「racy start 已重设 systemProxy」的情形）+ cleanup。修 M-1′ 静默 limbo/断网。
   */
  private finalizeUserAbortedRestart(): void {
    this.crashWhileSuperseded = false; // 用户已停止 → 不需补发，清陈旧标记（M-2′-G1 防陈旧）
    // 注：重复 emit stopped 幂等无害（渲染端 stopProxy 还有 IPC resolve 兜底），不加「已干净则跳过」守卫——
    // 否则 M3「退避期停止、marker 已被前置清理、refs 已 null」会被守卫吞掉这次必要的 stopped 事件。
    this.logToManager('info', '自动重启已取消（用户主动停止）');
    this.emit('stopped');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    void this.ensureSystemProxyCleared();
    this.cleanup();
  }

  /**
   * 自动重启彻底放弃 → 终态：上报错误 + emit stopped + 清理。
   * 系统代理失败回滚由 ensureSystemProxyCleared 在此统一收口（T3 注入 systemProxyManager 后挂入）。
   */
  private async giveUpAutoRestart(errorMessage: string): Promise<void> {
    this.crashWhileSuperseded = false; // 已终态放弃 → 清陈旧补发标记（M-2′-G1 防陈旧）
    this.emit('error', { message: `自动重启失败: ${errorMessage}`, code: -1 });
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: `自动重启失败，请手动重启: ${errorMessage}`,
      errorCode: ProxyErrorCode.AUTO_RESTART_FAILED,
      code: -1,
    });
    this.emit('stopped');
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    await this.ensureSystemProxyCleared();
    // 场景 B：TUN 自动重启（非交互、无法弹引导框）因提权助手被系统「后台活动」关闭而终态失败 →
    // 桌面通知引导用户恢复（native Notification 无窗口依赖，托盘态/窗口关闭也能送达）。
    await this.maybeNotifyHelperBackgroundDisabled();
    this.cleanup();
  }

  /**
   * 提权助手被「后台活动」(BTM, macOS 13+) 关闭致 TUN 终态失败时，发桌面通知引导用户去系统设置重新允许 /
   * 在 app 内修复并启动。仅 darwin + 确为 backgroundDisabled 才发，避免对普通失败误报。通知失败不影响终态。
   */
  private async maybeNotifyHelperBackgroundDisabled(): Promise<void> {
    if (process.platform !== 'darwin' || !this.helperManager) return;
    try {
      const hs = await this.helperManager.getStatus().catch(() => null);
      if (!hs?.backgroundDisabled) return;
      // 经 notifyUser 统一出口：受桌面通知总开关管控 + isSupported 守卫内置。文案走 main i18n（5 语）。
      notifyUser(
        mt('helperDisabledTitle'),
        mt('helperDisabledBody'),
        () => void shell.openExternal(LOGIN_ITEMS_SETTINGS_URL).catch(() => {})
      );
    } catch {
      /* 通知失败不影响终态 */
    }
  }

  /** 不可恢复的自动重启错误（helper 不可用 / 权限 / gate 取消 / 孤儿占端口未清）→ 不再重试，立即终态。 */
  private isUnrecoverableRestartError(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes('权限') ||
      m.includes('permission') ||
      m.includes('helper_gate_aborted') ||
      m.includes('提权助手不可用') ||
      m.includes('提权助手引导') ||
      m.includes('root_orphan_blocked') ||
      m.includes('root 残留') ||
      m.includes('clash_api_port_busy') ||
      m.includes('clash_api 端口')
    );
  }

  /**
   * 系统代理统一清理收口（public）：仅当系统代理确由 FlowZ 设置（marker 在 + 实查指向我们）才 disable，
   * 杜绝失败/崩溃/外部死亡后系统代理指向死端口致全网断，也不误清用户自配代理。
   * 调用方：① ProxyManager 内部终态（giveUp / 健康检查达上限 / handleProcessExit 信号死·崩溃 / 去抖重启 catch /
   * restart 的 start 腿失败）；② index.ts 'stopped'/'error' 监听器（外部死亡兜底）；③ IPC PROXY_STOP / 托盘 onStop
   * （用户主动停止，stop() 前置调用）。统一经此 → 不再有「无门控直 disableProxy」的 Writer C（修 C1 竞态 + M4 stomp）。
   * 门控：stopping（主动停止/重启中跳过，由 start reconcile 或前置清理负责，免与 enable 并发打架）+ 单飞 + marker。
   */
  async ensureSystemProxyCleared(): Promise<void> {
    if (this.stopping) return; // 主动停止/重启中 → 跳过，避免清了又被 start() reconcile 设回的竞态
    // 系统 DNS 还原与系统代理清理同终态点收口（各自 marker + 单飞门控，互不影响）：让每条「核已死」路径
    // （giveUp/健康检查/信号死·崩溃/重启 catch/外部死亡/用户停止前置）都顺带还原可能残留的受控 DNS，
    // 无需在 7 处终态点各加一行。stopping 守卫共用（重启 stop 腿跳过，由 start reconcile 重设/还原）。
    await this.ensureSystemDnsRestored();
    if (this.clearingSystemProxy) return; // 单飞：多路终态并发只清一次
    const mgr = this.systemProxyManager;
    if (!mgr) return;
    // 仅当系统代理确由 FlowZ 设置（marker 在）才动手 → 杜绝误清用户自配代理
    const marker = SystemProxyBase.readMarker();
    if (!marker) return;

    this.clearingSystemProxy = true;
    try {
      const status = await mgr.getProxyStatus().catch(() => null);
      // 与启动期 marker 恢复同口径：精确 host:port 或 host 匹配（兜 mac socks 端口与 http 端口不同的情形）
      const markerHost = marker.ourHostPort.split(':')[0];
      const pointsToUs = (p?: string): boolean =>
        !!p && (p === marker.ourHostPort || p.split(':')[0] === markerHost);
      const stillOurs =
        !!status?.enabled &&
        (pointsToUs(status.httpProxy) ||
          pointsToUs(status.httpsProxy) ||
          pointsToUs(status.socksProxy));

      if (stillOurs) {
        // 系统代理仍指向我们的（已死的）端口 → disable：内部 restore 原始（已被 stripSelf 置 null → 简单关）+ 删 marker
        await mgr.disableProxy();
        this.logToManager('info', '终态已清除系统代理（曾指向 FlowZ，避免死端口致全网断）');
      } else {
        // 已关 / 用户手改指向别处 → 仅清失真 marker；但若期间已被新一轮 enable 写了新 marker（host:port 变了）
        // 则保留，防误删新会话 marker 致其兜底全瞎（C1 的 marker 删除竞态防护）。
        const cur = SystemProxyBase.readMarker();
        if (cur && cur.ourHostPort === marker.ourHostPort) SystemProxyBase.clearMarkerFile();
      }
    } catch (e) {
      this.logToManager(
        'warn',
        `终态清除系统代理失败: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      this.clearingSystemProxy = false;
    }
  }

  /**
   * TUN 进入后的残留系统代理提示：ensureSystemProxyCleared 已清掉 FlowZ 自己的(marker)；若系统代理仍开着，
   * 即为**无 marker 残留**——可能是别的代理软件(Clash/Stash 等共用 7890)或外部/企业代理，也可能是我们丢了 marker。
   * 因 7890 等是业内共用端口、无法据地址证明归属，**绝不自动清**(会误伤别的软件)→ 发一次性 advisory 交用户一键关。
   * best-effort：读状态失败/无残留则静默。
   */
  private async adviseIfResidualSystemProxy(): Promise<void> {
    const mgr = this.systemProxyManager;
    if (!mgr) return;
    try {
      const status = await mgr.getProxyStatus().catch(() => null);
      if (!status?.enabled) return;
      const proxy = status.httpProxy || status.httpsProxy || status.socksProxy || '';
      // 防自指：若残留指向 FlowZ 自己的本地端口(127.0.0.1:mixedPort)=我们自己的代理清理半失败(非外部)，不报「外部残留」
      //（会误导）。仅 ensureSystemProxyCleared 的清理偶发部分失败时出现；下个终态点会重试清。修 round-2 MED:mac/linux 误报。
      const ownHostPort = `127.0.0.1:${localProxyPort(this.currentConfig ?? {})}`;
      if ([status.httpProxy, status.httpsProxy, status.socksProxy].some((p) => p === ownHostPort)) {
        this.logToManager(
          'warn',
          `系统代理仍指向 FlowZ 自身(${proxy})但清理未净——非外部残留，跳过提示，下个终态点重试清理`
        );
        return;
      }
      this.logToManager(
        'warn',
        `TUN 模式下检测到非 FlowZ 设置的系统代理仍开启(${proxy || '未知地址'})，已提示用户（不自动清，避免误伤其它代理软件）`
      );
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_SYSTEM_PROXY_RESIDUAL, { proxy });
    } catch {
      /* best-effort：提示失败不影响 TUN 启动 */
    }
  }

  /**
   * 用户主动关闭系统代理（TUN 残留提示的「关闭系统代理」一键动作）。用户显式意图 → 直接 disable
   * (ProxyEnable=0 / restore 原始)，不 marker 门控(残留本就无我们的 marker)。供 IPC SYSTEM_PROXY_DISABLE 调。
   */
  async clearSystemProxyManually(): Promise<void> {
    await this.systemProxyManager?.disableProxy();
    this.logToManager('info', '已按用户请求关闭系统代理（TUN 残留提示）');
  }

  /**
   * 系统 DNS 统一还原收口（public）：仅当 DNS 确由 FlowZ 接管（marker 在）才还原，杜绝误改用户自配 DNS。
   * 调用方：① ensureSystemProxyCleared 内（覆盖全部「核已死」终态点，免逐点加行）；② start() reconcile 的
   * 非 TUN 分支（systemProxy/manual 切换后还原残留）。门控镜像 ensureSystemProxyCleared：
   * stopping（重启 stop 腿跳过，由 start reconcile 重设/还原负责）+ 单飞 + marker。
   * 注意：本方法不重复 stopping 守卫——它已由唯一外部入口在调用前判定（ensureSystemProxyCleared 顶部 /
   * start reconcile 仅在非重启路径调用）；此处仅做 单飞 + marker 门控，避免与 ensureSystemProxyCleared 的
   * stopping 早返回语义打架。
   */
  async ensureSystemDnsRestored(): Promise<void> {
    if (this.clearingSystemDns) return; // 单飞：多路终态并发只还原一次
    // 还原 = DNS 接管即将/已终态 → 顺带停 watcher（覆盖崩溃/外部死亡/giveUp 这些不经 stop() 的终态点，经
    // ensureSystemProxyCleared → 本方法收口）。幂等：watcher 不在则 no-op。放 marker 判定之前——即便已无 marker
    // 也确保 watcher 停掉（避免接管已失效但 watcher 仍空转探链路）。
    this.stopDnsInterfaceWatcher();
    const mgr = this.systemDnsManager;
    if (!mgr) return;
    // 仅当 DNS 确由 FlowZ 接管（marker 在）才动手 → 不误改用户自配/系统默认 DNS
    if (!mgr.hasMarker()) return;

    this.clearingSystemDns = true;
    try {
      await mgr.restoreDns();
    } catch (e) {
      this.logToManager(
        'warn',
        `终态还原系统 DNS 失败: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      this.clearingSystemDns = false;
    }
  }

  /**
   * 起 macOS DNS 接管「热插重灌」watcher（薄接线）：仅 darwin 起（与 setDns 真接管同口径；Win/Linux no-op）。
   * 长驻 route -n monitor + powerMonitor resume → 命中去抖 → 经门控（shouldReconcileDns）判定后调 reconcileDns()。
   * 幂等（DnsInterfaceWatcher.start 内部 started 守卫）。best-effort：构造/起失败仅 warn，绝不抛、不阻断 TUN 启动。
   */
  private startDnsInterfaceWatcher(): void {
    if (process.platform !== 'darwin') return; // 仅 macOS 接管系统 DNS → 仅此平台需热插重灌 watcher。
    if (this.dnsInterfaceWatcher) return; // 幂等：已在跑则 no-op（重复 setDns 不重起）。
    const mgr = this.systemDnsManager;
    if (!mgr) return;
    try {
      this.dnsInterfaceWatcher = new DnsInterfaceWatcher({
        // route -n monitor：长驻打印内核路由表变更事件（接口 up/down、地址增删、默认路由切换）。
        spawnRouteMonitor: () =>
          spawn('route', ['-n', 'monitor'], { stdio: ['ignore', 'pipe', 'ignore'] }),
        powerMonitor,
        // 去抖后的统一 reconcile 入口：门控镜像 setDns（仅 TUN + 未关接管 + marker 在才动手），否则跳过。
        onTrigger: async () => {
          if (!shouldReconcileDns(this.currentConfig, mgr.hasMarker())) return;
          await mgr.reconcileDns();
        },
        debounceMs: 1500, // 1.5s：合并插坞站/换网的 RTM_ burst（设计建议 1–2s）。
        schedule: (fn, ms) => setTimeout(fn, ms),
        clearSchedule: (h) => clearTimeout(h),
        onWarn: (level, message) => this.logToManager(level, message),
      });
      this.dnsInterfaceWatcher.start();
      this.logToManager('info', 'DNS 接口 watcher 已启动（热插/换网/唤醒 → 重灌系统 DNS 接管）');
    } catch (e) {
      this.dnsInterfaceWatcher = null;
      this.logToManager(
        'warn',
        `启动 DNS 接口 watcher 失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** 停 DNS 接口 watcher（杀 route monitor 子进程 + 反注册 resume + 取消在飞去抖）。幂等、best-effort 不抛。 */
  private stopDnsInterfaceWatcher(): void {
    if (!this.dnsInterfaceWatcher) return;
    try {
      this.dnsInterfaceWatcher.stop();
    } catch (e) {
      this.logToManager(
        'warn',
        `停止 DNS 接口 watcher 失败: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      this.dnsInterfaceWatcher = null;
    }
  }

  /**
   * 设置是否启用自动重启
   */
  setAutoRestartEnabled(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
    this.logToManager('info', `自动重启已${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 重置重启计数（用于用户手动启动后）
   */
  private resetRestartCount(): void {
    this.restartCount = 0;
    this.lastRestartTime = 0;
  }

  /**
   * 获取进程退出信息（用于诊断）
   * 尝试从系统日志或 sing-box 日志文件中获取退出原因
   */
  private getProcessExitInfo(): string {
    const info: string[] = [];

    try {
      const fsSync = require('fs');
      const logFilePath = this.getLogFilePath();

      // 读取 sing-box 日志文件的最后几行
      if (fsSync.existsSync(logFilePath)) {
        const logContent = fsSync.readFileSync(logFilePath, 'utf-8');
        const lines = logContent.trim().split('\n');
        const lastLines = lines.slice(-10); // 最后 10 行

        // 查找错误或警告信息
        for (const line of lastLines) {
          const lowerLine = line.toLowerCase();
          if (
            lowerLine.includes('error') ||
            lowerLine.includes('fatal') ||
            lowerLine.includes('panic') ||
            lowerLine.includes('failed')
          ) {
            info.push(`日志: ${line.substring(0, 200)}`);
          }
        }
      }

      // macOS: 尝试从系统日志获取信息
      if (process.platform === 'darwin') {
        const { execSync } = require('child_process');
        try {
          // 查询最近的 sing-box 相关系统日志
          const sysLog = execSync(
            `log show --predicate 'process == "sing-box"' --last 1m --style compact 2>/dev/null | tail -5`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (sysLog) {
            info.push(`系统日志: ${sysLog.substring(0, 300)}`);
          }
        } catch {
          // 忽略系统日志查询失败
        }
      }
    } catch {
      // 忽略诊断错误
    }

    return info.length > 0 ? info.join('; ') : '';
  }

  /**
   * 等待 PID 文件被写入（macOS/Windows TUN 模式）
   *
   * 重要：在调用此方法前，必须先删除旧的 PID 文件，否则可能读到旧的 PID
   */
  private async waitForPidFile(): Promise<void> {
    const pidFile = this.getPidFilePath();
    const maxWaitTime = 60000; // 最多等待 60 秒（给 macOS 权限提升过程留足时间）
    const checkInterval = 200; // 每 200ms 检查一次
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const pidContent = await fs.readFile(pidFile, 'utf-8');
        const pid = parseInt(pidContent.trim(), 10);
        if (!isNaN(pid) && pid > 0) {
          // 验证这个 PID 对应的进程确实存在且是 sing-box
          if (this.isProcessAlive(pid)) {
            this.singboxPid = pid;
            this.pid = pid;
            this.logToManager('info', `sing-box 后台进程 PID: ${pid}`);
            return;
          }
        }
      } catch {
        // 文件还不存在，继续等待
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    this.logToManager('warn', 'PID 文件等待超时');
  }

  /**
   * 删除 PID 文件
   * 在启动新进程前调用，确保不会读到旧的 PID
   */
  private async deletePidFile(): Promise<void> {
    try {
      await fs.unlink(this.getPidFilePath());
    } catch {
      // 文件不存在，忽略
    }
  }

  /**
   * 获取 PID 文件路径
   */
  private getPidFilePath(): string {
    return getSingBoxPidPath();
  }

  /**
   * 将内置规则文件落地到 User Data 运行时目录。
   * 解决 macOS TUN 模式下特权进程无法读取 Downloads/Documents 目录的问题。
   *
   * seed-if-missing-or-invalid（不再无条件覆盖）：仅当运行时文件缺失/损坏时从出厂版补种，
   * 已存在的合法文件原样保留——否则「规则资源」页对内置项的网络更新会在下次启动被出厂版静默回滚。
   * 内容更新由 sing-box ≥1.10 fswatch 热重载，不经此处。详见 builtin-geo-rulesets.seedBuiltinRuleSets。
   */
  private async copyRuleSetsToUserData(): Promise<void> {
    try {
      await seedBuiltinRuleSets();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `内置规则补种失败: ${errorMessage}`);
    }
  }

  /**
   * 启动日志文件监控（用于 macOS TUN 模式）
   */
  private startLogFileWatcher(): void {
    if (this.logFileWatcher) {
      return;
    }

    const logFilePath = this.getLogFilePath();
    this.lastLogFileSize = 0;

    // 清空旧的日志文件
    const fsSync = require('fs');
    try {
      fsSync.writeFileSync(logFilePath, '');
    } catch {
      // 忽略错误
    }

    // 每 500ms 检查一次日志文件
    this.logFileWatcher = setInterval(async () => {
      try {
        const stats = await fs.stat(logFilePath);

        // 防止长会话日志无限增长撑满磁盘：超过上限即截断（sing-box O_APPEND 写，截断后从 0 续写）
        if (stats.size > ProxyManager.MAX_LOG_FILE_SIZE) {
          await fs.truncate(logFilePath, 0);
          this.lastLogFileSize = 0;
          return;
        }

        // 如果文件大小变小了，说明文件被清空或截断了
        if (stats.size < this.lastLogFileSize) {
          this.lastLogFileSize = 0;
        }

        if (stats.size > this.lastLogFileSize) {
          // 读取新增的内容
          const fd = await fs.open(logFilePath, 'r');
          const buffer = Buffer.alloc(stats.size - this.lastLogFileSize);
          await fd.read(buffer, 0, buffer.length, this.lastLogFileSize);
          await fd.close();

          const newContent = buffer.toString('utf-8');
          this.lastLogFileSize = stats.size;

          // 处理日志内容
          if (newContent.trim()) {
            this.handleProcessOutput(newContent);
          }
        }
      } catch {
        // 文件可能还不存在，忽略错误
      }
    }, 500);
  }

  /**
   * 停止日志文件监控
   */
  private stopLogFileWatcher(): void {
    if (this.logFileWatcher) {
      clearInterval(this.logFileWatcher);
      this.logFileWatcher = null;
    }
    this.lastLogFileSize = 0;
  }

  /**
   * 处理进程输出
   */
  private handleProcessOutput(data: string): void {
    // 移除 ANSI 颜色代码
    const cleanData = this.removeAnsiCodes(data);

    // 按行分割
    const lines = cleanData.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      this.parseAndLogLine(line);
    }
  }

  /**
   * 移除 ANSI 颜色代码
   */
  private removeAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * 内核日志噪音降级：把「预期内的高频/瞬态」内核行降到 debug，保持常规日志干净（debug 仍可见）。严格白名单，
   * 避免误伤真错误：
   *  - 每连接 route/连接 INFO：found process path / failed to search process（容器/WSL 转发连接匹配不到进程，预期）
   *    / inbound·outbound connection；
   *  - naive 每节点启动 INFO：NaiveProxy started（大订阅刷数十行）；
   *  - 预期 ERROR：UDP is not supported by outbound（naive 等 TCP-only 出站收到 UDP/QUIC = 设计内丢弃，非故障）、
   *    probe-* 入站 use of closed network connection（出口 IP 探针连接瞬态关闭）。
   */
  private singboxLogLevel(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string
  ): 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
    // 预期噪音（含 ERROR）→ debug：naive 的 UDP-not-supported、出口IP探针连接瞬态关闭。
    if (
      /router: UDP is not supported by outbound/i.test(message) ||
      /inbound\/http\[probe-(direct|proxy)-in\][\s\S]*use of closed network connection/i.test(
        message
      )
    ) {
      return 'debug';
    }
    // 仅 INFO → debug 的高频每连接/每节点行。
    if (
      level === 'info' &&
      /router: found process path|router: failed to search process|inbound connection (from|to)|outbound connection to|NaiveProxy started/i.test(
        message
      )
    ) {
      return 'debug';
    }
    return level;
  }

  /**
   * 解析并记录日志行
   */
  private parseAndLogLine(line: string): void {
    // Tailscale 交互登录：核打印 `endpoint/tailscale[<tag>]: Waiting for authentication: <url>`，
    // 须在 dedup/低价值过滤之前抓出 → 推 renderer 弹「打开登录页」，保证必达。
    this.detectTailscaleAuthUrl(line);

    // 过滤重复日志
    if (this.isDuplicateLog(line)) {
      return;
    }

    // 过滤低价值日志（连接建立、DNS 查询等频繁日志）
    if (this.isLowValueLog(line)) {
      return;
    }

    // 解析 sing-box 日志格式
    const logInfo = this.parseSingBoxLog(line);

    if (logInfo) {
      // 先翻译消息中的代理标签
      const resolvedMessage = this.resolveTagsToNames(logInfo.message);

      // 再转换为友好的中文提示
      const friendlyMessage = this.translateErrorMessage(resolvedMessage);

      // 空消息不记录（如私有 IP 超时）
      if (friendlyMessage) {
        // 内核预期内的高频/瞬态噪音降到 debug（见 singboxLogLevel）：常规日志干净、debug 仍可见。
        this.logToManager(
          this.singboxLogLevel(logInfo.level, logInfo.message),
          friendlyMessage,
          'sing-box'
        );
      }
    } else {
      // 无法解析的日志，尝试对原始行也进行标签转换
      const resolvedLine = this.resolveTagsToNames(line);
      this.logToManager('info', resolvedLine, 'sing-box');
    }
  }

  /** 已推送过的 Tailscale 登录 URL（核会重复打印同一行，按 url 去重防刷屏）。urls 为一次性 token、量小，不清理。 */
  private tailscaleAuthSeen = new Set<string>();

  /**
   * 抓 Tailscale 交互登录 URL（无 auth_key 时核日志出 `endpoint/tailscale[<tag>]: Waiting for authentication: <url>`）
   * → 推 renderer 弹「打开登录页」。tag 即节点显示名（idToTagMap 用 server.name）。
   */
  private detectTailscaleAuthUrl(line: string): void {
    const hit = parseTailscaleAuthLine(line);
    if (!hit) return;
    const { nodeName, url } = hit;
    if (this.tailscaleAuthSeen.has(url)) return;
    this.tailscaleAuthSeen.add(url);
    // 反查 server.id 提到 emit 之前：登录 URL 事件带 serverId，渲染端 toast id 用 serverId（NIT③：防同
    //   hostname 不同 serverId 的两个 Tailscale 节点登录 toast 互相覆盖 / AUTH_OK dismiss 错条目）。
    //   nodeName=tag=server.name；server 缺失（节点已删/未在配置）时渲染端回落 nodeName 作 id（与今日一致）。
    const server = this.currentConfig?.servers.find(
      (s) => s.protocol?.toLowerCase() === 'tailscale' && s.name === nodeName
    );
    // always-emit：每个未登录 TS 节点（含非出口）都会从主核打印登录 URL。全量上报 EVENT_TAILSCALE_AUTH_URL（带
    // serverId）→ 渲染端 per-node 存 URL 入 store；自动 toast 仅当前出口、非出口看角标按需点开（toast 门控移到渲染端）。
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_TAILSCALE_AUTH_URL, {
      nodeName,
      url,
      serverId: server?.id,
    });
    this.logToManager('info', `Tailscale 节点「${nodeName}」需要登录授权`, 'sing-box');
    // 登录成功不再靠 state 目录轮询（stateExists 误判未认证为已登录是 #132 根因，已剥离）：主核 endpoint
    // 的登录成功由 api STATUS 流（backendState→Running）反映，驱动渲染端登录态点亮 + dismiss 登录 toast。
  }

  // ==== Phase 2：按需瞬态登录核 ====
  /**
   * 在飞的瞬态登录核（serverId → 句柄）。每节点同时最多一个（去重）；app 退出/window 关闭须全清杀，
   * 无孤儿进程。瞬态核无 TUN/无 clash_api/无监听端口，与主核并存无冲突（PoC 实测）。
   */
  private tailscaleLoginCores = new Map<
    string,
    {
      proc: ChildProcess;
      timeoutTimer: NodeJS.Timeout;
      // SIGTERM 后的 SIGKILL 升级 timer：进程拒绝 SIGTERM 时宽限期到点强杀（防泄漏 + 卡 alreadyRunning）。
      // finalize（proc exit/error）会 clearTimeout 它，进程优雅退出则升级被取消。
      killTimer?: NodeJS.Timeout;
      // 瞬态核独立的 1.14 管理 API 客户端（镜像主核 tailscaleApiClient，但各自端口/secret/stop，互不干扰）：
      // 订阅瞬态核 STATUS 流 → backendState=Running 即驱动 loggedIn 验真登录态。finalize 须 stop() 它防泄漏。
      apiClient?: SingBoxApiClient;
      // 登录成功标记：STATUS=Running（已认证、state 落盘）时置 true。供 finalize 区分「成功收尾」与「取消/崩溃/超时」——
      // 成功路径登录态由 setTailscaleLoginState(true)/STATUS 驱动、authUrl 已清，finalize 不再发空 authUrl（否则 clobber）。
      loginCompleted?: boolean;
    }
  >();

  /**
   * 按需登录：拉起登录专用 sing-box（无 inbound/TUN，零提权，log.level:info，带独立 1.14 管理 api service）→
   * ① 读其 stdout 逐行抓登录 URL → shell.openExternal 自动开浏览器 + 系统通知 + 推 AUTH_URL 给渲染端；
   * ② 经独立 SingBoxApiClient 订阅瞬态核 STATUS 流 → backendState=Running（已认证/valid state 秒回 Running，
   *    无需浏览器）→ EVENT_TAILSCALE_STATUS 驱动渲染端 loggedIn=true（与主核同通道，复用 handleTailscaleStatus）
   *    → 杀瞬态核（state 已落盘）。超时（~2min）/取消同样杀核。
   *
   * 根治 #132：登录成功验真改由瞬态核 STATUS（Running）反映、不再靠 stateExists 启发式（误判未认证 state 为
   * 已登录）。故 startTailscaleLogin 入口不再以 stateExists 短路 alreadyLoggedIn——有 valid state 也起瞬态核，
   * 让其 STATUS 秒回 Running 验真（无浏览器）；纯 authKey 仍直接 alreadyLoggedIn（无需交互登录此路径）。
   *
   * 双写防护：若该节点 endpoint 已在运行中的主核里（选中 OR 就绪），不起瞬态核——两个进程写同一
   * state_directory 会冲突；此时节点要么已登录、要么主核已在出 URL（Phase 1）。
   *
   * @returns started=true 已起核（或已在飞）；started=false 时 reason 说明（alreadyLoggedIn / inMainCore）。
   */
  async startTailscaleLogin(
    server: ServerConfig
  ): Promise<{ started: boolean; reason?: 'alreadyLoggedIn' | 'inMainCore' | 'alreadyRunning' }> {
    if (!server || server.protocol?.toLowerCase() !== 'tailscale') {
      throw new Error('startTailscaleLogin: 非 Tailscale 节点');
    }
    // 已登录（authKey 配置即免交互登录）→ 无需登录。注意：不再以 stateExists 短路（#132 根因——未认证的
    // 残留 state 会被误判已登录）；有 state 也起瞬态核，让其 STATUS 秒回 Running 验真（valid → loggedIn=true 无浏览器）。
    if (server.tailscaleSettings?.authKey?.trim()) {
      return { started: false, reason: 'alreadyLoggedIn' };
    }
    // 双写防护：endpoint 已在运行主核里 → 不起瞬态核（避免双写 state_directory 冲突）。
    if (
      tailscaleEndpointInRunningCore(
        server.id,
        this.getStatus().running,
        this.currentConfig,
        tailscaleStateExists(server.id)
      )
    ) {
      return { started: false, reason: 'inMainCore' };
    }
    // 每节点单飞：已有在飞瞬态核则复用（不重复 spawn / 不重复开浏览器）。
    if (this.tailscaleLoginCores.has(server.id)) {
      return { started: false, reason: 'alreadyRunning' };
    }

    if (!require('fs').existsSync(this.singboxPath)) {
      throw new Error(`找不到 sing-box 可执行文件: ${this.singboxPath}`);
    }

    // 瞬态核管理 API：独立空闲端口（排除主核 api 端口 this.tailscaleApiPort 避 bind 冲突）+ 每次随机 secret。
    // 镜像主核 STATUS 订阅给瞬态核：使其 backendState 流可达，登录成功（Running）经 STATUS 验真驱动渲染端。
    const apiPort = await this.resolveTailscaleLoginApiPort();
    const apiSecret = require('crypto').randomBytes(16).toString('hex');
    const loginConfig = buildTailscaleLoginConfig(server, { port: apiPort, secret: apiSecret });
    const cfgPath = path.join(
      getUserDataPath(),
      `ts-login-${require('crypto').randomBytes(6).toString('hex')}.json`
    );
    require('fs').writeFileSync(cfgPath, JSON.stringify(loginConfig));

    // 直接以 app 用户 spawn 非提权进程（绝不走 helper/TUN/提权）。用户态 tailscale endpoint 零提权可起。
    // env 继承主进程（旧 1.12.x ENABLE_DEPRECATED_DESTINATION_OVERRIDE_FIELDS 已随硬切 1.14 + §5 守卫剥离）。
    const spawnEnv = { ...process.env };
    const proc = spawn(this.singboxPath, ['run', '-c', cfgPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
      windowsHide: true,
    });

    const handle: {
      proc: ChildProcess;
      timeoutTimer: NodeJS.Timeout;
      killTimer?: NodeJS.Timeout;
      apiClient?: SingBoxApiClient;
      loginCompleted?: boolean;
    } = { proc, timeoutTimer: undefined as unknown as NodeJS.Timeout };
    // 超时杀核（三平台共用，可重置）：未打开 URL 前等 2min（用户没点 → 放弃）；用户**打开登录 URL 后**
    // 延长到 5min——浏览器 Login successful 后，瞬态核 tsnet 还要从控制面同步到 backendState=Running
    // （登录态验真依据，下方 STATUS 流），这段必须算进窗口，否则登录成功却被提前杀核 → STATUS 回不来 →
    // app 误显「未登录」（Windows 真机实证：urlOpened 后仅 112s 即被掐断）。
    const armLoginTimeout = (ms: number): void => {
      clearTimeout(handle.timeoutTimer);
      handle.timeoutTimer = setTimeout(() => {
        this.logToManager(
          'info',
          `Tailscale 节点「${server.name}」登录超时，已停止登录进程`,
          'sing-box'
        );
        // 超时=登录未完成：杀核 → proc 'exit' → finalize 统一发空 authUrl 清渲染端缓存（退出「登录中」回「需登录」）。
        // 不在此处单独发：空 authUrl 已下沉 finalize，覆盖取消/崩溃/超时全路径（#174 review MED-5），避免重复/分叉。
        this.killTailscaleLogin(server.id);
      }, ms);
    };
    armLoginTimeout(120000); // 初始：等用户点击登录 URL 的 2min
    this.tailscaleLoginCores.set(server.id, handle);

    // 幂等收尾：清 timer + 停瞬态 api client（停订阅 + 关连接，防泄漏）+ 删 Map + 删临时 config。error 与 exit 两路径都调它。
    //  - spawn 失败（ENOENT/EACCES…）只 emit 'error' 不 emit 'exit'：收尾只挂 exit 会致 cfg 文件 + Map 项 + apiClient 泄漏
    //    （Map 残留 → 该节点再点登录恒返回 alreadyRunning 卡死）。故 error 路径也须 finalize。
    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      // 统一收尾点：所有退出路径（用户取消 cancelTailscaleLogin、核自行崩溃、登录超时、spawn 失败）都经此。
      // 登录未成功 → 发空 authUrl 清渲染端缓存，卡片/表单退出「登录中」回「需登录」，杜绝取消/崩溃后 UI 卡死
      // （#174 review MED-5：原空 authUrl 只挂在超时回调，取消/崩溃路径不清 → tailscaleAuthUrls[id] 永留 → 卡死）。
      // 成功路径（loginCompleted）的 authUrl 由 setTailscaleLoginState(true)/STATUS 清，此处不重复发（否则 clobber）。
      if (!handle.loginCompleted) {
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_TAILSCALE_AUTH_URL, {
          serverId: server.id,
          url: '',
        });
      }
      clearTimeout(handle.timeoutTimer); // 清最新的登录超时（urlOpened 后已被 armLoginTimeout 重置过）
      // 进程已退出（优雅 SIGTERM 或自行崩溃）→ 取消挂起的 SIGKILL 升级，防 timer 泄漏。
      clearTimeout(handle.killTimer);
      // 瞬态 api client 停订阅 + 关 gRPC 连接（与主核 tailscaleApiClient 独立、各自 stop，互不干扰）。stop() 幂等。
      handle.apiClient?.stop();
      handle.apiClient = undefined;
      this.tailscaleLoginCores.delete(server.id);
      try {
        require('fs').unlinkSync(cfgPath);
      } catch {
        /* 已删/无权限：忽略 */
      }
    };

    // 逐行读 stdout/stderr 抓登录 URL（瞬态核自身 stdout 直接打印 Waiting for authentication 行，PoC 实测）。
    let urlOpened = false;
    const onData = (data: Buffer): void => {
      const text = this.removeAnsiCodes(data.toString());
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const hit = parseTailscaleAuthLine(line);
        if (!hit || urlOpened) continue;
        urlOpened = true;
        this.handleTailscaleLoginUrl(server, hit.url);
        // 用户已打开登录 URL → 从「等点击 2min」延长到「等登录完成 + STATUS 同步」窗口。登录成功
        // (STATUS=Running) 由 handleTransientTailscaleStatus 立即杀核收尾、不等满窗口，故上限放宽零成本——
        // 只兜「开了浏览器又一直不登录」。
        armLoginTimeout(300000);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    // spawn 失败：只 emit 'error'（无后续 'exit'）→ 直接 finalize 兜底，否则 cfg + Map 泄漏。
    proc.on('error', (e) => {
      this.logToManager('error', `Tailscale 登录进程启动失败: ${e.message}`, 'sing-box');
      finalize();
    });
    // 进程退出（正常被杀 / 自行崩溃 / 核拒绝 config）：finalize 清 timer/cfg/Map/apiClient（幂等）。
    proc.on('exit', finalize);

    // 瞬态核 STATUS 订阅（镜像主核 startInternal:752 那段，但独立 client/端口/secret/stop）：连瞬态核的管理
    // api service（127.0.0.1:apiPort）订阅 SubscribeTailscaleStatus → handleTailscaleStatus 把 endpointTag
    // (=server.name)→serverId 映射、emit EVENT_TAILSCALE_STATUS（与主核同通道，复用 handleTailscaleStatus:loggedIn）。
    // backendState=Running（已登录；valid 既有 state 会秒回 Running 无需浏览器）→ STATUS 已驱动 loggedIn=true，
    // 此处额外杀瞬态核（state 已落盘，无需常驻；NeedsLogin 则保活等用户点 URL 授权）。secret 经 Bearer 注入。
    handle.apiClient = new SingBoxApiClient(
      { host: '127.0.0.1', port: apiPort },
      apiSecret,
      (eps) => this.handleTransientTailscaleStatus(server, eps)
    );
    handle.apiClient.start();

    this.logToManager(
      'info',
      `Tailscale 节点「${server.name}」开始登录（已启动登录进程）`,
      'sing-box'
    );

    // 登录成功验真由瞬态核 STATUS 流（backendState=Running）反映、驱动渲染端登录态（取代 #132 stateExists 启发式）。
    // 瞬态核的收尾由 timeoutTimer(120s) + proc 'exit'/'error'→finalize + STATUS=Running 主动杀核 + 退出时
    // killAllTailscaleLoginCores 兜底（真机阶段定瞬态核去留）。
    return { started: true };
  }

  /**
   * 瞬态登录核 STATUS 回调：endpointTag(=server.name)→serverId 用闭包绑定的 server 直接定位（不依赖 currentConfig
   * ——点列表登录时主核可能未运行/不含该节点），经 emitTailscaleStatus 推 EVENT_TAILSCALE_STATUS 与主核同通道
   * 驱动渲染端 loggedIn（纯 STATUS，不碰 stateExists）。瞬态核只含本节点 endpoint，按 tag=server.name 过滤。
   *
   * 额外——backendState=Running（已认证、state 已落盘）→ 主动杀瞬态核（无需常驻；NeedsLogin/Starting 则保活
   * 等用户在浏览器完成授权）。
   */
  private handleTransientTailscaleStatus(
    server: ServerConfig,
    endpoints: TailscaleEndpointStatus[]
  ): void {
    const ep = endpoints.find((e) => e.endpointTag === server.name);
    if (!ep) return;
    // includeAuthURL=false：瞬态核登录 URL 由 stdout AUTH_URL 单点承载（自动开浏览器 + toast），STATUS 不重复带 URL。
    this.emitTailscaleStatus(server.id, ep, false);
    // 本节点已认证（Running）→ state 已落盘，杀瞬态核（finalize 会停 apiClient + 清理）。
    // 在 STATUS 流回调栈内调 killTailscaleLogin 安全：它只发 SIGTERM（异步），apiClient.stop() 由 proc 'exit'
    // 的 finalize 在后续 tick 触发，不在本回调栈内同步 cancel 正派发的 stream；即便同步，SubscribeTailscaleStatus
    // 'data' 的 `if(this.stopped)return` 守卫也挡住重入。
    if (ep.backendState === 'Running') {
      // 登录已成功（state 落盘）→ 标记 loginCompleted，让随后的 finalize 不再发空 authUrl（成功态的 authUrl 清理
      // 由 setTailscaleLoginState(true)/STATUS 承担；finalize 的空 authUrl 仅用于取消/崩溃/超时收尾，见 #174 review MED-5）。
      const handle = this.tailscaleLoginCores.get(server.id);
      if (handle) handle.loginCompleted = true;
      this.killTailscaleLogin(server.id);
    }
  }

  /** 抓到瞬态登录核的 URL：自动开浏览器 + 系统通知（点击再开）+ 推渲染端可关闭 toast（Phase 1 提示条复用）。 */
  private handleTailscaleLoginUrl(server: ServerConfig, url: string): void {
    // 安全：URL 取自内核日志正则捕获，openExternal 前限定 http(s)，杜绝 file:///javascript: 等危险 scheme。
    const safeUrl = safeHttpUrl(url);
    if (!safeUrl) {
      this.logToManager('warn', `Tailscale 登录 URL 非法已忽略: ${url}`, 'sing-box');
      return;
    }
    // ① 自动开浏览器
    void shell.openExternal(safeUrl).catch(() => {});
    // ② 系统通知（无窗口依赖，托盘态/窗口关闭也送达）；点击再开一次浏览器。经 notifyUser 统一出口（受总开关管控）。
    //    标题含 TS 节点名是功能必需（指明哪个节点要登录）；TS 是用户自建组网身份，非代理节点域名/IP。文案走 main i18n（5 语）。
    notifyUser(
      `Tailscale: ${server.name}`,
      mt('tailscaleAuthBody'),
      () => void shell.openExternal(safeUrl).catch(() => {})
    );
    // ③ 推渲染端（提示条记录用，降级为可关闭普通 toast，非 Infinity——浏览器已自动打开）。
    //    带 serverId（NIT③）：与 Phase1 + AUTH_OK 用同一 serverId 作 toast id，dismiss 精确命中本节点。
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_TAILSCALE_AUTH_URL, {
      nodeName: server.name,
      url: safeUrl,
      transient: true,
      serverId: server.id,
    });
    this.logToManager('info', `Tailscale 节点「${server.name}」已打开浏览器登录页`, 'sing-box');
  }

  /** 取消某节点在飞的瞬态登录核（用户手动取消，IPC 入口）。无在飞核为 no-op。 */
  cancelTailscaleLogin(serverId: string): void {
    if (this.tailscaleLoginCores.has(serverId)) {
      this.logToManager('info', `已取消 Tailscale 节点登录`, 'sing-box');
    }
    this.killTailscaleLogin(serverId);
  }

  /** sing-box 管理 API（services[{type:api}] + 状态订阅）是否可用：要求核 ≥1.14。§5 守卫已保证 start 路径恒满足；
   *  保留判定供 preflight/snapshot 等以 <1.14 fixture 直调 generateSingBoxConfig 的路径（不注入 services）。
   *  收敛「最低版本」字面量为单一谓词（注入 services + 起 api-client 共用），改最低版本只动此处。 */
  private hasManagementApi(): boolean {
    return coreVersionAtLeast(this.coreVersion, 1, 14);
  }

  /**
   * sing-box 1.14 管理 API 状态流回调（主核）：endpointTag(=server.name)→serverId（经 currentConfig 反查），
   * 推 EVENT_TAILSCALE_STATUS 驱动渲染端登录态。取代 1.13 stateExists/stdout 启发式。
   */
  private handleTailscaleStatus(endpoints: TailscaleEndpointStatus[]): void {
    const selectedId = this.currentConfig?.selectedServerId;
    let selectedRunning = false;
    for (const ep of endpoints) {
      const server = this.currentConfig?.servers.find(
        (s) => s.protocol?.toLowerCase() === 'tailscale' && s.name === ep.endpointTag
      );
      if (!server) continue;
      this.emitTailscaleStatus(server.id, ep);
      // item 1 事件驱动出口 re-probe：选中节点是账号制 TS 且其隧道 STATUS 翻 Running（DERP/peer 握手完成、
      // 路由已下发=隧道就绪）→ 立即触发一次代理出口 re-probe（不等满退避）。仅选中节点、仅 Running 上升沿
      // （lastTsSelectedRunningId 去重，STATUS 持续推帧不会每帧触发）。Starting/NeedsLogin 不算就绪、不触发。
      if (
        server.id === selectedId &&
        isAccountBasedProtocol(server.protocol) &&
        ep.backendState === 'Running'
      ) {
        selectedRunning = true;
        if (this.lastTsSelectedRunningId !== server.id) {
          this.lastTsSelectedRunningId = server.id;
          this.emit('tailscale-selected-running');
        }
      }
    }
    // 选中 TS 节点本帧不在 Running（掉线/停止/切到别的节点）→ 清去重标记，使下次重新 Running 能再发（覆盖重连）。
    if (!selectedRunning && this.lastTsSelectedRunningId !== null) {
      this.lastTsSelectedRunningId = null;
    }
  }

  /**
   * 单 endpoint STATUS → EVENT_TAILSCALE_STATUS（serverId→渲染端）。主核（handleTailscaleStatus，name 反查）
   * 与瞬态登录核（handleTransientTailscaleStatus，serverId 闭包绑定）共用，loggedIn 计算单一真值（防漂移）。
   *
   * loggedIn = 已认证(Running||Starting) 且 key 未过期。key 过期(self.expired)即便 backendState 仍短暂 Running，
   * 也判未登录 → 渲染端「需登录」角标亮、引导重新认证（取代旧 expired→回落需登录启发式）。
   *
   * includeAuthURL：是否在事件里带 authURL（驱动渲染端「需登录」toast）。主核路径=true（STATUS 是唯一 URL 来源）；
   * 瞬态核路径=false——瞬态核的登录 URL 已由 stdout AUTH_URL 解析（handleTailscaleLoginUrl 自动开浏览器 + 推
   * EVENT_TAILSCALE_AUTH_URL toast）单点承载，STATUS 不再重复带 URL（択一防同节点双发登录 toast 漂移）。
   */
  private emitTailscaleStatus(
    serverId: string,
    ep: TailscaleEndpointStatus,
    includeAuthURL = true
  ): void {
    const loggedIn =
      (ep.backendState === 'Running' || ep.backendState === 'Starting') &&
      ep.self?.expired !== true;
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_TAILSCALE_STATUS, {
      serverId,
      backendState: ep.backendState,
      loggedIn,
      authURL: includeAuthURL ? ep.authURL || undefined : undefined,
      tailscaleIPs: ep.self?.tailscaleIPs || [],
      expired: ep.self?.expired === true,
    });
  }

  /**
   * 退出登录：节点在运行主核里 → 调 1.14 管理 API TailscaleLogout(endpointTag) 让内核即时下线该 endpoint；
   * 并清该节点 state 目录（瞬态核写的持久会话兜底，下次需重新交互登录）。保留节点配置/authKey。
   * 先取消该节点在飞的瞬态登录核（若有），避免它在清目录后又写回 state。
   * 若该 endpoint 正在运行中的主核里，回传 runningNeedsRestart 供 UI 提示（api logout 已尽力即时下线，
   * 但 force-route 反应式未做、彻底生效仍可能需重启 → 行为不变，真机验证 caveat）。
   */
  async tailscaleLogout(serverId: string): Promise<{ runningNeedsRestart: boolean }> {
    this.cancelTailscaleLogin(serverId);
    const inRunningCore = tailscaleEndpointInRunningCore(
      serverId,
      this.getStatus().running,
      this.currentConfig,
      tailscaleStateExists(serverId)
    );
    // 节点在运行主核里 → 经 api 让内核原生登出该 endpoint（endpointTag=server.name）。api 不可达/未起则吞错，
    // 仍走下方清 state 目录兜底（瞬态核登录写的会话）。
    if (inRunningCore && this.tailscaleApiClient) {
      const server = this.currentConfig?.servers.find((s) => s.id === serverId);
      if (server) {
        await this.tailscaleApiClient.logout(server.name).catch((e) => {
          this.logToManager(
            'warn',
            `Tailscale api 登出失败（已回退清 state 目录）: ${e?.message ?? e}`,
            'sing-box'
          );
        });
      }
    }
    await require('fs')
      .promises.rm(tailscaleStateDir(serverId), { recursive: true, force: true })
      .catch(() => {});
    this.logToManager('info', `Tailscale 节点已退出登录`, 'sing-box');
    return { runningNeedsRestart: inRunningCore };
  }

  /** 杀某节点瞬态登录核（超时/取消/出错统一收口）：kill 进程 + 清 timer/Map。幂等。 */
  private killTailscaleLogin(serverId: string): void {
    const handle = this.tailscaleLoginCores.get(serverId);
    if (!handle) return;
    clearTimeout(handle.timeoutTimer);
    // 已挂起一次升级（重复调用幂等）→ 不重复发信号/排第二个 timer。
    if (handle.killTimer) return;
    try {
      // SIGTERM→3s 宽限→SIGKILL 升级：核拒绝 SIGTERM（卡退出）时强杀，否则 proc 永不 exit → finalize 不触发
      // → cfg/Map 泄漏 + 该节点恒 alreadyRunning 卡死。进程优雅退出会触发 exit→finalize→clearTimeout(killTimer) 取消升级。
      handle.killTimer = escalateProcessKill({
        sendSignal: (sig) => {
          handle.proc.kill(sig);
        },
        schedule: (fn, ms) => setTimeout(fn, ms),
        graceMs: 3000,
      });
    } catch {
      /* 已退出：忽略 */
    }
    // Map 项 + 临时 config 由 finalize 删（挂在 proc 'exit'/'error'）；此处不删，避免与 finalize 竞态漏清 cfg。
  }

  /** app 退出/窗口关闭：杀掉全部残留瞬态登录核（无孤儿进程）。由 stop/teardownForQuit 调用。 */
  private killAllTailscaleLoginCores(): void {
    for (const serverId of Array.from(this.tailscaleLoginCores.keys())) {
      this.killTailscaleLogin(serverId);
    }
  }

  /**
   * 检查是否为低价值日志（应该被过滤）
   * 保留：路由决策、错误、启动/停止等重要日志
   * 过滤：频繁的连接关闭、握手细节等日志
   */
  private isLowValueLog(line: string): boolean {
    const lowerLine = line.toLowerCase();

    // 优先过滤的噪音日志（即使包含其他关键词也要过滤）
    const noisePatterns = [
      'connection upload closed',
      'connection download closed',
      'forcibly closed',
      'connection closed',
      'connection established',
      'tls handshake',
      'handshake completed',
    ];

    for (const pattern of noisePatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    // 高价值日志模式 - 这些日志应该保留
    const keepPatterns = [
      'started', // 启动完成
      'stopped', // 停止
      'sing-box started', // sing-box 启动
      'error', // 错误
      'fatal', // 致命错误
      'warn', // 警告
      'failed', // 失败
      'updated default interface', // 网络接口变化
      // 路由决策相关 - 关键日志
      'match rule', // 匹配规则
      'final rule', // 最终规则
      'rule-set', // 规则集匹配
      'outbound/proxy', // 代理出站 - 用户关心的
    ];

    // 检查是否包含高价值模式
    for (const pattern of keepPatterns) {
      if (lowerLine.includes(pattern)) {
        return false; // 不过滤，保留这条日志
      }
    }

    // 检查是否为内网IP的直连连接（这些太频繁，需要过滤）
    if (lowerLine.includes('outbound/direct')) {
      // 检查是否连接到私有IP地址
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(line)) {
          return true; // 过滤内网直连
        }
      }
      // 公网直连保留（如 CDN、国内网站等）
      return false;
    }

    // 过滤的低价值日志模式
    const filterPatterns = [
      'dns query', // DNS 查询
      'dns response', // DNS 响应
      'dns: exchanged', // DNS 交换
      'dns: cached', // DNS 缓存
      'resolved', // DNS 解析完成
      'udp packet', // UDP 包
      'inbound/tun[tun-in]', // TUN 入站细节
      'inbound/mixed[mixed-in]', // mixed(HTTP+SOCKS) 入站细节（mixed-only）
    ];

    for (const pattern of filterPatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    return false; // 默认保留
  }

  /** 最近处理过的日志消息，用于去重，最多缓存 10 条 */
  private recentLogHistory: string[] = [];

  /**
   * 检查是否为重复日志
   */
  private isDuplicateLog(message: string): boolean {
    const now = Date.now();
    const trimmedMessage = message.trim();

    // 过滤掉日志中的时间戳部分进行对比（例如：+0800 2026-04-05 12:05:01 ）
    // 这样即便 stdout 和 logFile 的时间戳有微秒级差异，也能正确去重
    const stripTimestamp = (msg: string) =>
      msg.replace(/[+-]\d{4}\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\s/, '');
    const cleanMessage = stripTimestamp(trimmedMessage);

    // 1. 如果新消息与缓冲区中的任意消息内容（忽略时间戳）相同，则认为是重复
    const normalizedHistory = this.recentLogHistory.map((m) => stripTimestamp(m));
    if (normalizedHistory.includes(cleanMessage) && now - this.lastLogTime < 1000) {
      return true;
    }

    // 2. 特殊情况：如果消息完全相同且在 1 秒内（由于并发到达）
    if (trimmedMessage === this.lastLogMessage && now - this.lastLogTime < 1000) {
      this.lastLogCount++;
      if (this.lastLogCount > 1) return true;
    }

    // 新消息，入队并重置
    this.recentLogHistory.push(trimmedMessage);
    if (this.recentLogHistory.length > 10) {
      this.recentLogHistory.shift();
    }

    this.lastLogMessage = trimmedMessage;
    this.lastLogCount = 1;
    this.lastLogTime = now;

    return false;
  }

  /**
   * 解析 sing-box 日志
   */
  private parseSingBoxLog(
    line: string
  ): { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string } | null {
    // sing-box 日志格式（timestamp:true 恒带时间戳，含可选时区前缀）：
    //   +0800 2026-04-05 12:00:00 INFO message
    //   2026-04-05 12:00:00 INFO message
    //   2026-04-05 12:00:00 [INFO] message
    // 关键修复：级别 token 锚定到「行首时间戳紧随其后」的位置，而非全行任意位置匹配 —— 否则 message 正文里
    // 出现的 error/fatal/warn 等词会把整行误标成该级别（如 "INFO downloaded geosite, 0 fatal" 被误判 FATAL）。
    const m = line.match(
      /^(?:[+-]\d{4}\s+)?\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\[?(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?\s/i
    );
    if (!m) {
      return null;
    }

    let level = m[1].toUpperCase();
    if (level === 'WARNING') {
      level = 'WARN';
    }

    // message = 时间戳 + 级别之后的剩余内容（m[0] 含到级别后的那个空白）
    const message = line.slice(m[0].length).trim();

    return {
      level: level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      message,
    };
  }

  /**
   * 将日志中的 proxy 标签（UUID 或 "proxy"）转换为人类可读的服务器名称
   */
  private resolveTagsToNames(message: string): string {
    if (!this.currentConfig || !this.currentConfig.servers) {
      return message;
    }

    let resolvedMessage = message;

    // 1. 处理这种格式：proxy-2cef4913-84f6-41f9-a251-d1f49767cef6
    const uuidPattern = /proxy-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
    resolvedMessage = resolvedMessage.replace(uuidPattern, (match, id) => {
      const server = this.currentConfig?.servers.find((s) => s.id === id);
      return server ? server.name : match;
    });

    // 2. 处理单独的 [proxy] 或 outbound/proxy 标识
    const selectedServer = this.currentConfig.servers.find(
      (s) => s.id === this.currentConfig?.selectedServerId
    );

    if (selectedServer) {
      // 替换方括号中的 [proxy]
      resolvedMessage = resolvedMessage.replace(/\[proxy\]/g, `[${selectedServer.name}]`);

      // 替换 outbound/proxy
      resolvedMessage = resolvedMessage.replace(
        /outbound\/proxy/g,
        `outbound/${selectedServer.name}`
      );

      // 替换 outbound: proxy
      resolvedMessage = resolvedMessage.replace(
        /outbound: proxy/g,
        `outbound: ${selectedServer.name}`
      );
    }

    return resolvedMessage;
  }

  /**
   * 翻译错误消息为友好的中文提示
   * 返回格式：友好提示 + 原始错误（如果有翻译）
   */
  /** 当前配置的全部节点域名集（address + serverName，去 IP 字面量，小写）。错误归因判定被解析域名是否为节点域名。 */
  private collectNodeDomains(): Set<string> {
    const set = new Set<string>();
    for (const s of this.currentConfig?.servers || []) {
      for (const d of [s.address, s.tlsSettings?.serverName]) {
        if (d && !isIpv4Host(d) && !isIpv6Host(d)) set.add(d.toLowerCase());
      }
    }
    return set;
  }

  /**
   * #57 DNS 解析失败归因。sing-box 节点域名 dial 解析失败的典型日志形如：
   *   `lookup xxx.trycloudflare.com: SERVFAIL` / `... no such host` / `... i/o timeout`。
   * 命中 `lookup ` + (servfail|no such host|i/o timeout) 视为 DNS lookup 失败；按被解析域名是否属节点域名集
   * 区分 'node'（引导用户切换节点域名解析器档位自救）/ 'generic'（普通 DNS 失败）。未命中返回 null。
   * 注意：'i/o timeout' 在 lookup 语境下属 DNS 失败，故本判定须先于通用 timeout 分支，避免误归类为连接超时。
   */
  private matchDnsLookupFailure(lowerMessage: string): 'node' | 'generic' | null {
    if (!lowerMessage.includes('lookup ')) return null;
    if (
      !(
        lowerMessage.includes('servfail') ||
        lowerMessage.includes('no such host') ||
        lowerMessage.includes('i/o timeout')
      )
    ) {
      return null;
    }
    // 提取 `lookup <domain>` 的域名（到首个空白/冒号止），与节点域名集比对。
    const m = lowerMessage.match(/lookup\s+([^\s:]+)/);
    const domain = m ? m[1] : '';
    if (domain && this.collectNodeDomains().has(domain)) return 'node';
    return 'generic';
  }

  private translateErrorMessage(message: string): string {
    // （删除原 console.error(message)：该函数对每条解析后的 sing-box 日志行都会调用，原样 dump 到主进程
    //   控制台 = 与 logManager 正常记录重复的纯噪音，且无视 logLevel 过滤。诊断改看 app.log / 渲染端日志面板。）
    const lowerMessage = message.toLowerCase();

    // 常见错误模式匹配
    if (lowerMessage.includes('report handshake success: connection refused')) {
      return `目标连接被拒绝：代理节点已连接，但目标服务器拒绝了连接（可能是节点限制或失效） [${message}]`;
    }

    if (
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('connect: connection refused')
    ) {
      return `连接被拒绝：无法连接到代理服务器，请检查服务器地址和端口是否正确 [${message}]`;
    }

    // #57：DNS lookup 失败须先于通用 timeout 分支（`lookup x: i/o timeout` 属 DNS 失败而非连接超时）。
    const dnsLookup = this.matchDnsLookupFailure(lowerMessage);
    if (dnsLookup === 'node') {
      return `节点域名解析失败：无法解析代理节点域名（可能是当前 DNS 对该域名返回 SERVFAIL）。可在 设置→网络 切换节点域名解析器为 DNSPod 或系统 DNS 后重试 [${message}]`;
    }
    if (dnsLookup === 'generic') {
      return `DNS 解析失败：无法解析服务器域名，请检查 DNS 设置 [${message}]`;
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      // 尝试提取目标地址
      const match = message.match(/connection.*?to\s+([^\s:]+(?::\d+)?)/i);
      const target = match ? match[1] : '';
      // 私有 IP 超时不显示（内网服务走代理必然超时）
      if (target && /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(target)) {
        return ''; // 返回空字符串，后续会被过滤
      }
      return target ? `连接超时: ${target}` : '连接超时：服务器响应超时';
    }

    if (lowerMessage.includes('dns') && lowerMessage.includes('fail')) {
      return `DNS 解析失败：无法解析服务器域名，请检查 DNS 设置 [${message}]`;
    }

    if (lowerMessage.includes('certificate') || lowerMessage.includes('x509')) {
      // 仅在真实证书错误时标注（要求 certificate/x509 关键字）：translateErrorMessage 对每条 sing-box 日志行都调用，
      // 原先裸 tls/ssl 匹配会把正常的 `router: sniffed protocol: tls, domain: X` 调试行误标为「证书错误」（满屏误报）。
      return `TLS 证书错误：服务器证书验证失败 [${message}]`;
    }

    if (lowerMessage.includes('authentication failed') || lowerMessage.includes('auth fail')) {
      return `认证失败：用户名或密码错误，请检查服务器配置 [${message}]`;
    }

    if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied')) {
      return `权限不足：需要管理员权限才能启动 TUN 模式 [${message}]`;
    }

    if (
      lowerMessage.includes('address already in use') ||
      lowerMessage.includes('bind: address already in use')
    ) {
      return `端口已被占用：请更换其他端口或关闭占用端口的程序 [${message}]`;
    }

    if (lowerMessage.includes('invalid config') || lowerMessage.includes('config error')) {
      return `配置错误：sing-box 配置文件格式不正确 [${message}]`;
    }

    // 如果没有匹配到特定错误，返回原始消息
    return message;
  }

  /**
   * 识别 libcronet 缺失/损坏致的内核 FATAL：缺库时 sing-box 在构建 naive outbound 阶段报
   * `cronet: library not found`（Windows 还提示 `Place libcronet.dll in the executable directory or PATH`）。
   * 命中即触发 T2 冷路径自愈闭环（strong 重拷 + 重启一次）。
   */
  private isCronetLibError(message: string): boolean {
    const m = message.toLowerCase();
    // 收紧：去掉裸 `not found`（否则用户自建名含 "cronet" 的 selector 报 `dependency[cronet] not found`
    // 会被误判为缺库 → 虚触发一次 strong 重拷+重启）。仅匹配 libcronet 真实缺库消息。
    return (
      m.includes('cronet') &&
      (m.includes('library not found') ||
        m.includes('libcronet') ||
        m.includes('executable directory'))
    );
  }

  /** T2 诊断：本会话 libcronet 自愈触发/失败计数（纳入诊断报告供「库被反复删（疑杀软）」定位）。 */
  getCronetHealStats(): { triggered: number; failed: number } {
    return { triggered: this.cronetHealTriggeredCount, failed: this.cronetHealFailedCount };
  }

  /**
   * issue #176 诊断：本次（最近一次）启动经几次就绪重试才成功。>0 = 起核慢（多因 Windows 重启争用下 wintun
   * 适配器未及时释放），与「核崩溃自动重启」（restartCount）是不同轴——纳入诊断报告区分「核崩」vs「争用慢起」。
   */
  getLastStartReadyRetries(): number {
    return this.lastStartReadyRetries;
  }

  /**
   * 与 translateErrorMessage 同序镜像分类，仅并行产出结构化错误码；translateErrorMessage 的输出
   * （含日志路径）保持逐字不变，零回归风险。新增 includes 分支顺序必须与上面一致。
   */
  private classifyCoreError(message: string): ProxyErrorCode {
    const lowerMessage = message.toLowerCase();
    // libcronet 缺库 FATAL 优先识别（结构化错误码，供诊断/UI 分类）：与 translate 侧文案无冲突（translate 无 cronet 分支 → 原样返回）。
    if (this.isCronetLibError(lowerMessage)) return ProxyErrorCode.CRONET_LIB_MISSING;
    if (lowerMessage.includes('report handshake success: connection refused'))
      return ProxyErrorCode.DEST_CONNECTION_REFUSED;
    if (
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('connect: connection refused')
    )
      return ProxyErrorCode.CONNECTION_REFUSED;
    // #57：与 translateErrorMessage 同序镜像——DNS lookup 失败先于通用 timeout 分支（防 `lookup x: i/o timeout` 误归类）。
    // node/generic 同复用既有 DNS_RESOLVE_FAILED 错误码（不加枚举，零 UI 联动），文案区分在 translate 侧。
    if (this.matchDnsLookupFailure(lowerMessage) !== null) return ProxyErrorCode.DNS_RESOLVE_FAILED;
    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out'))
      return ProxyErrorCode.CONNECTION_TIMEOUT;
    if (lowerMessage.includes('dns') && lowerMessage.includes('fail'))
      return ProxyErrorCode.DNS_RESOLVE_FAILED;
    if (lowerMessage.includes('certificate') || lowerMessage.includes('x509'))
      return ProxyErrorCode.TLS_CERT_ERROR;
    if (lowerMessage.includes('authentication failed') || lowerMessage.includes('auth fail'))
      return ProxyErrorCode.AUTH_FAILED;
    if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied'))
      return ProxyErrorCode.PERMISSION_DENIED;
    if (
      lowerMessage.includes('address already in use') ||
      lowerMessage.includes('bind: address already in use')
    )
      return ProxyErrorCode.PORT_IN_USE;
    if (lowerMessage.includes('invalid config') || lowerMessage.includes('config error'))
      return ProxyErrorCode.CONFIG_INVALID;
    return ProxyErrorCode.UNKNOWN;
  }

  /** 退出码 → 错误码（镜像 parseExitError 的 switch）。 */
  private classifyExitCode(code: number): ProxyErrorCode {
    switch (code) {
      case 1:
        return ProxyErrorCode.STARTUP_FAILED;
      case 2:
        return ProxyErrorCode.CONFIG_INVALID;
      case 126:
        return ProxyErrorCode.BINARY_NOT_EXECUTABLE;
      case 127:
        return ProxyErrorCode.BINARY_NOT_FOUND;
      case 137:
        return ProxyErrorCode.PROCESS_KILLED;
      default:
        return ProxyErrorCode.PROCESS_EXITED;
    }
  }

  /** handleProcessExit 用：优先 lastErrorOutput 分类，无果再按退出码（与 parseExitError 取值同序）。 */
  private classifyExitError(code: number): ProxyErrorCode {
    if (this.lastErrorOutput) {
      const c = this.classifyCoreError(this.lastErrorOutput);
      if (c !== ProxyErrorCode.UNKNOWN) return c;
    }
    return this.classifyExitCode(code);
  }

  /**
   * 记录日志到 LogManager
   */
  private logToManager(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    source: string = 'ProxyManager'
  ): void {
    if (this.logManager) {
      // T6：编排维度默认 'ProxyManager'；sing-box 内核 stdout 经 parseAndLogLine 传 'sing-box' 区分。
      this.logManager.addLog(level, message, source);
    }
  }

  /**
   * 处理进程错误
   */
  private handleProcessError(error: Error): void {
    const errorMessage = this.translateErrorMessage(error.message);

    // 触发错误事件
    this.emit('error', {
      message: errorMessage,
      error: error.message,
    });

    // 发送到前端
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: errorMessage,
      errorCode: this.classifyCoreError(error.message),
      error: error.message,
    });
  }

  /**
   * 处理进程退出
   */
  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // 解析退出原因
    const exitReason = this.parseExitReason(code, signal);

    this.logToManager('info', `sing-box process exited: ${exitReason}`);

    // 如果是异常退出（非正常停止）
    if (code !== null && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      const errorMessage = this.parseExitError(code);

      this.logToManager('error', `sing-box异常退出: ${errorMessage}`);

      // 崩溃恢复主导：原地重启同节点（与健康检查复用同一内部机制，单一计数器 + 上限 + 冷却）。
      // 仅当 shouldAutoRestart 放行（未被核心更新校验窗口抑制、未达上限）时重启；否则下沉到 error 上报，
      // 由主进程做核心回滚 / 放弃恢复。崩溃不触发换节点（换节点交给心跳连通性检测）。
      if (this.shouldAutoRestart()) {
        // 若有在途自动重启腿但它已被更新的 start 接管(supersede=世代已变)、注定让位 → 标记崩溃，
        // 让那条腿醒来补发一次重启；否则本崩溃信号会被 attemptAutoRestart 入口的 isRestarting dedup 吞掉、
        // 接管会话死后无人恢复 → limbo/死端口断网（M-2′-G1）。下面的 attemptAutoRestart 在 supersede 时会被
        // dedup 早退（无害），真正的恢复由让位腿消费 crashWhileSuperseded 完成。
        if (this.isRestarting && this.lifecycleGeneration !== this.restartingGen) {
          this.crashWhileSuperseded = true;
        }
        this.singboxProcess = null;
        this.pid = null;
        this.singboxPid = null;
        this.stopLogFileWatcher();
        void this.attemptAutoRestart();
        return; // 重启接管：保留健康检查与重启计数，不 emit error、不 cleanup
      }

      // 触发错误事件（重启被抑制或已达上限）
      this.emit('error', {
        message: errorMessage,
        code,
        signal,
      });

      // 发送到前端
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
        message: errorMessage,
        errorCode: this.classifyExitError(code),
        code,
        signal,
      });
    } else {
      // 正常退出 / 被信号终止（SIGTERM/SIGKILL）：触发停止事件
      this.emit('stopped');
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    }

    // 终态收口（自动重启分支已在上方 return，到此即进程不再拉起）：清掉曾指向我们的系统代理。
    // 覆盖「外部 SIGKILL / OOM / 达上限异常退出」——主动停止已由 IPC/托盘前置 disable（marker 门控下此处幂等 no-op）。
    void this.ensureSystemProxyCleared();
    this.cleanup();
  }

  /**
   * 解析退出原因
   */
  private parseExitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) {
      return `信号 ${signal}`;
    }
    if (code !== null) {
      return `退出码 ${code}`;
    }
    return '未知原因';
  }

  /**
   * 解析退出错误
   */
  private parseExitError(code: number): string {
    // 尝试从最后的错误输出中提取错误信息
    if (this.lastErrorOutput) {
      const friendlyMessage = this.translateErrorMessage(this.lastErrorOutput);
      if (friendlyMessage !== this.lastErrorOutput) {
        return friendlyMessage;
      }
    }

    // 根据退出码返回通用错误信息
    switch (code) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件';
      case 2:
        return 'sing-box 配置文件格式错误';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      case 137:
        return 'sing-box 进程被强制终止';
      case 143:
        return 'sing-box 进程被正常终止';
      default:
        return `sing-box 异常退出，退出码: ${code}`;
    }
  }

  /**
   * 发送事件到渲染进程
   */
  private sendEventToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  private getSingBoxPath(): string {
    return resourceManager.getSingBoxPath();
  }

  /**
   * 起内核前的 libcronet 自愈钩子（对称化 §4.3）：linux/win 对核心实际加载目录（dirname(getSingBoxPath())）
   * 调 ensureCronetHealthy（strong=false 热路径，仅 size 快筛），确保 cronet 缺失/损坏在启动前从内置 bundle 恢复。
   * macOS 跳过（cronet 静态编入 sing-box，无独立库）。best-effort：自愈失败仅告警不阻断启动——naive 不可用时
   * sing-box 会自报 cronet 错误并由现有降级兜底（跳过 naive 节点 + 可读报错），其它协议节点不受影响。
   */
  private async ensureCronetReadyForLaunch(): Promise<void> {
    if (process.platform !== 'linux' && process.platform !== 'win32') return;
    const loadDir = path.dirname(this.getSingBoxPath());
    const r = await resourceManager.ensureCronetHealthy(loadDir);
    if (r.action === 'restored') {
      this.logToManager('info', `启动前 libcronet 自愈：已从内置恢复到 ${loadDir}`);
    } else if (r.action === 'failed') {
      this.logToManager(
        'warn',
        `启动前 libcronet 自愈失败：${r.reason ?? ''}（naive 节点可能不可用）`
      );
    }
  }
}
