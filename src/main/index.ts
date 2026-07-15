import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from './services/ConfigManager';
import { ProtocolParser } from './services/ProtocolParser';
import { LogManager } from './services/LogManager';
import { TrayManager } from './services/TrayManager';
import { releaseWindowMemory, detectRenderCrashLoop } from './services/window-memory';
import {
  reduceMountGate,
  initialMountGateState,
  type MountGateState,
} from './services/mount-health-gate';
import { fatalErrorPageDataUrl } from './services/error-page';
import { admitConsoleMessage, truncateConsoleMessage } from './services/console-forward';
import {
  parseRendererRssLimitMb,
  rendererRssMbFromMetrics,
  decideRendererMemoryAction,
} from './services/renderer-memory-watchdog';
import { shouldQuitOnAllWindowsClosed } from './window-close-policy';
import { ProxyManager } from './services/ProxyManager';
import { DiagnosticService } from './services/DiagnosticService';
import { createSystemProxyManager, SystemProxyBase } from './services/SystemProxyManager';
import { createSystemDnsManager, SystemDnsBase } from './services/SystemDnsManager';
import { resourceManager } from './services/ResourceManager';
import { registerIconProtocolSchemes, registerIconProtocol } from './icon-protocol';
import { notifyUser, setDesktopNotificationsEnabled } from './notify-user';
import { mt, setMainLanguage } from './i18n';
import { runCliEarlyExit } from './cli-early-exit';
import { selectPortableStaleOld } from './services/update-install-script';
import { SubscriptionService } from './services/SubscriptionService';
import { registerPrivacyHandlers } from './ipc/handlers/privacy-handlers';
import {
  registerConfigHandlers,
  registerServerHandlers,
  registerLogHandlers,
  registerProxyHandlers,
  registerVersionHandlers,
  registerUpdateHandlers,
  registerRulesHandlers,
  registerAutoStartHandlers,
  registerSpeedTestHandlers,
  registerSubscriptionHandlers,
  setUpdateService,
  setTrayStateCallback,
  registerCoreUpdateHandlers,
  setCoreUpdateService,
  registerBackupHandlers,
  registerDiagnosticHandlers,
  registerHelperHandlers,
  registerIpInfoHandlers,
  registerUnlockHandlers,
  registerSystemHandlers,
  registerRuleResourceHandlers,
  registerStatsSubscriptionHandlers,
} from './ipc/handlers';
import { setIpcLogger, registerIpcHandler } from './ipc/ipc-handler';
import { createAutoStartManager } from './services/AutoStartManager';
import { UpdateService } from './services/UpdateService';
import { CoreUpdateService } from './services/CoreUpdateService';
import { CoreUpdateScheduler } from './services/CoreUpdateScheduler';
import { SpeedTestService } from './services/SpeedTestService';
import { AutoSwitchService } from './services/AutoSwitchService';
import { SubscriptionScheduler } from './services/SubscriptionScheduler';
import {
  StatsWorkerHost,
  type StatsWorkerHostOptions,
  type StatsHost,
} from './services/StatsWorkerHost';
import { StatsSimulator } from './services/StatsSimulator';
import { StatsSubscriptionRegistry } from './services/StatsSubscriptionRegistry';
import { PlatformPrivilegeService } from './services/PlatformPrivilegeService';
import { IpInfoService } from './services/IpInfoService';
import { createExitProbeLatencyRunner } from './services/exit-probe-latency';
import { UnlockDetectionService } from './services/unlock/UnlockDetectionService';
import { localProxyPort } from '../shared/proxy-ports';
import { RuleResourceManager } from './services/RuleResourceManager';
import { UpdateNetwork } from './services/UpdateNetwork';
import { seedBuiltinRuleSets } from './services/builtin-geo-rulesets';
import { RuleResourceScheduler } from './services/RuleResourceScheduler';
import { HelperManager } from './services/HelperManager';
import { WindowsServiceHelper } from './services/WindowsServiceHelper';
import { LinuxServiceHelper } from './services/LinuxServiceHelper';
import type { IPrivilegedHelper } from './services/IPrivilegedHelper';
import type { HelperStatus, UserConfig } from '../shared/types';
import { ipcEventEmitter } from './ipc/ipc-events';
import { buildTrayCallbacks } from './tray-actions';
import { scheduleStartupTasks } from './startup-tasks';
import { registerConfigChangeListener } from './config-change-handler';
import { mainEventEmitter, MAIN_EVENTS } from './ipc/main-events';
import { initUserDataPath, getConfigPath } from './utils/paths';
import { shouldDisableHardwareAcceleration } from './services/graphics-compat';
import { IPC_CHANNELS, type StatsTopic } from '../shared/ipc-channels';
import { LOGIN_ITEMS_SETTINGS_URL } from '../shared/constants';
import { effectiveLogLevel } from '../shared/log-level';
import { resolveAutoLanguage, resolveEffectiveLanguage } from '../shared/language';

// ── 启动计时探针（真机量化用，纯日志、零行为改动）─────────────────────────────
// 从「本模块加载」到「窗口首次可见」的各阶段 ms，window-shown 时一行汇总到 app.log（[startup-timing]）。
// whenReady→configLoaded→windowCreated = 主进程（A1/A2 优化空间）；windowCreated→readyToShow = 渲染端首屏。
const STARTUP_T0 = Date.now();
const startupMarks: Record<string, number> = {};
let startupTimingLogged = false;
function startupMark(label: string): void {
  if (!startupTimingLogged && startupMarks[label] === undefined) {
    startupMarks[label] = Date.now() - STARTUP_T0;
  }
}
function logStartupTimingOnce(): void {
  if (startupTimingLogged) return;
  startupMark('shown');
  startupTimingLogged = true;
  logManager?.addLog(
    'info',
    `[startup-timing] ${JSON.stringify(startupMarks)}（ms，自模块加载起）`,
    'Main'
  );
}

// ── CLI / 非 GUI 早退（必须在 Electron GUI 平台初始化前；无 DISPLAY 下 GUI 初始化失败会卡死 + segfault）──
// 编排/判定全在 cli-early-exit（纯函数 + IO 注入，可单测）；此处仅注入真实 IO：
// - writeStdout/Stderr 用 fs.writeSync(同步落 fd)：process.stdout.write 写管道是异步缓冲，紧跟 exit 会丢
//   `flowz -V | cat` / `$(flowz -V)` 的输出。
// - exit 用 process.exit(而非 app.exit)：保证同步终止、绝不 fall-through 落回下方 GUI init（ready 前无 GUI 状态需清理）。
// - setLanguage 经 resolveAutoLanguage 智能匹配系统 locale(ru-RU→ru / zh_HK→zh-TW)，与 normal 路径一致，禁硬编码。
runCliEarlyExit({
  argv: process.argv.slice(1),
  env: process.env,
  platform: process.platform,
  getVersion: () => app.getVersion(),
  writeStdout: (text) => fs.writeSync(1, text),
  writeStderr: (text) => fs.writeSync(2, text),
  setLanguage: (langs) => setMainLanguage(resolveAutoLanguage(langs)),
  headlessMessage: () => mt('headlessNoDisplay'),
  exit: (code) => process.exit(code),
});

// 初始化用户数据路径（必须在 app.requestSingleInstanceLock() 之前调用）
// 以确保便携模式下，锁文件和所有 Electron 数据都重定向到正确的目录
initUserDataPath();

// 图形兼容逃生门（用户自救）：hardwareAcceleration 被显式关闭（=== false）时禁用硬件加速，改用软件渲染。
// app.disableHardwareAcceleration() 必须在 app ready **之前**调用（Electron 硬约束），此时 ConfigManager 尚未
// 初始化 → 只能早期同步读 config.json 原文本（initUserDataPath 已把 userData 路径下沉，getConfigPath 可用）。
// 判定抽成纯函数 shouldDisableHardwareAcceleration（可单测）；容错第一：文件缺失/损坏/字段缺 → 当「默认开」不禁，
// 绝不抛（早期崩 = 整个启动失败）。此为显式用户控制，实际只对 Win/mac 有意义——Linux 见下方已**无条件**禁用硬件
// 加速，故 Linux 上本开关是 no-op（设置页对 Linux 整卡隐藏，不给死开关）。重复调用 disableHardwareAcceleration 幂等无害。
try {
  if (shouldDisableHardwareAcceleration(fs.readFileSync(getConfigPath(), 'utf-8'))) {
    app.disableHardwareAcceleration();
  }
} catch {
  // 文件不存在（新装/首启）/无权限/读失败：视为默认开（不禁），静默忽略（绝不阻断启动）。
}

// Windows LTSC / 精简版系统兼容处理
// 如果用户是 LTSC 且黑屏，建议他们通过设置开启“禁用硬件加速”选项
// 强制开启软件渲染会导致正常 Windows 用户出现严重白屏或掉帧，因此这里移除全局强制设定。
// 仅保留基础的禁用 GPU 沙箱，防止部分环境权限不足导致的 GPU 进程崩溃
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 开启 V8 手动 GC 能力，用于进入轻量模式时主动释放主进程堆内存
// 不影响正常运行，仅在 enterLightweightMode 时调用一次
try {
  require('v8').setFlagsFromString('--expose-gc');
} catch {
  // 部分环境不支持，忽略
}

// Linux：QEMU/虚拟显卡 + xrdp/VNC 等远程桌面/虚拟机环境无可用硬件加速，Chromium GPU 进程反复启动失败
// （ContextResult::kTransientFailure → GPU process launch failed error_code=1002）会触发
// "GPU process isn't usable. Goodbye." FATAL，整个 app 闪退（实测 QEMU stdvga + xrdp 必现）。
// FlowZ 为轻量代理工具 UI（无 3D/视频/canvas 密集渲染），软件渲染体验无感，故 Linux 一律禁用硬件加速换稳定。
// 必须在 app ready 之前调用（Electron 约束），放在单实例锁之前 = 模块加载期最早处。
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    showWindow();
  });
}

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
const isDevelopment = process.env.NODE_ENV === 'development';
let idleCheckInterval: NodeJS.Timeout | null = null; // 自动空闲模式轮询（powerMonitor 真实系统输入空闲）

// 窗口拖动态（T2，issue #225）：Windows 拖动 frameless 窗口走 move modal loop（跑主线程），拖动期间任何
// 非关键 UI 推流（日志/流量/连接）都会逼整窗逐帧重绘 + RDP 全帧重编码 → 拖动卡顿。move 时置位、moved 去抖后清零。
let isDragging = false;

/**
 * UI 广播活跃谓词（T1/T2/T4 统一门控，issue #225）：窗口可见 **且** 非拖动中 才推 UI 更新。
 * - 日志批 flush（registerLogHandlers）按此门控：不活跃只暂存不推。
 * - 流量/连接 relay（StatsWorkerHost）按此门控：不活跃只更新缓存不 sendToAll，活跃恢复时补推一帧最新。
 * 不活跃 = 窗口已销毁（关窗释放内存 / 轻量模式）或 macOS Cmd+H 系统级隐藏；拖动中 = 让主线程只处理
 * 窗口移动重绘。
 */
function isUiBroadcastActive(): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !isDragging;
}

let isPrivacyMode = false;

export function getPrivacyMode(): boolean {
  return isPrivacyMode;
}

export function setPrivacyMode(value: boolean): void {
  if (isPrivacyMode === value) return;
  isPrivacyMode = value;
  // 隐私联动：app.log/UI 即时按隐私态收敛（≥warn 不记连接明细）；sing-box 连接日志级别在下次核心重启时按新隐私
  // 态重新生成（不主动断流）。logManager/configManager 为模块级，早期调用可能尚未初始化 → 守空。
  if (logManager) {
    configManager
      ?.loadConfig()
      .then((cfg) => logManager.setLogLevel(effectiveLogLevel(cfg.logLevel || 'info', value)))
      .catch(() => {});
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      value ? IPC_CHANNELS.EVENT_ENTER_PRIVACY_MODE : IPC_CHANNELS.EVENT_EXIT_PRIVACY_MODE
    );
  }
}

// 自动空闲模式：用 powerMonitor 真实系统输入空闲判定（替代窗口 blur/hide 边沿武装；
// 覆盖「聚焦闲置 / 静默自启从未 show / 运行中才打开开关」等 blur/hide 模型盖不住的场景）。
const IDLE_THRESHOLD_SEC = 600; // 10 分钟（getSystemIdleTime 返回秒）
const IDLE_POLL_MS = 60 * 1000; // 轮询粒度 60s（实际触发约 10–11 分钟）

/**
 * 每 60s 检查系统输入空闲，达阈值则按开关进入轻量 / 隐私模式。
 * 轻量：聚焦时豁免（用户可能在盯拓扑/流量面板，不销毁眼前窗口）；隐私：锁屏语义，不豁免聚焦。
 * 进入后不会重复触发：轻量销毁窗口后 mainWindow 失效自动跳过；隐私置 isPrivacyMode 后跳过。
 */
async function checkIdleAutoModes(): Promise<void> {
  try {
    const cfg = await configManager.loadConfig().catch(() => null);
    if (!cfg) return;
    if (!cfg.autoLightweightMode && !cfg.autoPrivacyMode) return;
    if (powerMonitor.getSystemIdleTime() < IDLE_THRESHOLD_SEC) return;
    // 窗口创建在途时跳过本轮：轻量分支会 destroy 窗口，避免销毁 ensureWindow 半成品（防御，当前不可达）
    if (creatingWindow) return;

    if (
      cfg.autoLightweightMode &&
      trayManager &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isFocused()
    ) {
      logManager.addLog('info', 'System idle reached, entering lightweight mode', 'Main');
      trayManager.enterLightweightMode();
    }

    if (cfg.autoPrivacyMode && !isPrivacyMode) {
      logManager.addLog('info', 'System idle reached, entering privacy mode', 'Main');
      setPrivacyMode(true);
    }
  } catch {
    // ignore
  }
}

// 渲染进程内存 watchdog（issue #242 §4 视图生命周期）：change-driven / 订阅驱动只把更新降频，泄漏
// 本体（若在 Blink/V8/Electron 层）未根除；本 watchdog 是对其的**确定性兜底**——渲染 RSS 超阈值时隐藏态 destroy
// 窗口全额回收、可见态只告警。定位=lifecycle hygiene（同浏览器 tab discard），非泄漏修复。high 阈值 1.5GB 远超
// 正常 ~250MB，隐藏态回收对用户透明 → 「用户永远看不到 2GB」。**always-on 安全网**（非 gate 在 autoLightweightMode：
// 那是用户偏好的空闲省电，本 watchdog 是防失控的红线兜底，两者正交；隐藏态回收无副作用，无需开关门）。
const RENDERER_RSS_LIMIT_MB = parseRendererRssLimitMb(process.env.FLOWZ_RENDERER_RSS_LIMIT_MB);
const RENDERER_MEM_WARN_COOLDOWN_MS = 5 * 60 * 1000; // 可见态告警冷却 5min，防刷屏
let lastRendererWarnAt = 0;
let rendererDiscardCount = 0; // 本会话隐藏态回收次数（诊断导出）
let rendererWarnCount = 0; // 本会话可见态告警次数（诊断导出）

// 主进程 mount 健康门超时（GAP-1a）：did-finish-load 后等 RENDERER_READY 的窗口；到点未收到 = C 类白屏（进程活着
// 但 DOM 空）。12s 给足慢机首屏 React 挂载 + 首帧 effect，又不至于让真崩溃时用户空等太久。
const RENDERER_READY_TIMEOUT_MS = 12_000;

/**
 * 渲染进程内存 watchdog 一轮采样 + 处置（接在 idleCheckInterval 的 60s 节拍，watchdog 对小时级泄漏足够，不新增
 * interval）。取渲染主窗口 pid → getAppMetrics 采其 RSS → 纯决策：
 * - 'discard'（超阈值 + 窗口隐藏）：走既有轻量原语 enterLightweightMode 销毁窗口全额回收（ensureWindow 下次 show
 *   重建；轻量原语内 markLightweightModeTransition 已保「有托盘不误退 app」，仅无托盘僵尸态才退——与空闲轻量同语义）。
 * - 'warn'（超阈值 + 窗口可见）：主进程无现成通用 toast-to-renderer 通道（既有 EVENT 均为专用 payload）→ 退化为
 *   app.log 面包屑 + 诊断计数（不硬造 renderer UI，见批次报告）；带 5min 冷却防刷屏。
 * 全程 try/catch 吞异常：绝不因采样/回收失败崩掉空闲主循环。
 */
function checkRendererMemory(): void {
  try {
    const win = mainWindow;
    const windowExists = !!win && !win.isDestroyed();
    // 渲染主窗口 OS pid（与 getAppMetrics 的 pid 同口径）；无窗口/销毁 → null。
    const rendererPid = windowExists ? win!.webContents.getOSProcessId() : null;
    const rssMb = rendererRssMbFromMetrics(app.getAppMetrics(), rendererPid);
    // 可见 = 未隐藏且未最小化：Cmd+H / 关到托盘 / 最小化均判「不可见」→ 允许销毁回收；拖动中窗口仍可见 → 只告警
    // 不销毁（故用 isVisible/!minimized，而非含 !isDragging 的 isUiBroadcastActive）。
    const windowVisible = windowExists && win!.isVisible() && !win!.isMinimized();
    const now = Date.now();
    const action = decideRendererMemoryAction({
      rssMb,
      thresholdMb: RENDERER_RSS_LIMIT_MB,
      windowExists,
      windowVisible,
      lastWarnAt: lastRendererWarnAt,
      now,
      warnCooldownMs: RENDERER_MEM_WARN_COOLDOWN_MS,
    });
    if (action === 'discard') {
      logManager.addLog(
        'warn',
        `Renderer RSS ${rssMb}MB > ${RENDERER_RSS_LIMIT_MB}MB 且窗口隐藏，进入轻量模式回收`,
        'Main'
      );
      rendererDiscardCount++;
      trayManager?.enterLightweightMode();
    } else if (action === 'warn') {
      logManager.addLog(
        'warn',
        `Renderer RSS ${rssMb}MB > ${RENDERER_RSS_LIMIT_MB}MB（窗口可见），建议刷新页面释放内存`,
        'Main'
      );
      rendererWarnCount++;
      lastRendererWarnAt = now;
    }
  } catch {
    // 采样/回收失败不阻断空闲主循环（getAppMetrics 极端异常、窗口在途销毁等）
  }
}

// Initialize service references
let configManager: ConfigManager;
let protocolParser: ProtocolParser;
let logManager: LogManager;
let proxyManager: ProxyManager | null = null;
let systemProxyManager: ReturnType<typeof createSystemProxyManager>;
let systemDnsManager: ReturnType<typeof createSystemDnsManager>;
let updateService: UpdateService;
let coreUpdateService: CoreUpdateService;
let subscriptionService: SubscriptionService;
let speedTestService: SpeedTestService;
let autoSwitchService: AutoSwitchService;
let subscriptionScheduler: SubscriptionScheduler;
let coreUpdateScheduler: CoreUpdateScheduler | null = null;
let statsService: StatsHost | null = null;
let ipInfoService: IpInfoService | null = null;
let unlockService: UnlockDetectionService | null = null;
let ruleResourceManager: RuleResourceManager | null = null;
let ruleResourceScheduler: RuleResourceScheduler | null = null;
let helperManager: IPrivilegedHelper | null = null;
// 界面语言不再由渲染端经 IPC 反向告知——主进程直接读 config.language 单一真值源（启动 + config-change）。
// 渲染端 APP_SET_NODE_SORT_BY_LATENCY 同步的「按延迟排序」开关最近值；持有于此以便 trayManager 在渲染端 mount 推送
// 早于 tray 创建的极端时序下、于 tray 创建后补应用（否则 push 被 trayManager?.短路丢弃 → 托盘整会话停在默认序）。
let currentNodeSortByLatency = false;

/**
 * helper 引导对话框（注入 ProxyManager.setHelperGate，由 start() 在 darwin+TUN+helper 未就绪+未 dismiss
 * 时统一调用——收敛单点，覆盖按钮/托盘/切模式/config-changed 重启等全部入口）。
 * 返回 'abort' → 终止本次启动（终态等价 osascript 取消=停止态）；'proceed' → 继续（装好走零提权，否则 osascript 回退）。
 */
async function promptHelperGate(
  hs: HelperStatus,
  _config: UserConfig
): Promise<'proceed' | 'abort'> {
  if (!helperManager) return 'proceed';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.platform === 'win32') {
    // Windows：无「允许在后台」概念（backgroundDisabled 恒 false）。needsRepair(已装未就绪) → 修复；未装 → 安装。
    // 任一路径仅弹一次 UAC（装服务需管理员授权）；「用 UAC 启动」= 本次回退 buildWindowsUacLaunchCommand（每次 UAC）。
    if (hs.needsRepair) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: [mt('btnRepairStart'), mt('btnUseUac'), mt('btnCancel')],
        defaultId: 0,
        cancelId: 2,
        message: mt('dlgWinRepairServiceMsg'),
        detail: mt('dlgWinRepairDetail'),
      });
      if (response === 2) return 'abort';
      if (response === 0) await helperManager.install().catch(() => {});
      return 'proceed';
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [mt('btnInstallStart'), mt('btnUseUac'), mt('btnCancel')],
      defaultId: 0,
      cancelId: 2,
      message: mt('dlgWinInstallServiceMsg'),
      detail: mt('dlgWinInstallDetail'),
    });
    if (response === 2) return 'abort';
    if (response === 0) await helperManager.install().catch(() => {});
    return 'proceed';
  }
  if (process.platform === 'linux') {
    // Linux：needsRepair(已装未就绪) → 修复；未装 → 安装。任一路径仅一次 pkexec（装 systemd 服务需授权一次）；
    // 「用系统授权启动」= 本次回退 setcap+pkexec（每次启停授权）。无「允许在后台」/plist 概念，不落 mac 分支。
    if (hs.needsRepair) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: [mt('btnRepairStart'), mt('btnUseSystemAuth'), mt('btnCancel')],
        defaultId: 0,
        cancelId: 2,
        message: mt('dlgLinuxRepairServiceMsg'),
        detail: mt('dlgLinuxRepairDetail'),
      });
      if (response === 2) return 'abort';
      if (response === 0) await helperManager.install().catch(() => {});
      return 'proceed';
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [mt('btnInstallStart'), mt('btnUseSystemAuth'), mt('btnCancel')],
      defaultId: 0,
      cancelId: 2,
      message: mt('dlgLinuxInstallServiceMsg'),
      detail: mt('dlgLinuxInstallDetail'),
    });
    if (response === 2) return 'abort';
    if (response === 0) await helperManager.install().catch(() => {});
    return 'proceed';
  }
  if (hs.backgroundDisabled) {
    // 「登录项与扩展 / 允许在后台」开关由 BTM（Background Task Management）管，与 launchctl enable/disable 是两个
    // 独立层。用户关掉开关 = BTM disposition 置 disallowed。程序无法把它翻回开（Apple SMAppService 无写 disposition
    // 的 API），唯一可靠恢复是用户去系统设置手动开。故三选项：
    //  - 打开系统设置：深链到「登录项与扩展」，用户手动开启后回来重新启动即免授权（abort，保持干净停止态）。
    //  - 本次直接启动：经 startSingBoxProcess 走 osascript root 看护脚本（弹一次密码框、不依赖 BTM、会话稳定）；每次启停需授权。
    //  - 取消。
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [mt('btnOpenSystemSettings'), mt('btnStartThisSession'), mt('btnCancel')],
      defaultId: 0,
      cancelId: 2,
      message: mt('dlgMacBgOffMsg'),
      detail: mt('dlgMacBgOffDetail'),
    });
    if (response === 0) {
      await shell.openExternal(LOGIN_ITEMS_SETTINGS_URL).catch(() => {});
      return 'abort'; // 打开设置后中止本次启动；用户开好开关回来重启即免授权
    }
    if (response === 1) {
      // 本次直接启动：不再 install-over-top —— 真机实测 install 拉起的 disallowed daemon 会被 BTM ~20s 后收割（代理
      // 死、自动重启失败），且与随后 osascript 看护构成双弹窗。直接放行，由 startSingBoxProcess 在 backgroundDisabled
      // 时走 osascript root 看护脚本（不受 BTM 管、单次授权、会话稳定）。
      return 'proceed';
    }
    return 'abort'; // 取消
  }
  if (hs.needsRepair || hs.pathMismatch) {
    // 需修复有两种成因，文案分流（避免 proto 升级也报「应用位置已变更」误导用户，L3）：
    //  - pathMismatch：应用被移动，plist 烧录路径失效；
    //  - 否则（!ready）：多为协议版本升级（如 v2→v3），已装 helper 需重装到新版本。
    // 诚实化：此「修复」=重装，**不会**恢复系统设置里「允许在后台」开关；若开关被关需到系统设置手动开启（Bug2 文案）。
    const detail =
      (hs.pathMismatch ? mt('dlgMacRepairPathMismatchDetail') : mt('dlgMacRepairUpgradeDetail')) +
      mt('dlgMacRepairNoteOff');
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [mt('btnRepairStart'), mt('btnUseSystemAuth'), mt('btnCancel')],
      defaultId: 0,
      cancelId: 2,
      message: mt('dlgMacRepairHelperMsg'),
      detail,
    });
    if (response === 2) return 'abort'; // 取消：不启动
    if (response === 0) await helperManager.install().catch(() => {}); // 重烧路径后 start 走 helper 零提权
    return 'proceed';
  }
  // 未安装 → 安装并启动
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [mt('btnInstallStart'), mt('btnUseSystemAuth'), mt('btnCancel')],
    defaultId: 0,
    cancelId: 2,
    message: mt('dlgMacInstallHelperMsg'),
    detail: mt('dlgMacInstallDetail'),
  });
  if (response === 2) return 'abort'; // 取消：不启动
  if (response === 0) await helperManager.install().catch(() => {}); // 装好后 start 走 helper 零提权
  return 'proceed';
}

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  if (logManager) {
    logManager.addLog('fatal', `未捕获的异常: ${error.message}\n${error.stack}`, 'Main');
  }

  if (isDevelopment) {
    const electronApp = require('electron').app;
    if (electronApp?.isReady()) {
      dialog.showErrorBox('未捕获的异常', `${error.message}\n\n${error.stack}`);
    } else {
      console.error(`App not ready. Uncaught Exception: ${error.stack}`);
    }
  }

  // 不退出应用，尝试继续运行
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : '';
  if (logManager) {
    logManager.addLog('error', `未处理的 Promise 拒绝: ${errorMessage}\n${errorStack}`, 'Main');
  }

  if (isDevelopment && reason instanceof Error) {
    const electronApp = require('electron').app;
    if (electronApp?.isReady()) {
      dialog.showErrorBox('未处理的 Promise 拒绝', `${errorMessage}\n\n${errorStack}`);
    } else {
      console.error(`App not ready. Unhandled Rejection: ${errorStack}`);
    }
  }
});

// 开发环境启用热重载 (moved and unmounted since it causes app undefined bug in electron)

// 创建中记忆：createWindow 在 new BrowserWindow 前 await loadConfig，多入口（启动/activate/托盘/second-instance）
// 在「无窗口」态并发触发会各自越过检查、建出两个窗口（首个泄漏）→ 所有入口共享同一次进行中的创建。
let creatingWindow: Promise<void> | null = null;
// 显式唤出请求：在途创建（可能属 silent 启动 forceShow=false）完成后由 ready-to-show 消费 → 绘制完成才显示，免未绘制帧闪现。
let pendingForceShow = false;
// 主窗渲染进程崩溃自愈：app 级 child-process-gone 只注册一次；render-process-gone 崩溃时刻用于崩溃循环检测。
let childProcessGoneBound = false;
let renderGoneTimestamps: number[] = [];
function ensureWindow(forceShow = false): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve();
  if (!creatingWindow) {
    creatingWindow = createWindow(forceShow)
      .catch((e) => {
        logManager.addLog(
          'error',
          `创建主窗口失败: ${e instanceof Error ? e.message : String(e)}`,
          'Main'
        );
      })
      .finally(() => {
        creatingWindow = null;
      });
  }
  return creatingWindow;
}

async function showWindow() {
  // Accessory 态下窗口无法成为 key window/置前 → 必须先回 Regular 再 show
  restoreDockPresence();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true }); // showWindow 恒为显式用户意图
    return;
  }
  // 标记待显示：在途创建若属 silent 启动，由 createWindow 的 ready-to-show 在绘制完成后显示（免未绘制帧闪现）
  pendingForceShow = true;
  await ensureWindow(true);
  // 兜底：ready-to-show 已在 await 解析前触发过（加载极快）且窗口仍隐藏 → 直接显示（此时已绘制完，无闪现）
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isLoading() &&
    !mainWindow.isVisible()
  ) {
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  }
}

// ── macOS 菜单栏常驻：关窗即摘 Dock 图标 ───────────────────────────────────
// 机制：setActivationPolicy('accessory') 令系统认定无 Dock 图标 + app.hide() 触发「前台交还/app 切换」促 Dock
// 重绘移除 tile。**已知 macOS 限制**（用户实测 + Apple 论坛证实）：Dock「最近使用」区里未固定 app 少于 3 个时，
// Dock 无法回填摘除 tile 留下的空位 → 图标视觉残留（systemAPI 已认无图标、dock.isVisible()→false，仅视觉未刷新）；
// 最近 app 充足时正常消失。此为系统行为、app 层无可靠绕过。
// 不用 app.dock.hide()：Electron 实现会对所有窗口 setCanHide:NO 且 DockShow 不恢复（electron#16093 wontfix）→
// 关窗一次后 Cmd+H 永久失效；且收益（修上述残留）大概率 no-op（排在 accessory 之后无进程状态迁移）。
let dockHidden = false; // 当前是否处于 accessory（菜单栏-only）

function hideDockIfMenubarOnly() {
  if (process.platform !== 'darwin') return;
  if (isQuitting || dockHidden) return;
  // 守卫：任一窗口仍可见（主窗 / 更新进度窗）则不摘 Dock。用「全部窗口」判定 → 对任何调用点自保。
  const anyVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
  if (anyVisible) return;
  app.setActivationPolicy('accessory');
  dockHidden = true;
  app.hide(); // 触发「前台交还/app 切换」促 Dock 重绘移除 tile（受上述 macOS 最近-app 限制）。
}

/** 恢复 Dock 图标（accessory→regular）。必须在 show()/focus() 之前调用。 */
function restoreDockPresence(): void {
  if (process.platform !== 'darwin') return;
  if (!dockHidden) return;
  app.setActivationPolicy('regular');
  dockHidden = false;
  // Accessory→Regular 已知怪癖：窗口可能落在其他 app 之后/菜单栏不挂接 → 下一拍显式激活
  setTimeout(() => {
    if (!isQuitting) app.focus({ steal: true });
  }, 50);
}

// 任一窗口关闭后重评估「无可见窗口 → 菜单栏-only」：覆盖更新进度窗关闭、主窗关闭/轻量 destroy 等
// 全部路径（hideDockIfMenubarOnly 自带 anyVisible 守卫 + isQuitting/dockHidden 幂等，重复调用安全）。
// 模块级注册（早于首个窗口创建）→ 含启动期主窗。
if (process.platform === 'darwin') {
  app.on('browser-window-created', (_e, win) => {
    win.on('closed', () => {
      if (!isQuitting) hideDockIfMenubarOnly();
    });
  });
}

/**
 * OS 偏好语言（有序，BCP47）——i18n「自动跟随系统」用。优先 getPreferredSystemLanguages（Electron 17+，
 * 返回 OS 设置里的偏好语言列表）；缺失则回退 getSystemLocale（单值）。绝不用 app.getLocale（恒返 app bundle locale=en）。
 */
function getPreferredSystemLanguagesSafe(): string[] {
  try {
    const langs = app.getPreferredSystemLanguages?.();
    if (Array.isArray(langs) && langs.length > 0) return langs;
  } catch {
    /* 忽略，回退 */
  }
  try {
    const loc = app.getSystemLocale?.();
    if (loc) return [loc];
  } catch {
    /* 忽略 */
  }
  return [];
}

async function createWindow(forceShow = false) {
  // Part C：冷重建计时锚点（createWindow 入口 → presentWindow 首次 show）。量化 discard/首唤重建死区，
  // 为将来「优化重建」提供数据。hide→show 走 showWindow 不经本函数 → 天然不计时（保活路径无死区）。
  const createT0 = Date.now();
  // macOS 需要设置应用菜单以启用 Cmd+C/V/X/A 等快捷键
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
          { role: 'delete', label: '删除' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  // 集成标题栏覆盖层（Windows）：透明底融进内容/Mica、随主题切换重设按钮符号色。height 32 = Win11 原生标题栏高。
  const overlayColors = (dark: boolean) => ({
    color: '#00000000', // 透明：覆盖层融进内容/Mica，避免突兀的底块
    symbolColor: dark ? '#E6EDF3' : '#1F2937',
    height: 32,
  });

  // 单次 loadConfig 读取窗口尺寸 + 主题（loadConfig 内部 catch 兜默认配置、绝不抛，无需 try/catch）。
  // 注意：transparent 仅 macOS 启用，Win/Linux 启用会侧边栏透明 + 鼠标事件穿透（Electron 已知问题）。
  // 默认窗口大小 = 最小窗口大小（800×720，用户指定）；有保存的 bounds 时覆盖。
  let windowWidth = 800;
  let windowHeight = 720;
  const cfg = await configManager.loadConfig();
  if (cfg.rememberWindowSize && cfg.windowBounds) {
    windowWidth = cfg.windowBounds.width;
    windowHeight = cfg.windowBounds.height;
  }
  const { nativeTheme } = require('electron');
  if (cfg.uiTheme) {
    nativeTheme.themeSource = cfg.uiTheme;
  }
  // 初始深浅以 nativeTheme.shouldUseDarkColors 为准（themeSource 已按 uiTheme 设定，'system' 跟随 OS）。
  // 不能用 cfg.uiTheme==='dark' 字面判：uiTheme='system'+OS 深色会被误判为浅色，致标题栏/背景与内容初始不一致，
  // 而 onThemeUpdated 仅在 OS 主题「切换」时修正、初始不跑。
  const isDarkInitial = nativeTheme.shouldUseDarkColors;
  // 图形兼容逃生门（windowEffects，默认开=`!== false`）：D 类合成层向量（Windows Mica bug 群 / macOS 透明+vibrancy）
  // 跨平台对齐——关闭时 Win 不设 Mica、mac 不开 transparent+vibrancy，一律回落实色窗口底，供合成失效白屏时自救。
  // 窗口 chrome（titleBarStyle/titleBarOverlay/frame）不属特效，不受此开关影响。
  const effectsOn = cfg.windowEffects !== false;
  // mac 特效开才用透明底（让原生 vibrancy 透出）；特效关 / 非 mac 一律实色主题色。
  // 关键：mac 特效关时必须给实色——渲染端 html/body/.app-shell 在 platform-darwin 下恒 transparent
  //（index.css:148/153/476「keep html transparent so native vibrancy shows through」），若窗口底仍是
  // '#00000000' 而 transparent 已关，透出的就是黑底。给实色后透出实色，与 Win/Linux 的 app-shell 同色收敛。
  const useMacTransparent = isMac && effectsOn;
  const solidBackground = isDarkInitial ? '#1F252E' : '#E9EEF3';

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 800,
    minHeight: 720,
    title: 'FlowZ',
    icon: resourceManager.getAppIconPath(),
    show: false, // 先不显示，等待加载完成
    backgroundColor: useMacTransparent ? '#00000000' : solidBackground,
    transparent: useMacTransparent,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDevelopment,
      // OS 偏好语言注入 preload（同步、无 IPC 时序问题）：供 i18n「自动跟随系统」解析。
      //   app.getLocale() 恒返 app bundle locale=en（与系统脱钩，代码多处实证），故必须用 getPreferredSystemLanguages。
      // 界面语言选择注入 preload（config.language 单一真值源）：供 i18n 初始化直接用，取代旧 localStorage 真值源。
      //   每个 additionalArguments 项作为独立 argv 项传递，'auto'/语言码均为安全 ASCII，无需转义。
      additionalArguments: [
        `--flowz-sys-langs=${JSON.stringify(getPreferredSystemLanguagesSafe())}`,
        `--flowz-lang-choice=${cfg.language ?? ''}`,
      ],
    },
    // macOS：集成式窗口（红绿灯内嵌 + sidebar 半透材质）。titleBarStyle 是窗口 chrome、恒设；
    // vibrancy/visualEffectState 是合成层特效 → 仅 effectsOn 时展开（关闭即回落实色底，见 solidBackground）。
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      ...(effectsOn && { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const }),
    }),
    // Windows：集成式标题栏（隐藏原生栏 + 右上覆盖层按钮，对齐 Mac）+ Win11 Mica 材质。
    // Mica 仅作窗口/侧栏底（壁纸微染），内容卡片实色不透。窗口 backgroundColor 取实色主题色作兜底：
    // 物理屏+透明效果 → Mica；RDP/透明关 → DWM 回落该实色 #1F252E/#E9EEF3（不会黑）。
    ...(isWindows && {
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayColors(isDarkInitial),
      // Mica 逃生门（windowEffects，默认开）：默认设 backgroundMaterial:'mica'（Win11 材质）；用户关掉特效则不设，
      // 回落 DWM 实色底（backgroundColor 已是实色主题色，不会黑），规避 electron Mica 合成失效
      //（#38743/#46753/#28255/#48031）的 hide/show 白屏。titleBarStyle/overlay 等其它 Windows 项保持不变。
      ...(effectsOn && { backgroundMaterial: 'mica' as const }),
    }),
    // Linux：无系统 titleBarOverlay API → frameless（frame:false）+ 渲染端自绘标题栏（拖拽区 + min/max/close 按钮），
    // 与 Mac/Win 嵌入式视觉对齐。frameless 窗口 Electron 默认仍保留边缘 resize（resizable 未关）。
    ...(!isMac && !isWindows && { frame: false }),
  });

  // Windows: 监听系统主题变化，同步原生窗口背景色
  // 这是修复 GPU 待机后圆角处出现黑色伪影的关键：
  // 当 Chromium 合成器层缓存失效时，原生窗口背景会短暂露出，
  // 如果颜色和 sidebar 不匹配就会看到黑点。
  if (!isMac && mainWindow) {
    const { nativeTheme } = require('electron');
    // 命名 handler + 'closed' 时移除：否则每次 createWindow 累积一个全局监听器，
    // 自动轻量(销毁) × ensureWindow(重建) 的销毁-重建循环下无界累积（~10 轮 MaxListenersExceededWarning）。
    const onThemeUpdated = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const isDark = nativeTheme.shouldUseDarkColors;
        // 实色底：Win/Linux 同步原生窗口背景（深色取 macOS 风格中灰 #1F252E），修 GPU 待机后圆角黑色伪影。
        mainWindow.setBackgroundColor(isDark ? '#1F252E' : '#E9EEF3');
        // Windows 集成标题栏：覆盖层按钮颜色随主题切换重设。
        if (isWindows) {
          mainWindow.setTitleBarOverlay(overlayColors(isDark));
        }
      }
    };
    nativeTheme.on('updated', onThemeUpdated);
    mainWindow.once('closed', () => nativeTheme.removeListener('updated', onThemeUpdated));
  }

  // ── 窗口尺寸记忆：监听 resize 并防抖保存 ──
  let resizeTimer: NodeJS.Timeout | null = null;
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      try {
        const cfg = await configManager.loadConfig();
        if (cfg.rememberWindowSize && mainWindow && !mainWindow.isDestroyed()) {
          const [w, h] = mainWindow.getSize();
          cfg.windowBounds = { width: w, height: h };
          await configManager.saveConfig(cfg);
        }
      } catch {
        // 保存失败不影响使用
      }
    }, 500);
  });

  // Linux frameless 自绘标题栏：最大化态变更（含 WM 双击标题/拖顶等非按钮操作）推渲染端，同步 max/restore 图标。
  const sendMaximizeState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        IPC_CHANNELS.EVENT_WINDOW_MAXIMIZE_CHANGED,
        mainWindow.isMaximized()
      );
    }
  };
  mainWindow.on('maximize', sendMaximizeState);
  mainWindow.on('unmaximize', sendMaximizeState);

  // ── 窗口拖动门控（T2，issue #225）── 仅 Windows
  // 拖动 frameless 窗口走 OS move modal loop（主线程），期间整窗逐帧重绘 + RDP 全帧重编码；若同时有日志/流量/连接
  // 广播触发重渲，拖动即卡顿。拖动期间置 isDragging → isUiBroadcastActive 返 false → 日志批 flush 与 stats relay
  // 全部挂起，让主线程只处理窗口移动重绘；拖动结束后去抖恢复并补推一帧最新缓存。
  // 仅 win32 门控：macOS/Linux 拖动由合成器流畅处理、无主线程 modal 阻塞，挂起只会徒增「拖动时数字冻住」无收益。
  // 拖动结束判定用「move 流停止」（最后一个 move 后 DRAG_SETTLE_MS 内无新 move）——比 'moved' 事件在各平台/RDP 更可靠。
  isDragging = false; // 新窗口重置（防上个窗口拖动中被销毁致 isDragging 滞留 true）
  let dragSettleTimer: NodeJS.Timeout | null = null;
  if (process.platform === 'win32') {
    const DRAG_SETTLE_MS = 120;
    mainWindow.on('move', () => {
      if (!isDragging) isDragging = true; // 仅拖动起始置位（move 高频，避免重复赋值）
      if (dragSettleTimer) clearTimeout(dragSettleTimer);
      dragSettleTimer = setTimeout(() => {
        isDragging = false;
        dragSettleTimer = null;
        // 拖动结束补推一帧最新流量/连接（免等 worker 下一帧最多 ~1s 滞后）；日志由下一 flush tick 自动恢复。
        statsService?.resume();
      }, DRAG_SETTLE_MS);
    });
    // 拖动中窗口被销毁 → 清残留 settle timer（防对已销毁窗口的滞留回调）。
    mainWindow.on('closed', () => {
      if (dragSettleTimer) clearTimeout(dragSettleTimer);
      dragSettleTimer = null;
      isDragging = false;
    });
  }

  if (process.platform !== 'darwin') {
    mainWindow.setMenu(null);
  }

  ipcEventEmitter.registerWindow(mainWindow);

  // 刷新持有窗口引用的各服务（关窗默认销毁重建后，构造时只捕获一次的引用会永久指向已销毁窗口，
  // 致 ProxyManager 的事件广播 / UpdateService 的更新对话框此后静默失效——见 ProxyManager.setMainWindow 的注释）。
  if (trayManager) {
    trayManager.setMainWindow(mainWindow);
  }
  proxyManager?.setMainWindow(mainWindow);
  updateService?.setMainWindow(mainWindow);

  startupMark('windowCreated');

  // 窗口呈现决策（show vs 静默隐藏）抽成**幂等**函数，由 ready-to-show 与 did-finish-load 兜底各触发一次、取先到者。
  // 根因（Linux 启动驻留托盘）：show:false 窗口的 `ready-to-show` 在 Linux 上会被合成器拖延数十秒（不给隐藏窗口出首帧，
  // 实测 17~129s），单靠它 → 窗口长时间不显示、误以为驻留托盘。`did-finish-load` 不依赖合成器、稳定及时，作兜底
  // （给 ready-to-show 先手 300ms，正常机器上 ready-to-show 先到、无闪现；被拖延时由 did-finish-load 兜住）。
  let windowPresented = false;
  const presentWindow = async () => {
    if (windowPresented || !mainWindow || mainWindow.isDestroyed()) return;
    windowPresented = true; // 同步占位，防 ready-to-show + did-finish-load 并发双进入
    // 消费 pendingForceShow（显式唤出在途 silent 启动时强制显示）
    const wantShow = forceShow || pendingForceShow;
    pendingForceShow = false;
    try {
      const cfg = await configManager.loadConfig();
      const isHiddenArg = process.argv.includes('--hidden');
      const isMacHidden =
        process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;

      // forceShow：用户显式唤出窗口（托盘「打开主窗口」/ activate / 窗口被销毁后重建）时绕过静默启动门控，
      // 否则 silentStart=true 时点了没反应。仅应用初始启动（forceShow=false）才尊重 silentStart。
      if (wantShow || (!cfg.silentStart && !isHiddenArg && !isMacHidden)) {
        mainWindow?.show();
        logManager.addLog('info', 'Main window shown', 'Main');
        // Part C：本次 createWindow 从入口到首帧呈现的耗时（冷重建/首启）。app.log 随诊断导出自然带出。
        logManager.addLog('info', `[window-recreate-timing] ${Date.now() - createT0}ms`, 'Main');
        logStartupTimingOnce();
      } else {
        logManager.addLog('info', 'Main window kept hidden (Silent Start)', 'Main');
        // 静默启动窗口从不显示 → 主动进入菜单栏-only，否则 Dock 图标空挂直到首次 show→hide（P1-2）
        if (process.platform === 'darwin') hideDockIfMenubarOnly();
      }
    } catch {
      // 如果配置加载失败，默认显示窗口
      mainWindow?.show();
      logStartupTimingOnce();
    }
  };
  mainWindow.once('ready-to-show', () => {
    startupMark('readyToShow');
    void presentWindow();
  });
  // 兜底：did-finish-load 稳定到达后给 ready-to-show 先手 300ms 再呈现（覆盖 Linux ready-to-show 被拖延数十秒）。
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => void presentWindow(), 300);
  });

  // 加载真实应用内容（初始 + 终局兜底「重新加载」复用）：dev 走 vite dev server，prod 走打包 index.html。
  // 开发者工具在生产环境**已禁用**（webPreferences.devTools=isDevelopment，见上方 BrowserWindow 构造）——快捷键也
  // 开不了。（原注释自述「devTools 仍 enable、可用快捷键打开」与代码矛盾，已更正。）
  const loadAppContent = (win: BrowserWindow) => {
    if (isDevelopment) {
      win.loadURL('http://localhost:5173').catch((err) => {
        logManager.addLog('error', `Failed to load dev server: ${err.message}`, 'Main');
      });
    } else {
      const indexPath = path.join(__dirname, '../../renderer/index.html');
      win.loadFile(indexPath).catch((err) => {
        logManager.addLog('error', `Failed to load index.html: ${err.message}`, 'Main');
      });
    }
  };
  loadAppContent(mainWindow);

  // ── C 类白屏兜底（GAP-1a）：renderer 进程活着但 DOM 空（模块级 import 死 / App 函数体或 provider render 前抛错）──
  // 该故障 Electron 既不发 render-process-gone（进程没死）也不发 did-fail-load（HTML 加载成功了），A/B 自愈全漏。
  // 唯一手段：约定 renderer mount 成功回发 RENDERER_READY（App.tsx 最先注册的 effect），did-finish-load 后武装超时；
  // 到点未收到 → 首次 reload（覆盖瞬态），再次 → 终局静态错误页 + 对话框。纯状态机在 mount-health-gate.ts（单测），
  // 此处只接线计时器 / reload / 错误页副作用。
  const gateWin = mainWindow; // 捕获本窗：陈旧事件（旧 webContents 迟到）经 !== mainWindow 甄别，不误伤已重建的新窗
  let mountGateState: MountGateState = initialMountGateState();
  let mountTimer: NodeJS.Timeout | null = null;
  let terminalEntered = false; // 终局兜底幂等位（防多路径重复 dialog/loadURL）；fatal:retry 复位后清零。

  // 终局兜底（GAP-1a 二次超时 / GAP-3 二次加载失败共用）：加载零依赖静态错误页替换空白 bundle + 强制呈现 +
  // 系统对话框 + fatal 日志。必置 finalized 停用健康门，否则静态错误页自身的 did-finish-load 会再武装 → loadURL 死循环。
  const enterTerminalFallback = (title: string, message: string) => {
    if (terminalEntered) return; // N1 幂等：已进终局则早退，防重复 dialog/loadURL
    terminalEntered = true;
    mountGateState = { ...mountGateState, finalized: true };
    if (mountTimer) {
      clearTimeout(mountTimer);
      mountTimer = null;
    }
    // 退出管线中不弹对话框/不重载（与 render-process-gone 同守卫）：退出期窗口在拆、加载常被取消，兜底纯噪音。
    if (isQuitting || !gateWin || gateWin.isDestroyed()) return;
    logManager.addLog('fatal', `主窗兜底：${title} — ${message}`, 'Main');
    gateWin.webContents
      .loadURL(
        fatalErrorPageDataUrl({
          title,
          message,
          reloadLabel: '重新加载 / Reload',
          retryChannel: IPC_CHANNELS.FATAL_RETRY, // 按钮经此通道请主进程 loadFile 真实应用（绕 data: 导航拦截）
        })
      )
      .catch(() => {});
    if (!gateWin.isVisible()) gateWin.show(); // 强制呈现：让用户至少看到反馈而非纯底
    gateWin.focus();
    dialog.showErrorBox(title, message);
  };

  const runMountGate = (event: Parameters<typeof reduceMountGate>[1]) => {
    // 退出管线中不动作（reload/兜底纯噪音）；甄别本窗 + 存活：窗口已换 / 已销毁的迟到事件一律丢弃（防多窗/重建串味）。
    if (isQuitting || !gateWin || gateWin.isDestroyed() || gateWin !== mainWindow) return;
    const { state, action } = reduceMountGate(mountGateState, event);
    mountGateState = state;
    switch (action) {
      case 'arm':
        if (mountTimer) clearTimeout(mountTimer);
        // N3：超时/reload/fatal 升级链**仅生产武装**。dev 下 vite 未起 / 迭代期 render bug 由 vite overlay + devtools
        // 兜住，若也武装会在 ~24s 后弹终局 dialog 盖掉 overlay。console-message 转发无害，保留（见下）。
        mountTimer = isDevelopment
          ? null
          : setTimeout(() => runMountGate('timeout'), RENDERER_READY_TIMEOUT_MS);
        break;
      case 'clear':
        if (mountTimer) {
          clearTimeout(mountTimer);
          mountTimer = null;
        }
        logManager.addLog('info', 'Renderer mount ready (RENDERER_READY)', 'Main');
        break;
      case 'reload':
        if (mountTimer) {
          clearTimeout(mountTimer);
          mountTimer = null;
        }
        logManager.addLog(
          'error',
          `Renderer mount timeout (${RENDERER_READY_TIMEOUT_MS}ms, no RENDERER_READY) → reloading once`,
          'Main'
        );
        gateWin.webContents.reload(); // did-finish-load 将再触发 → reduceMountGate 自动重新武装（不叠加计时器）
        break;
      case 'fatal':
        enterTerminalFallback(
          'FlowZ 界面无响应 / Interface not responding',
          '界面重复加载失败，已停止自动重试；请尝试重新加载或重启 FlowZ。/ The interface repeatedly failed to load. Please reload or restart FlowZ.'
        );
        break;
      case 'none':
        break;
    }
  };

  // RENDERER_READY：用 webContents.ipc（本 webContents 私有 IpcMain）而非全局 ipcMain.handle——per-window 天然按窗
  // 甄别、跨 reload 存活（reload 不销毁 webContents）、随 webContents 销毁自动清理，且避免窗口重建时全局 handle 重复
  // 注册报错。renderer 用 invoke（preload 未暴露单向 send），故用 .handle（fire-and-forget，返回 undefined）。
  gateWin.webContents.ipc.handle(IPC_CHANNELS.RENDERER_READY, () => {
    runMountGate('rendererReady');
    return undefined;
  });
  // 终局错误页「重新加载」（L3）：主进程复位健康门 + 对本窗重新 loadFile 真实应用。经主进程 loadFile 绕开 Chromium
  // 对 data: 顶层导航/reload 的拦截（错误页是 data: 页，自身 location.reload 恢复不了应用）。复位后重新监护该次加载。
  gateWin.webContents.ipc.handle(IPC_CHANNELS.FATAL_RETRY, () => {
    if (!gateWin || gateWin.isDestroyed()) return undefined;
    mountGateState = initialMountGateState();
    terminalEntered = false;
    if (mountTimer) {
      clearTimeout(mountTimer);
      mountTimer = null;
    }
    logManager.addLog('info', 'Fatal error page retry → reloading app', 'Main');
    loadAppContent(gateWin);
    return undefined;
  });
  // did-finish-load 每次 load（含 reload）都触发，是**唯一武装点**（reduceMountGate 保证 reload 后自动重武装、不叠加）；
  // 与上方 presentWindow 的 .once('did-finish-load') 各自独立，互不干扰。
  gateWin.webContents.on('did-finish-load', () => runMountGate('loadFinished'));
  gateWin.once('closed', () => {
    if (mountTimer) clearTimeout(mountTimer);
    mountTimer = null;
  });

  // ── GAP-1c 可观测性：转发 renderer console 错误到 app.log ──────────────────────────────────────────
  // renderer 未捕获错误 / 主动 console.error（含 main.tsx 全局 handler 与 mount 兜底注入）是「进程活着但可能 DOM 空」的
  // 可观测信号——Electron 不发主进程事件。限频（防错误风暴刷爆 logManager）+ 截断（防超长 message 撑爆单行）。
  // Electron ^42 的 console-message 回调签名为 details 对象（level 是 'info'|'warning'|'error'|'debug' 字符串，
  // 旧的 (event,level:number,message,line,sourceId) 位置参数已 deprecated）。只转 error 级。
  let consoleForwardTimes: number[] = [];
  gateWin.webContents.on('console-message', (details) => {
    if (details.level !== 'error') return;
    const now = Date.now();
    const { recent, admit } = admitConsoleMessage(consoleForwardTimes, now);
    consoleForwardTimes = recent;
    if (!admit) return;
    logManager.addLog('error', `[renderer] ${truncateConsoleMessage(details.message)}`, 'Renderer');
  });

  // 处理窗口加载错误：仅主 frame 失败才有白屏风险（子 frame/资源失败不算）；ERR_ABORTED 是正常导航取消，忽略。
  // 首次主 frame 加载失败自动 reload 一次（覆盖瞬态失败）；二次仍失败 → 终局静态错误页 + 对话框（GAP-3），
  // 避免旧实现「二次失败只记日志、窗口持续空白」。首次 reload / 二次终局两态由 mainFrameLoadRetried 协调。
  let mainFrameLoadRetried = false;
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
      logManager.addLog(
        'error',
        `Window failed to load: ${errorDescription} (${errorCode})`,
        'Main'
      );
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!mainFrameLoadRetried) {
        mainFrameLoadRetried = true;
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        }, 500);
      } else if (!isDevelopment) {
        // 二次主 frame 失败（生产）：不再空转 reload，落终局兜底（与 GAP-1a 二次超时共用 enterTerminalFallback）。
        // 与 N3 一致，dev **不**弹终局模态：dev 下 vite 未起是常见工作流，Chromium 原生连接错误页 + devtools 更利排障。
        enterTerminalFallback(
          'FlowZ 加载失败 / Failed to load',
          `界面加载重复失败（${errorDescription}）；请检查安装完整性或重启 FlowZ。/ The interface repeatedly failed to load (${errorDescription}). Please check the installation or restart FlowZ.`
        );
      }
    }
  );

  // 渲染进程崩溃（OOM kill / GPU 驱动重置 / Chromium 内部崩溃）：窗口对象仍存活（isDestroyed()===false）但
  // renderer 无帧输出 → 窗口只剩 backgroundColor 纯底 + OS 绘制的标题栏按钮；而 showWindow/ensureWindow 只查
  // isDestroyed() 会误判其健康 → 永不自愈（关窗保活档下隐藏期崩溃尤其致命：重开即空白，需彻底重启）。
  // 治本：销毁窗口，让 isDestroyed() 健康门自然触发冷重建。可见态立即重建+显示（带 skeleton=重载观感而非空白）；
  // 隐藏态不急重建，下次 showWindow/托盘唤出经 ensureWindow 天然冷重建，省隐藏期资源。
  const rpgWindow = mainWindow; // 捕获注册时的窗口：陈旧事件（旧 webContents 迟到）不误伤已替换的新窗
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    // 退出管线中 renderer 先亡（reason=clean-exit/killed）→ 不重建，避免与 will-quit 清理竞态/退出中闪窗。
    if (isQuitting) return;
    const win = mainWindow;
    if (!win || win !== rpgWindow || win.isDestroyed()) return;
    const wasVisible = win.isVisible();
    const { recent, isLoop } = detectRenderCrashLoop(renderGoneTimestamps, Date.now());
    renderGoneTimestamps = recent;
    logManager.addLog(
      'error',
      `主窗渲染进程终止（reason=${details.reason}, exitCode=${details.exitCode}, visible=${wasVisible}${isLoop ? ', 崩溃循环' : ''}）→ ${isLoop ? '停止自动重建' : '冷重建'}`,
      'Main'
    );
    // GAP-4 + L4：销毁窗口后**不会自动重建**的两种情形——崩溃循环停建（isLoop），或隐藏态非 loop（不立即重建、
    // 等下次显式唤出）——若又无托盘（无 UI 可唤出），进程就成了无窗无托盘的僵尸。故仅当「本次不会重建」时，用与
    // close 分支（:1019-1023）同款谓词判定，无托盘该退出则**销毁前**置 pendingQuitOnAllClosed，供随后 window-all-closed
    // 消费退出；有托盘则维持现状（托盘唤出手动重试）。可见态非 loop 会立即 ensureWindow 重建、窗口计数不归零，不需处理。
    const willRebuild = !isLoop && wasVisible;
    if (!willRebuild) {
      const minimizeToTray = configManager.get<boolean>('minimizeToTray') ?? true;
      if (
        shouldQuitOnAllWindowsClosed(process.platform, minimizeToTray, !!trayManager?.hasTray())
      ) {
        pendingQuitOnAllClosed = true;
      }
    }
    releaseWindowMemory({ window: win, logManager, reason: 'render-gone' }); // destroy → 'closed' 置 mainWindow=null
    // 60s 内崩溃 >3 次判为崩溃循环（损坏安装/持续 OOM）：停止自动重建防 CPU 空转，用户经托盘/重启手动重试。
    if (isLoop) return;
    if (wasVisible) void ensureWindow(true); // 可见态立即重建并显示；隐藏态延后到下次显式唤出
  });

  // GPU / utility 子进程崩溃：多数不直接致主窗空白（Chromium 常自恢复），但原先零痕迹；留日志供排障。仅注册一次。
  if (!childProcessGoneBound) {
    childProcessGoneBound = true;
    app.on('child-process-gone', (_event, details) => {
      logManager.addLog(
        'warn',
        `子进程终止（type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}）`,
        'Main'
      );
    });
  }

  // macOS：Cmd+H（app.hide()）系统级隐藏、或关窗保活档（minimizeToTray）走 window.hide() 时摘 Dock 图标（仅驻留
  // 菜单栏，不占 Dock / Cmd-Tab），重新显示时恢复。两条路径都触发 'hide' → 本钩子摘 Dock；仅真退出档（shouldQuit）
  // 走 destroy，由模块级 browser-window-created 的 'closed' 监听器摘。经 activation policy 状态机（见
  // hideDockIfMenubarOnly/restoreDockPresence）。
  if (process.platform === 'darwin') {
    mainWindow.on('hide', () => {
      // 经 accessory + app.hide() 摘 Dock 图标（机制与 macOS 限制见 hideDockIfMenubarOnly）。
      if (!isQuitting) hideDockIfMenubarOnly();
    });
    mainWindow.on('show', () => {
      // 兜底：未经 showWindow 的直接 show()（ready-to-show / 托盘 helper 引导）也恢复 Dock 图标
      restoreDockPresence();
    });
  }

  // 处理窗口关闭事件：默认保活（隐藏到托盘，reopen=show() 即显，恢复 4.1.8 语义）——隐藏态
  // 推送归零、水位死平（异常增长有 renderer-memory watchdog 兜底），无需靠关窗销毁渲染进程重置水位（d6ae203
  // 的收益已冗余，代价是 100% reopen 冷重建，见 #251）。仅当 shouldQuitOnAllWindowsClosed
  // （minimizeToTray=false / 无托盘非 mac）才 destroy + 退出（避免无窗口无托盘的僵尸进程）；是否退出在销毁的
  // 这一刻就算好存进 pendingQuitOnAllClosed（仅 destroy 分支写），供 window-all-closed 消费。
  mainWindow.on('close', (event) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    // 退出管线（Cmd+Q/Dock/托盘退出 → app.quit() → before-quit 置 isQuitting）：放行默认销毁，
    // 不再 preventDefault→hide，否则 macOS 上 quit 会被吞成"隐藏"、will-quit 清理永不执行（根因 A）。
    if (isQuitting) return;

    event.preventDefault();
    const minimizeToTray = configManager.get<boolean>('minimizeToTray') ?? true;
    const shouldQuit = shouldQuitOnAllWindowsClosed(
      process.platform,
      minimizeToTray,
      !!trayManager?.hasTray()
    );
    if (shouldQuit) {
      // minimizeToTray=false / 无托盘非 mac → 销毁渲染进程 + 退出。pendingQuitOnAllClosed 仅在此 destroy 分支
      // 就地写入，供随后 window-all-closed 消费最后一次值（无陈旧读：每条 destroy 路径销毁前都重算）。
      pendingQuitOnAllClosed = true;
      releaseWindowMemory({ window, logManager, reason: 'close' });
    } else {
      // 保活：隐藏到托盘，reopen 走 show() 即显（无冷重建死区）。'hide' 事件由上方 macOS 钩子消费摘 Dock；
      // hide 不减窗口计数、不触发 window-all-closed，故 pendingQuitOnAllClosed 保持不动。
      window.hide();
      logManager.addLog('info', 'Window hidden to tray', 'Main');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (trayManager) {
      trayManager.setMainWindow(null);
    }
    proxyManager?.setMainWindow(null);
    updateService?.setMainWindow(null);
    // 轻量 destroy 的 Dock 摘除由模块级 browser-window-created → 'closed' 钩子统一处理（不在此重复）。
    logManager.addLog('info', 'Main window closed', 'Main');
  });

  // Windows 系统注销/关机：BrowserWindow 的 win32 'session-end' 是真实事件（app 不发它）。
  // 同步兜底关掉系统代理，防注销/关机后注册表代理残留致重启断网。
  mainWindow.on('session-end', () => {
    if (!gotTheLock) return;
    logManager.addLog('warn', 'OS session-end detected, syncing cleanup', 'Main');
    syncCleanupOnExit();
  });
}

/**
 * 清理应用资源
 * 在应用退出前调用，确保清理系统代理和终止进程
 */
async function cleanupResources(): Promise<void> {
  // 幂等 + 并发安全：多入口共享同一次清理 promise——并发第二入口 await 同一进行中清理，不截断。
  // 注意：更新流程不走这里（改用非终态的 runCleanup），避免安装失败后 app 续命却把一次性清理标记毒化。
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      // 整体 try/catch 兜底：退出清理 promise 永不 reject——否则 memoize 会把 rejected 态钉死，
      // 令并发 await 它的 SIGTERM/SIGINT handler 抛错、吞掉 process.exit。logManager 在 ready 前可能未就绪 → 可选链。
      try {
        logManager?.addLog('info', 'Cleaning up resources before exit...', 'Main');
        let timer: ReturnType<typeof setTimeout> | undefined;
        // 限时：退出清理 ≤8s 硬上限，超时则放弃继续退出 —— 绝不让清理无限阻塞退出。
        await Promise.race([
          runCleanup(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              logManager?.addLog('warn', 'Cleanup timed out (8s), proceeding to exit', 'Main');
              resolve();
            }, 8000);
          }),
        ]);
        if (timer) clearTimeout(timer); // 正常完成则清计时器，避免误导性的超时 warn
      } catch (e) {
        console.error('cleanupResources error:', e);
      }
    })();
  }
  return cleanupPromise;
}

async function runCleanup(): Promise<void> {
  try {
    // 0. 停止后台定时器（订阅调度 / 自动换节点 / 自动空闲轮询）
    if (idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
    subscriptionScheduler?.stop();
    coreUpdateScheduler?.stop();
    ruleResourceScheduler?.stop();
    autoSwitchService?.destroy();
    // T4：终止 stats utilityProcess（停 respawn + kill worker），避免退出后遗留子进程。
    statsService?.dispose();

    // 1. 拆除代理（去 status.running 门控：跨会话孤儿 / 隐藏会话残留也必须回收；退出语境零提权弹框）
    if (proxyManager) {
      logManager.addLog('info', 'Tearing down proxy for quit...', 'Main');
      await proxyManager.teardownForQuit();
      logManager.addLog('info', 'Proxy torn down', 'Main');
    }

    // 2. 清理系统代理设置（marker 门控：仅关 FlowZ 自己设置的系统代理；TUN 模式 / 用户自配的企业/第三方
    //    代理无 marker → 不动，符合通用-E「仅 FlowZ 自己设置的才被强关」不变量。跨会话残留由 marker 兜）。
    try {
      const proxyStatus = await systemProxyManager.getProxyStatus();
      if (proxyStatus.enabled && SystemProxyBase.readMarker()) {
        logManager.addLog('info', 'Disabling system proxy...', 'Main');
        await systemProxyManager.disableProxy();
        logManager.addLog('info', 'System proxy disabled', 'Main');
      }
    } catch (error) {
      // 系统代理清理失败不应阻止应用退出
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `Failed to disable system proxy: ${errorMessage}`, 'Main');
      console.warn('Failed to disable system proxy:', error);
    }

    // 2.5 还原系统 DNS（marker 门控：仅还原 FlowZ 接管过的；非 TUN / 无接管无 marker → 不动）。
    //     与系统代理同级：跨会话残留由启动期 marker 恢复兜，正常退出由此还原。
    try {
      if (systemDnsManager?.hasMarker()) {
        logManager.addLog('info', 'Restoring system DNS...', 'Main');
        await systemDnsManager.restoreDns();
        logManager.addLog('info', 'System DNS restored', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `Failed to restore system DNS: ${errorMessage}`, 'Main');
    }

    logManager.addLog('info', 'Resource cleanup completed', 'Main');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Error during cleanup: ${errorMessage}`, 'Main');
    console.error('Error during cleanup:', error);
  }
}

/**
 * 导出托盘管理器（用于测试）
 */
export function getTrayManager(): TrayManager | null {
  return trayManager;
}

async function updateTrayMenuState(isProxyRunning: boolean, hasError?: boolean): Promise<void> {
  if (!trayManager) return;

  try {
    const config = await configManager.loadConfig();
    trayManager.updateFullTrayMenu({
      isProxyRunning,
      hasError,
      servers: config.servers,
      subscriptions: config.subscriptions || [],
      selectedServerId: config.selectedServerId,
      proxyMode: config.proxyMode,
      proxyModeType: config.proxyModeType,
    });

    trayManager.updateTrayIcon(isProxyRunning ? 'connected' : 'idle');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Failed to update tray menu state: ${errorMessage}`, 'Main');
  }
}

if (gotTheLock) {
  // app ready 前注册图标代理 scheme（privileged）：renderer 外部图标 <img> 经 flowz-icon:// 由 main update-in 拉取
  registerIconProtocolSchemes();
  app.whenReady().then(async () => {
    startupMark('whenReady');
    // Windows 便携自更新遗留的 .exe.old（旧版本被 stub 锁、上次 rename 挪开的）→ 启动期清理（此刻无进程占用，可删）。
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      try {
        const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
        for (const f of selectPortableStaleOld(fs.readdirSync(portableDir))) {
          try {
            fs.unlinkSync(path.join(portableDir, f));
          } catch {
            /* 仍被占用 → 下次启动再清 */
          }
        }
      } catch {
        /* readdir 失败忽略 */
      }
    }
    // 初始化服务
    configManager = new ConfigManager();
    protocolParser = new ProtocolParser();
    logManager = new LogManager();
    systemProxyManager = createSystemProxyManager();
    systemDnsManager = createSystemDnsManager();
    updateService = new UpdateService(logManager);
    coreUpdateService = new CoreUpdateService(logManager);
    subscriptionService = new SubscriptionService(protocolParser, logManager);
    // 注入全协议出站构造器（懒引用 proxyManager，测速时才调用、此时其已就绪）：测速统一走经代理 urltest 真实测速。
    // §15：另注入主核测速探测池句柄取值器（call-time 懒引用，对齐 exitProbeLatencyRunner 装配风格）——主核运行 +
    // 池就绪时测速走主核（同核单会话消除 WG/WARP 双会话超时），否则回退临时核（buildSpeedTestOutbound 路径）。
    // §15.11：另注入核生命周期世代取值器（call-time 拉 getLifecycleGeneration）——测速起测快照 gen0，核 start/stop/
    // restart/config-regen 中途跃迁即超代 abort（保留已测、未测节点不写假 -1）。缺省不注入=恒不超代（回归安全）。
    speedTestService = new SpeedTestService(
      logManager,
      (s, tag) =>
        proxyManager
          ? (proxyManager.buildSpeedTestOutbound(s, tag) as Record<string, unknown> | null)
          : null,
      () => proxyManager?.getSpeedTestMainCoreProbe() ?? null,
      () => proxyManager?.getLifecycleGeneration() ?? 0
    );
    // 把日志 sink 注入「原本裸 console、不进 app.log」的服务，补排障盲区（系统代理/配置/资源/协议）
    configManager.setLogManager(logManager);
    protocolParser.setLogManager(logManager);
    systemProxyManager.setLogManager(logManager);
    systemDnsManager.setLogManager(logManager);
    resourceManager.setLogManager(logManager);
    logManager.addLog('info', 'Application started', 'Main');

    // Windows toast 前置：设 AppUserModelID（与 electron-builder appId 一致），提升 portable 版通知可靠性（无 NSIS 注册时）。
    if (process.platform === 'win32') app.setAppUserModelId('com.flowz.app');
    // 主进程 i18n 初值先按系统偏好兜底（config 加载完成前的极短窗口，覆盖任何早于配置读取的 mt() 调用）。
    setMainLanguage(resolveAutoLanguage(getPreferredSystemLanguagesSafe()));
    // 桌面通知总开关初始同步（运行期变更由 config-change-handler 同步）。await 确保 enabled 在后续启动步骤
    // （含 proxy 自动连接，error 通知的唯一来源）前就绪——此刻 proxy 未启动，error 不会触发，无竞态；读配置毫秒级。
    // 同一次 loadConfig 顺带据 config.language 单一真值源精化界面语言（auto→系统解析；存量缺键退回系统，
    // 与上面兜底一致，待渲染端从 localStorage 迁移回填 config 后下次启动即精确）——主进程不再靠渲染端 IPC 告知语言。
    await configManager
      .loadConfig()
      .then((c) => {
        setMainLanguage(resolveEffectiveLanguage(c.language, getPreferredSystemLanguagesSafe()));
        setDesktopNotificationsEnabled(c.desktopNotifications);
      })
      .catch(() => {});

    // 启动期系统代理 marker 恢复：上次会话崩溃/强杀/断电导致 disableProxy 未执行时 marker 残留，
    // 实查系统代理仍指向我们（127.0.0.1:<记录端口>，或 host 匹配兜 mac socks 端口差异）则拆除，
    // 防用户重启后代理指向死端口断网。指向校验防 stomp 用户自配的本地代理；
    // marker 在但代理已非我们 → 只清 marker（否则退出门控永远放行、每次退出误关用户代理）。
    // 常规路径成本仅一次同步 ENOENT 读（无 marker 即跳过），不阻塞启动。
    try {
      const marker = SystemProxyBase.readMarker();
      if (marker) {
        const status = await systemProxyManager.getProxyStatus();
        const markerHost = marker.ourHostPort.split(':')[0];
        const candidates = [status.httpProxy, status.httpsProxy, status.socksProxy].filter(
          (p): p is string => !!p
        );
        const pointsToUs = candidates.some(
          (p) => p === marker.ourHostPort || p.split(':')[0] === markerHost
        );
        if (status.enabled && pointsToUs) {
          logManager.addLog(
            'warn',
            `检测到上次会话残留的系统代理(${marker.ourHostPort})，正在拆除...`,
            'Main'
          );
          await systemProxyManager.disableProxy(); // 拆除成功后内部 clearMarker
          logManager.addLog('info', '残留系统代理已拆除', 'Main');
        } else {
          // marker 失效（代理未启用 / 已被用户改走）→ 只清 marker，不动系统设置
          SystemProxyBase.clearMarkerFile();
          logManager.addLog('info', '清理失效的系统代理 marker（当前代理未指向本应用）', 'Main');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `启动期系统代理 marker 恢复失败: ${errorMessage}`, 'Main');
    }

    // 启动期系统 DNS marker 恢复：上次会话崩溃/强杀导致 restoreDns 未执行时 marker 残留 → 把系统 DNS 还原为
    // 接管前原始值（marker.original，[]→DHCP）。受控 IP 是真实可路由的 8.8.8.8，崩溃窗口内系统 DNS 仍能解析
    // （只是少了 FakeIP），故此处还原非断网急救而是恢复用户原配置。常规路径仅一次同步 ENOENT 读（无 marker 即跳过）。
    try {
      if (SystemDnsBase.readMarker()) {
        logManager.addLog('warn', '检测到上次会话残留的系统 DNS 接管，正在还原...', 'Main');
        await systemDnsManager.restoreDns(); // 还原成功后内部 clearMarker
        logManager.addLog('info', '残留系统 DNS 已还原', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `启动期系统 DNS marker 恢复失败: ${errorMessage}`, 'Main');
    }

    // macOS: 禁用 App Nap，防止系统认为应用"没有响应"
    // 当应用在后台运行代理时，App Nap 会导致系统误判应用状态
    if (process.platform === 'darwin') {
      const { powerSaveBlocker } = require('electron');
      powerSaveBlocker.start('prevent-app-suspension');
    }

    // macOS Dock 图标用 bundle 内置 icon.icns（已为透明球图标）；不再运行期 setIcon 覆盖，
    // 避免「启动后图标从带背景切成透明」的可见跳变（带背景仅来自旧图标的系统图标缓存，已透明化）。

    // 加载配置并处理错误
    try {
      const config = await configManager.loadConfig();
      startupMark('configLoaded');
      // 让 config.logLevel 对 LogManager 生效：原本 LogManager 恒留默认 'info'，config 设的 FATAL 形同虚设
      // （设置页改 logLevel 走 CONFIG_SAVE，从不经 IPC 调 setLogLevel；原 LOGS_SET_LEVEL IPC 链路已作为死代码移除）→ 设 FATAL 仍刷屏非 FATAL。
      // 经 effectiveLogLevel：隐私模式开时抬到 ≥warn，app.log 与 sing-box 一同收敛连接明细。
      logManager.setLogLevel(effectiveLogLevel(config.logLevel || 'info', getPrivacyMode()));
      logManager.addLog('info', 'Configuration loaded successfully', 'Main');

      if (config.servers.length === 0 && config.selectedServerId === null) {
        // 这可能是首次启动或配置文件损坏
        logManager.addLog('warn', 'Using default configuration', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('error', `Failed to load configuration: ${errorMessage}`, 'Main');

      dialog.showErrorBox(
        '配置加载失败',
        `无法加载配置文件，将使用默认配置。\n\n错误信息: ${errorMessage}`
      );
    }

    // 静默启动（config.silentStart / --hidden / macOS wasOpenedAsHidden）不创建渲染进程：窗口在首次唤出
    // （托盘/Dock/second-instance → showWindow）时懒创建，避免整个 Chromium 渲染进程从开机起空占内存
    // （等价于「开机即进轻量模式」，与关窗释放后的 tray-resident 态同构）。此时 mainWindow 保持 null——启动
    // 后续代码已容忍该态（proxyManager 构造 mainWindow||undefined、升级检查 setTimeout 兜底、各 getMainWindow
    // getter 懒取）。configManager.get 读 1120 行已加载的内存缓存（同步、不重复读盘）。
    const startsHidden =
      configManager.get<boolean>('silentStart') === true ||
      process.argv.includes('--hidden') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);
    if (startsHidden) {
      logManager.addLog('info', 'Silent start: deferring window creation to first show', 'Main');
      // macOS：无窗口时主动进入菜单栏-only（原静默分支在 presentWindow 内做，现无窗口 → 在此做）；
      // 首次唤出 showWindow 会 restoreDockPresence 复原。
      if (process.platform === 'darwin') hideDockIfMenubarOnly();
    } else {
      await ensureWindow(); // 走串行化入口，与 activate/托盘/second-instance 共享创建
    }

    // 初始化 ProxyManager（懒创建静默启动窗口时 mainWindow 为 null → undefined，首次建窗经 setMainWindow 刷新）
    proxyManager = new ProxyManager(logManager, mainWindow || undefined);
    // 隐私联动：隐私模式开 → sing-box 日志级别抬到 ≥warn（源头不记访问域名/SNI 到 singbox.log）
    proxyManager.setPrivacyProvider(getPrivacyMode);
    coreUpdateService.setProxyManager(proxyManager);
    coreUpdateService.setConfigProvider(() => configManager.loadConfig());
    // #60：App 自更新下载兜底镜像也用用户配置的 ghProxyPrefix（与内核/资源下载同一加速前缀，口径对齐）。
    updateService.setConfigProvider(() => configManager.loadConfig());
    // Phase 1（更新网络统一层）：更新链路（检查/资源/应用）统一会话层——独立 partition 会话按 mainSessionViaProxy
    // ×proxyRunning 选经代理(socks 入站)/直连，取代裸 net.request 走 default session。proxyManager 已就绪。
    const updateNetwork = new UpdateNetwork();
    // 主更新链路 viaProxy/port 决策 providers 一次注入 UpdateNetwork（共享 configManager/proxyManager）；
    // UpdateService/RuleResourceManager/CoreDownloader 三处只调 resolveSessionForMainUpdate，不再各自重复决策（防漂移）。
    updateNetwork.setMainUpdateProviders({
      configProvider: () => configManager.loadConfig(),
      proxyRunningProvider: () => proxyManager?.getStatus().running ?? false,
      updateInPortProvider: () => proxyManager?.getUpdateInPort() ?? null,
    });
    updateService.setUpdateNetwork(updateNetwork);
    // §8 四链路收口：订阅经代理也 pin 到 update-in（socks），与应用更新/资源链路统一经核 route 按 proxyMode 决策。
    subscriptionService.setUpdateInPortProvider(() => proxyManager?.getUpdateInPort() ?? null);
    // §8 四链路收口：核更新链路（CoreDownloader）也接入 update-in；viaProxy 时经 update-in，否则 direct 兜底（自举）。
    coreUpdateService.setUpdateNetwork(updateNetwork);
    // Phase 1b §8：图标代理协议 flowz-icon:// 也经 update-in（renderer 外部图标 <img> 不再走 default session）。
    registerIconProtocol({
      updateNetwork,
      proxyRunningProvider: () => proxyManager?.getStatus().running ?? false,
      updateInPortProvider: () => proxyManager?.getUpdateInPort() ?? null,
      configProvider: () => configManager.loadConfig(),
      logManager,
    });
    // 后台预热内核版本缓存（getCoreVersion 写 this.coreVersion）：使「关于」页**首次**进入也命中缓存、
    // 不再临时 spawn `sing-box version` 子进程导致加载转圈。
    // 延后 ~5s 触发（C2）：spawn 50MB sing-box.exe 会再触发一次 AV 扫描，与 Windows portable 冷启动的自解压 + AV
    // 扫描抢盘 I/O；延后避开冷启动高峰。fire-and-forget 不阻塞启动；延时内进「关于」则 IPC 走 on-demand
    // getCoreVersion（同成本，非回归）；启动代理时(:716 force) 亦会刷新。
    setTimeout(() => void proxyManager?.getCoreVersion().catch(() => {}), 5000);
    // 内核自动更新状态/成功提示经事件推渲染端（staged 待生效 / 跨带提示 / 落位成功复用 banner）
    coreUpdateService.setEventSender((channel, payload) =>
      ipcEventEmitter.sendToAll(channel, payload)
    );

    // 提权 helper：装一次后 TUN 模式启停 sing-box 免提权；未装则回退平台提权路径（macOS osascript / Windows UAC / Linux setcap）。
    // 平台实现：Windows=WindowsServiceHelper、Linux=LinuxServiceHelper、macOS=macHelper（供 ProxyManager 路由 / 引导门控 / IPC）。
    // 互不进入对方分支 → 跨平台零回归。CoreUpdateService 的 install-core 消费者：mac→macHelper、linux→linuxHelper（均有
    // installCore 写 root 受保护/受管核目录）；Windows 无 install-core，核更新走 UAC 直写、不调用。
    const macHelper = new HelperManager(logManager);
    const linuxHelper = process.platform === 'linux' ? new LinuxServiceHelper(logManager) : null;
    helperManager =
      process.platform === 'win32'
        ? new WindowsServiceHelper(logManager)
        : (linuxHelper ?? macHelper);
    proxyManager.setHelperManager(helperManager);
    coreUpdateService.setHelperManager(linuxHelper ?? macHelper);
    proxyManager.setHelperGate(promptHelperGate);
    // 启动后检测 helper 是否可升级（已装 proto < 期望，如属主根治 v6）→ 发事件让渲染端 toast 主动引导升级
    // （否则用户不去设置页就不知道要升级、根治不生效）。**跟随渲染端首屏加载完成**再发；但单次定时发射有竞态：
    // 若首屏 React 挂载 + useNativeEventListeners 注册监听慢于固定延迟，事件先于 listener 订阅 → toast 静默丢失无重试。
    // 改为**有限次重复发射**（递增间隔跨越慢首屏窗口）：即便某次发射时 listener 尚未订阅而丢失，后续几次会补上；
    // 渲染端 handleHelperUpgradeable 自带 helperUpgradeWarnedThisSession 幂等守卫，重复收到只 toast 一次（重发安全）。
    // dismiss 已置 / 明确不可升级 → 'skip' 立即终止重发。返回 'emitted'（已发，仍续发覆盖窗口）| 'skip'（终止）| 'retry'。
    const tryEmitHelperUpgradeable = async (): Promise<'emitted' | 'skip' | 'retry'> => {
      try {
        if (!helperManager) return 'skip';
        const cfg = await configManager.loadConfig().catch(() => null);
        if (cfg?.helperUpgradePromptDismissed === true) return 'skip';
        const st = await helperManager.getStatus();
        if (st.upgradeable) {
          ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_HELPER_UPGRADEABLE, {
            version: st.version ?? '',
          });
          return 'emitted';
        }
        return 'skip'; // 明确不可升级 → 不再重试
      } catch {
        return 'retry'; // 瞬时失败（status 未就绪等）→ 退避重试
      }
    };
    // did-finish-load（HTML/JS 加载完）后启动重试序列。首发 ~1.2s 给 React 挂载 + 事件 hook 注册的常见窗口；
    // 之后每 ~1.5s 再发一次，至多 5 次（≈1.2s/2.7s/4.2s/5.7s/7.2s），覆盖首屏慢于 1.2s 的尾部场景而不无限重发。
    const UPGRADE_EMIT_MAX_ATTEMPTS = 5;
    const fireUpgradeCheck = (): void => {
      let attempt = 0;
      const schedule = (delay: number): void => {
        setTimeout(() => {
          void tryEmitHelperUpgradeable().then((r) => {
            attempt += 1;
            // 'skip'（dismiss / 明确不可升级）立即终止；'emitted'（已发）与 'retry'（瞬时失败）都在配额内续发，
            // 跨越首屏 listener 注册窗口 → 即便首发丢失后续补上（渲染端幂等守卫吸收重复，只 toast 一次）。
            if (r !== 'skip' && attempt < UPGRADE_EMIT_MAX_ATTEMPTS) schedule(1500);
          });
        }, delay);
      };
      schedule(1200);
    };
    const wcForUpgrade = mainWindow?.webContents;
    if (wcForUpgrade && !wcForUpgrade.isLoading()) fireUpgradeCheck();
    else if (wcForUpgrade) wcForUpgrade.once('did-finish-load', fireUpgradeCheck);
    else setTimeout(fireUpgradeCheck, 1500); // mainWindow 尚未创建时的兜底
    // 系统代理单一写者：注入同一 singleton（上方 756 创建），enable/clear 统一收口 ProxyManager.start()/终态。
    proxyManager.setSystemProxyManager(systemProxyManager);
    // 系统 DNS 接管单一写者：注入同一 singleton，set（仅 TUN）/restore 统一收口 ProxyManager.start()/终态。
    proxyManager.setSystemDnsManager(systemDnsManager);

    // 平台提权服务（T16：纯函数/无状态方法 + killOrphans 链迁出 ProxyManager/CoreUpdateService，delegate 后调用点零改动）。
    // ctx.log 桥接两端 source：ProxyManager 侧 logToManager 默认 'ProxyManager'（编排维度，内核 stdout 经 parseAndLogLine 传 'sing-box'），CoreUpdateService 侧透传 'CoreUpdateService'。
    // ctx 各只读回调指向 proxyManager 私有 getter（isTunMode/configPath/singboxPath/currentManagedPid/isProcessAlive/waitForNetworkCleanup），
    // service 不直接访问 ProxyManager 内部状态。
    // helperManager 可为 null（未装时 macOS 分支回退 osascript）。
    const privilegeService = new PlatformPrivilegeService(
      {
        log: (level, message, source) => logManager.addLog(level, message, source ?? 'sing-box'),
        isTunMode: () => proxyManager?.isTunModeNow() ?? false,
        isInteractive: () => proxyManager?.isStartInteractive() ?? true,
        configPath: () => proxyManager?.getConfigPath() ?? '',
        singboxPath: () => proxyManager?.getSingboxPath() ?? '',
        currentManagedPid: () => proxyManager?.getCurrentManagedPid() ?? null,
        isProcessAlive: (pid) => proxyManager?.isProcessAlive(pid) ?? false,
        waitForNetworkCleanup: async () => {
          await proxyManager?.waitForNetworkCleanup();
        },
        // T16 子 commit 3：stopElevated 用
        startedViaHelper: () => proxyManager?.isStartedViaHelper() ?? false,
        stopFlagPath: () => proxyManager?.getStopFlagPath() ?? '',
        waitForProcessExit: (pid, timeout) =>
          proxyManager?.waitForProcessExit(pid, timeout) ?? Promise.resolve(true),
        onStopAuthCancelled: () => {
          // 镜像原 forceKillOrReportCancelled 内联的 sendEventToRenderer(STOP_AUTH_CANCELLED)：
          // service 不持 IPC 通道，经回调把「取消授权→发非终态提示」交还 ProxyManager。
          proxyManager?.notifyStopAuthCancelled();
        },
      },
      macHelper
    );
    proxyManager.setPrivilegeService(privilegeService);
    coreUpdateService.setPrivilegeService(privilegeService);

    // 流量统计（T4，issue #225）：StatsService 已拆入 utilityProcess（见 services/StatsWorkerHost + workers/stats-worker）。
    // 本宿主 fork/看护 worker、缓存最新快照、按 isUiBroadcastActive(可见 && !拖动) 门控后 sendToAll——把 Status/
    // Connections 长流的 per-frame 解析+物化移出主线程，消除拖动期事件循环争用。worker 据 getStatsApiEndpoint 重建
    // 自己的 gRPC client（端口随每次启动可能变 → 'api-client-ready' 时经 resubscribe 重发）。
    // §3.7：订阅驱动数据面。registry 持 topic→订阅 wc 集，订阅即回初始帧（合并原 CONNECTIONS_AGGREGATE_GET/
    // CONNECTIONS_GET 初值 pull）、只 relay 给对应 topic 订阅者、订阅变化即驱动 host demand。demand 源从「窗口可见」
    // (isUiActive) 换成「渲染端按 topic 订阅」——非首页可见视图（设置页）下拓扑/明细流亦停（无订阅者逐级停机）；
    // isUiActive 降为 relay 侧兜底安全门（订阅在但窗口不可见——如 Windows 拖动期——仍不发）。
    const statsSubscriptionRegistry = new StatsSubscriptionRegistry({
      // 订阅即回初始帧：取 host 缓存快照（核未起/未连时为零态，UI 自然落空态）。
      getInitialFrame: (topic: StatsTopic) => {
        if (topic === 'stats')
          return (
            statsService?.getSnapshot() ?? {
              uploadSpeed: 0,
              downloadSpeed: 0,
              totalUpload: 0,
              totalDownload: 0,
              activeConnections: 0,
            }
          );
        if (topic === 'aggregate')
          return (
            statsService?.getAggregateSnapshot() ?? {
              total: 0,
              hosts: [],
              outbounds: [],
              at: Date.now(),
            }
          );
        return statsService?.getConnectionsSnapshot() ?? { connections: [], at: Date.now() };
      },
      // 订阅/退订即时重算 worker demand（连接页一打开 detail 即开流、一关即停，不等下个 status 帧的惰性同步）。
      onDemandChange: () => statsService?.syncDemand(),
    });
    const statsHostOptions: StatsWorkerHostOptions = {
      workerPath: path.join(__dirname, 'workers', 'stats-worker.js'),
      // relay：只发给对应 topic 的订阅者（registry.broadcast）；host 侧已按 isUiActive 门控后才调这些。
      onStats: (stats) => statsSubscriptionRegistry.broadcast('stats', stats),
      onAggregate: (agg) => statsSubscriptionRegistry.broadcast('aggregate', agg),
      onDetail: (conns) => statsSubscriptionRegistry.broadcast('detail', conns),
      // relay 安全门（兜底，非 demand 源）：窗口不可见 / Windows 拖动中 → host 只缓存不 relay。
      isUiActive: isUiBroadcastActive,
      // demand 源（取代 isUiActive）：某 topic 是否有渲染端订阅者。
      hasSubscribers: (topic) => statsSubscriptionRegistry.hasSubscribers(topic),
      getEndpoint: () => proxyManager?.getStatsApiEndpoint() ?? null,
      log: (level, message) => logManager.addLog(level, message, 'StatsWorker'),
    };
    // 泄漏定证 harness（issue #242 §5）：FLOWZ_STATS_SIM 存在时用合成 churn 注入器取代真实 stats worker——直接向
    // UI 门控层灌 aggregate/stats（绕内核/流量/TUN），把 reporter 数天暴露压缩到小时级。dev-only，零业务行为变更；
    // StatsSimulator 构造内经 logManager 打「模拟器激活」warn banner + 解析防御。
    statsService = process.env.FLOWZ_STATS_SIM
      ? new StatsSimulator(statsHostOptions, process.env.FLOWZ_STATS_SIM)
      : new StatsWorkerHost(statsHostOptions);
    // 杀核前静默 StatsService：停其到管理 API 的 Status/Connections gRPC 流（核将死，提前 cancel 避免 RST 噪音）。
    proxyManager.setQuiesceStats(() => {
      statsService?.stop();
    });

    // 出口伴测 runner：代理出口探测成功后测「当前出口」warm TTFB（== 节点测速口径）写回 latencyMap[当前出口 id]，
    // 使 IP 类 / TS / 组网出口的实际延迟跟随出口探测更新。五重守卫全过才测/才写（见 exit-probe-latency + 设计 §2.4）。
    // deps 全部 call-time 取值（trayManager 稍后才构造、closure 引用 module 变量、firing 时已就绪，规避初始化顺序）。
    const exitProbeLatencyRunner = createExitProbeLatencyRunner({
      getSelectedExit: () => {
        const pm = proxyManager;
        if (!pm) return null;
        const status = pm.getStatus();
        if (!status.running || !status.currentServer) return null; // G1 running / G2 有实际出口节点
        const mode = (configManager.get<string>('proxyMode') ?? 'smart').toLowerCase();
        if (mode === 'direct') return null; // G3 非全局直连（直连模式探针量的是直连路径）
        if (pm.isLoginFallbackEngaged()) return null; // G4 登录让位未生效（让位期 selector 实指 direct）
        if (pm.selectedTsExitBlock()) return null; // G5 TS gate 未命中（纵深防御 lateBlock 边缘）
        const ports = pm.getProbePorts();
        if (!ports) return null; // 探针端口就绪
        return { serverId: status.currentServer.id, probeProxyPort: ports.proxy };
      },
      measureWarmRtt: (port) =>
        speedTestService.measureWarmRttViaHttpProxy(
          port,
          configManager.get<string>('speedTestUrl')
        ),
      publish: (serverId, latency) => {
        // 复用测速结果既有传播管道：逐节点广播 EVENT_SPEED_TEST_RESULT → applyLatencyResults(latencyMap + 时间戳)；
        // 托盘合并入延迟表（keepTestingState：不复位在飞全量测速的「测速中」态）。渲染端零改动。
        ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT, { serverId, latency });
        trayManager?.updateSpeedTestResults(new Map([[serverId, latency]]), [], {
          toast: false,
          keepTestingState: true,
        });
      },
      // W1：unlock 轮 settle 信号（call-time 闭包——unlockService 在下方才构造，伴测触发时已就绪，同 trayManager 模式）。
      whenQuiet: (capMs) => unlockService?.whenIdle(capMs) ?? Promise.resolve(),
      log: (message) => logManager.addLog('debug', message, 'ExitProbeLatency'),
    });

    // 出口 IP 信息：经探针 inbound 测本地直连出口 / 代理出口，事件驱动刷新（无周期轮询）
    ipInfoService = new IpInfoService(
      () => proxyManager?.getProbePorts() ?? null,
      () => proxyManager?.getStatus().running ?? false,
      (snap) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_IP_INFO_UPDATED, snap),
      undefined,
      // TS 出口 API 直判无效（选中 TS 出口未广告出口设备 / exit peer 离线）→ 出口探测前置 gate 短路，不空转退避。
      () => proxyManager?.selectedTsExitBlock() ?? null,
      // 代理出口探测成功 → fire-and-forget 触发出口伴测更新节点延迟（IpInfoService 在 onUpdate 之后调，保 IP 先显）。
      (ctx) => {
        void exitProbeLatencyRunner(ctx);
        // G-flip2（§10 D5 / §11 B3）：代理出口探测成功 = egress 实测已通。unlock 若卡 notReady/lowConfidence 失败终态
        // （成因正是 egress 不通）→ 该成功即「可达性 failed→ok 翻转」证据 → invalidate 触发自动重检。限频靠「事件驱动
        //（IpInfo 无后台轮询）+ 跨态 gate（reconcileTsExitBlock）+ 渲染端 1.5s 防抖」，非伴测 30s 节流（那在写侧）。
        // 过滤后仅 lastSnapshot 为失败终态才 invalidate：有结果/S0(null 快照) 时 no-op；不成环（unlock 重检不反向触发
        // ipInfo 探测）。边角：notReady 后手动 force-run 在飞期 lastSnapshot 仍为 notReady → 可能打断在飞轮，收敛良性
        //（egress 已恢复本就要重检、cache 空无实质差异）。
        const s = unlockService?.getSnapshot();
        if (s?.notReady || s?.lowConfidence) unlockService?.invalidate();
      }
    );
    // ProxyManager 翻转对账（STATUS 帧上 none↔blocked 跨态）时即时通知出口探测层落终态/重探。
    proxyManager.setIpInfoService(ipInfoService);
    // 启动后拉一次本地直连出口 IP 初值
    setTimeout(() => void ipInfoService?.refresh(true), 2000);

    // 解锁检测（AI/流媒体）：经 mixed inbound（走用户真实分流出口）跑 checker。端口取 localProxyPort 单一真值；
    // gating/单飞/缓存/节流在 service 内。progress 逐个点亮、invalidate（切节点/起停代理）广播给渲染端。
    // GAP-1（方案A）：解锁检测的**发起**唯一入口本是 renderer home 页 hook 的 IPC——「启动代理→<1.5s 内切页」时 renderer
    // 防抖定时器随组件卸载被取消 → invalidate 后的重跑 IPC 从未发出 → 检测从未开始（伴测/出口 IP 主进程自驱不受影响，唯
    // unlock 触发链 renderer-gated）。故在主进程装配层对 invalidate 追加**同款防抖 self-run**：合并启动风暴多条 invalidate
    // （started+unlock-invalidate+tailscale-selected-running）为一次 run；所有 gate（isRunning/exitBlock/S-gate/TTL/单飞
    // join）已在 service 内单点收口，run(false) 幂等（stopped 触发撞 isRunning 短路=零网络 no-op；home 挂载时 renderer 的
    // auto-run 撞主进程在飞轮=单飞 join，不双跑）。触发策略属装配层，不改 service 本体。
    const UNLOCK_SELF_RUN_DEBOUNCE_MS = 1500;
    let unlockSelfRunTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleUnlockSelfRun = (): void => {
      if (unlockSelfRunTimer) clearTimeout(unlockSelfRunTimer);
      unlockSelfRunTimer = setTimeout(() => {
        unlockSelfRunTimer = null;
        // self-run 终态**广播回渲染端 store**。fresh commit 已经 onComplete 广播（幂等），但
        // blockedReason（exit-invalid/proxy-not-running）/ S-gate notReady / cache-hit 等早退**不发 onComplete** →
        // 若不在此广播，渲染端「检测中」永卡（切到无效出口后 spinner 不灭、刷新钮禁用无自愈）。applyUnlockSnapshot
        // 会把 blockedReason/notReady 正确折叠成 idle。
        void unlockService
          ?.run(false)
          .then((snap) => {
            if (snap) ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_UNLOCK_UPDATED, snap);
          })
          .catch(() => {});
      }, UNLOCK_SELF_RUN_DEBOUNCE_MS);
    };
    unlockService = new UnlockDetectionService({
      getMixedPort: () =>
        localProxyPort({
          mixedPort: configManager.get<number>('mixedPort'),
          httpPort: configManager.get<number>('httpPort'),
        }),
      isRunning: () => proxyManager?.getStatus().running ?? false,
      // 选中 TS 出口 API 直判无效 → 短路检测（不空转死出口就绪门）。call-time 取值，规避构造顺序。
      getExitBlock: () => proxyManager?.selectedTsExitBlock() ?? null,
      // F-A：等 selector 校正完成再探测（对齐 IpInfo S1，:1754 同 4s cap）——防解锁轮落 boot 窗口经 cache_file 复活的旧出口。
      whenExitSettled: () => proxyManager?.whenSelectorSettled(4000) ?? Promise.resolve(),
      onProgress: (p) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_UNLOCK_PROGRESS, p),
      onInvalidated: () => {
        // 带主进程核真态（渲染端 connectionStatus/proxyBlocked 常陈旧——invalidate 先于
        // EVENT_PROXY_STARTED / IP_INFO_UPDATED 抵达）→ 渲染端据此正确判「显示检测中 vs idle」，不再用陈旧本地视图。
        const running = proxyManager?.getStatus().running ?? false;
        const exitBlocked = running && !!proxyManager?.selectedTsExitBlock();
        ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_UNLOCK_INVALIDATED, { running, exitBlocked });
        // GAP-1：invalidate 后主进程侧防抖自跑（不依赖 home 页挂载着的 renderer hook 发 IPC）。
        scheduleUnlockSelfRun();
      },
      // issue 2：一轮 fresh commit 的完整终态广播给渲染端 store（跨组件卸载持有 checkedAt/egress）。使切导航
      // 期间后台自跑（GAP-1 self-run）的终态照样落 store，切回首页直接展示、不重跑（渲染端纯展示、不再自触发）。
      onComplete: (snap) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_UNLOCK_UPDATED, snap),
      // X2（§12.2）：per-leg 传输失败逐条 debug（host/err/phase/bytes/elapsed）→ 真机 V36 分诊 WARP 下 checker「超时」根因。
      log: (message) => logManager.addLog('debug', message, 'Unlock'),
    });
    // G-flip：TS 出口 none↔blocked 翻转即令解锁检测失效（翻 blocked 清陈旧绿点；翻 none 触发有效出口重检）。
    // 闭包 call-time 取 unlockService（模块级 let），规避此接线早于/晚于其构造的顺序问题。
    proxyManager.setOnTsExitBlockFlip(() => unlockService?.invalidate());

    // 规则资源管理：下载 .srs / 动态 catalog / GitHub 加速；进度经事件推渲染端
    ruleResourceManager = new RuleResourceManager(
      configManager,
      (p) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_RULE_RESOURCE_PROGRESS, p),
      (cfg) => ipcEventEmitter.sendToAll('event:configChanged', { newValue: cfg }),
      (cfg) => mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, cfg)
    );
    ruleResourceManager.setUpdateNetwork(updateNetwork);
    // 启动即把内置 geo 规则集补种到运行时目录：缺失/损坏补种 + 出厂态下 app 升级带来的新出厂数据刷新
    // （不回滚网络更新版）。使「规则资源」页在首次启动代理前也能反映真实文件、可更新/重置；幂等、不阻塞启动。
    void configManager
      .loadConfig()
      .then((cfg) =>
        seedBuiltinRuleSets({ builtinGeoMeta: cfg?.builtinGeoMeta, refreshOutOfBox: true })
      )
      .catch(() => {});

    autoSwitchService = new AutoSwitchService(
      configManager,
      proxyManager,
      logManager,
      () => mainWindow
    );
    {
      const cfg = await configManager.loadConfig().catch(() => null);
      if (cfg?.autoSwitchNode) {
        autoSwitchService.enable();
      }
    }

    // 订阅自动更新调度器：启动补更陈旧订阅 + 周期更新（不打断当前连接）
    subscriptionScheduler = new SubscriptionScheduler(
      configManager,
      subscriptionService,
      logManager,
      () => proxyManager?.getStatus().running ?? false,
      (cfg) => {
        ipcEventEmitter.sendToAll('event:configChanged', { newValue: cfg });
        // P2-2：后台订阅更新增删节点后刷新托盘「选择服务器」子菜单（updateTrayMenuState 重载最新 config）。
        // 走 tray-only 刷新、不发 MAIN_EVENTS.CONFIG_CHANGED → 不触发 switchMode 重启，守住「不打断连接」不变量。
        void updateTrayMenuState(proxyManager?.getStatus().running ?? false);
      },
      // §2 自动刷新 auto-apply / F14 逃死节点强制重启入口（内部 guard 代理未运行/换核窗口 + 单飞去抖）。
      (cfg) => proxyManager?.applyConfigForcingRestart(cfg)
    );
    subscriptionScheduler.start();

    // 内核自动更新调度器（仅兼容版本带内）：30s 启动检查 + 6h tick + 24h due；落位仅在代理停止态。
    coreUpdateScheduler = new CoreUpdateScheduler(
      configManager,
      coreUpdateService,
      logManager,
      () => proxyManager?.getStatus().running ?? false
    );
    coreUpdateScheduler.start();

    // 自动空闲模式：powerMonitor 真实系统输入空闲轮询（app ready 后才可用），替代窗口 blur/hide 边沿武装。
    // 同节拍搭车渲染进程内存 watchdog（issue #242 §4）：60s 采一次 renderer RSS，超阈值兜底回收/告警（不新增 interval）。
    idleCheckInterval = setInterval(() => {
      void checkIdleAutoModes();
      checkRendererMemory();
    }, IDLE_POLL_MS);

    // 规则资源自动更新调度（sing-box 不自更新本地 .srs，由 FlowZ 周期重下载；静默、不打断连接）
    ruleResourceScheduler = new RuleResourceScheduler(
      configManager,
      ruleResourceManager,
      logManager
    );
    ruleResourceScheduler.start();

    // 监听代理管理器事件，更新托盘状态。
    // 说明：同节点「原地重启」由 ProxyManager 内部接管（handleProcessExit / 健康检查 → attemptAutoRestart，
    // 单一计数器 + 上限 + 冷却）。'error' 仅在「自动重启被抑制（核心更新校验窗口）或已达上限」时触发，
    // 故此处只需处理：核心回滚 → 放弃恢复并清理系统代理。崩溃不触发换节点（换节点交给心跳连通性检测）。
    proxyManager.on('error', async (error: { message: string; code?: number }) => {
      logManager.addLog('error', `Proxy error: ${error.message}`, 'Main');
      // 严重错误桌面通知（受总开关管控）。正文用通用本地化文案（main i18n，5 语），不透传 error.message——
      // 后者可能含端点地址；通知进系统通知中心/锁屏可见，避免泄漏节点身份。详情引导用户回应用内日志查看。
      notifyUser(mt('proxyErrorTitle'), mt('proxyErrorBody'));
      // 发生错误时，更新托盘显示为"连接异常"
      updateTrayMenuState(false, true);

      // 1) 新核心首次启动失败（自动重启被抑制时）→ 自动回滚旧核心并重启
      try {
        const rolledBack = await coreUpdateService.autoRollbackIfPendingUpdate();
        if (rolledBack) {
          logManager.addLog('warn', '新核心启动失败，已自动回滚，正在以旧核心重启代理...', 'Main');
          const cfg = await configManager.loadConfig();
          await proxyManager?.start(cfg);
          return;
        }
      } catch (rollbackErr) {
        logManager.addLog('error', `自动回滚重启失败: ${rollbackErr}`, 'Main');
      }

      // 2) 系统代理清理同样不在此监听器做：'error' 由 giveUpAutoRestart / handleProcessExit 终态分支发出，
      // 它们在 emit 之前已**同步门控**地调过 ensureSystemProxyCleared（stopping=false 的真终态会清）。此处再调
      // 因前面有 await（核心回滚）会越过 stopping 门控（H-1），且属重复，故删除。
    });

    // 主进程更新链路（应用/资源/订阅/核心）+ renderer 外部图片（图标库/自定义图标/国旗，经 flowz-icon://
    // 协议）已全迁 UpdateNetwork 专用会话经 update-in 入站；default session 不再 pin FlowZ http 入站，回归
    // Electron 默认（跟随系统代理）。至此 default session 无 FlowZ 外部请求消费者（WarpService 走 node https
    // 自成一路、不经 default session）（Phase 1b 删 applyMainSessionProxy）。

    proxyManager.on('started', async () => {
      // 托盘刷新（与 on('stopped') 对称，#75）：所有 start 路径最终都汇入此事件——含 switchMode / 节点回退 /
      // 崩溃后 attemptAutoRestart 的内部 stop→start（stopped 腿已把托盘刷成断开态，此处不刷则卡在
      // 「已断开 / 启用代理」而进程实际在跑）。放在首行确保后续 await 抛错也不漏刷；IPC/托盘/startup 的
      // 显式 updateTrayMenuState(true) 退化为幂等冗余。
      void updateTrayMenuState(true);

      // 出口 IP：start 瞬间即置「获取中」，消除「running 已 true 但下方延迟 1.5s 刷新尚未开始」窗口内
      // 代理出口闪「代理出口暂不可用」。随后的延迟 refresh(true) 接力真正探测（带重试）。
      ipInfoService?.markProxyConnecting();
      // 解锁检测失效：代理起 = 出口将变，清缓存 + 广播（渲染端复位、待 running 稳定后重跑）。
      unlockService?.invalidate();
      // stats 订阅【不】在此发起：emit('started') 早于 ProxyManager 创建 api client（startInternal 末尾）约 0.5s，
      // 此刻 getApiClient()=null、subscribe* 早退（首页 stats 全 0 根因）。改挂 'api-client-ready'（见下）。
      subscriptionScheduler?.onProxyStarted(); // 代理就绪 → 补跑因 viaProxy 跳过的启动订阅更新
      // bug#5 类级兜底：任何路径导致「核起于陈旧配置」（崩溃自动重启退避窗口内的编辑等，A 覆盖不到的格 8）→ start
      // 完成后取 ConfigManager 最新配置跑一次 switchMode 对账。配置未变 = norm-equal no-op（幂等零成本）；有差异按既有
      // 分流热切/重启。'started' 时 lifecycleDepth>0 → 经 switchMode 暂存、endLifecycleOp settle 后重放，时序安全。
      try {
        const latest = await configManager.loadConfig();
        await proxyManager?.switchMode(latest);
      } catch (e) {
        logManager.addLog('warn', `启动后配置对账失败: ${e}`, 'Main');
      }
      try {
        await coreUpdateService.recordSuccessfulVersion();
        logManager.addLog('info', '已记录当前运行的内核版本基线', 'Main');
      } catch (e) {
        logManager.addLog('warn', `记录内核基线版本失败: ${e}`, 'Main');
      }

      // 代理就绪后刷新出口 IP（direct 走常规 refresh(true)；proxy 出口走 refreshProxyPostConnect 首连宽退避）。
      // S1（§13.2）：原 setTimeout(1500) 固定延时改为 **await selector 校正完成**（whenSelectorSettled）再发首探——
      // 防首探落在「核起→reassertSelectorSelection 完成」窗口内，经 cache_file 携带的陈旧 selector 从**上一节点**
      // 出网、拿到上一节点出口 IP（P18 陈旧出口 IP 尾巴：WARP→停→切 TS→启，状态栏先显 WARP IP 再显 TS IP）。
      // race 4s 超时恒 resolve（reassert 慢/失败降级为今日行为）；markProxyConnecting 仍在 'started' 即刻（上方），
      // 「检测中」UX 不变。隧道一就绪由下方 'tailscale-selected-running' 链式 refreshProxy 抢先出真值。
      void proxyManager?.whenSelectorSettled(4000)?.then(() => {
        void ipInfoService?.refresh(true);
        void ipInfoService?.refreshProxyPostConnect();
      });
    });

    // 事件驱动出口 re-probe：选中的账号制（TS）节点隧道翻 Running（就绪）→ 立即重测代理出口，
    // 不等首连退避耗尽。ProxyManager 在 STATUS 流上升沿去重发射，故此处无需再防抖；refreshProxy 经 enqueue
    // 链式排到在途首探之后，隧道一就绪即取到真出口 IP（消除「转圈直到退避耗尽」的长盲等）。
    proxyManager.on('tailscale-selected-running', () => {
      // S1：STATUS Running 首帧可能抢在 reassert 前 → 经陈旧 selector 探测。等 selector 校正（settle 后即时返回、
      // 零成本；超时 2.5s 兜底）再 refreshProxy，保「探测=选中节点出口」。
      void proxyManager?.whenSelectorSettled(2500)?.then(() => ipInfoService?.refreshProxy());
      // TS 隧道就绪 → 出口才真正生效/可能变化 → 解锁缓存失效重测。
      unlockService?.invalidate();
    });

    // 修复（首页 stats 全 0 根因）：Status/Connections 订阅必须等 api client 就绪。emit('started')（runStartWithRetry
    // 内）早于 ProxyManager 创建 api client（startInternal 末尾）约 0.5s → 那时 getApiClient()=null、subscribe* 早退、
    // 订阅从未发起、且无二次重订。改挂 'api-client-ready'（client .start() 后发；崩溃自动重启亦走 startInternal 同
    // 路径到此 → 覆盖 E-1）：此刻 getApiClient() 非空、resubscribe 真正订上 Status/Connections 流。
    proxyManager.on('api-client-ready', () => statsService?.resubscribe());

    // 节点热切换成功（clash_api PUT 已生效）→ 只重测代理出口（本地出口不因切节点变）。
    // 由 main 在热切换出口触发，避免渲染端猜时机导致探针先于切换落地而测到旧节点。
    // markProxyConnecting 先行（修出口陈旧）：立即清旧节点出口 IP + 置「检测中」，闭合 refreshProxy 入队到真正探测之间
    // 的窗口（否则该窗口持续显上一节点 IP，如切到 Tailscale 仍显旧 hk01）。
    // accountBased（payload）：切到账号制（TS）节点时隧道未就绪即耗尽常规预算会闪「暂不可用」→ 改走宽退避
    // refreshProxyPostConnect（与 'started' 首连路径同治）；IP 类节点即起即通仍走常规 refreshProxy。
    proxyManager.on('node-hot-switched', (accountBased?: boolean) => {
      ipInfoService?.markProxyConnecting();
      // 解锁缓存失效不在此挂：改由 'unlock-invalidate' 独立事件覆盖（含纯规则热切换 kind=rules，那不发
      // node-hot-switched），避免规则变更漏失效（M1）。
      if (accountBased) {
        void ipInfoService?.refreshProxyPostConnect();
      } else {
        void ipInfoService?.refreshProxy();
      }
    });

    // 解锁检测失效（M1）：任何热切换（切全局节点 / 改规则目标节点 / 两者）→ 解锁出口或分流可能变 → 失效重测。
    // 与 node-hot-switched 分开：本事件**只失效解锁、不触发 IpInfo 重测**（纯规则变更全局出口 IP 未变，无谓重测）。
    proxyManager.on('unlock-invalidate', () => {
      unlockService?.invalidate();
    });

    proxyManager.on('stopped', () => {
      statsService?.stop();

      // 停止后重测出口 IP（proxy 置 null，direct 走主进程裸直连）
      void ipInfoService?.refresh(true);
      // 代理停 → 解锁检测无出口可测，清缓存 + 广播（渲染端复位 idle，gating 拦住重跑）。
      unlockService?.invalidate();

      // 正常停止时，重置错误状态
      updateTrayMenuState(false, false);

      // 系统代理清理不在此监听器内做：emit('stopped') 与 stop() 的 finally（复位 stopping）有时序竞态，
      // 在此清理会绕过 stopping 门控 → 重启路径误清并删新会话 marker（C1 的 H-1 回归）。
      // 所有「进程不再运行」的路径都已在 ProxyManager 内部**同步门控**地调过 ensureSystemProxyCleared：
      // handleProcessExit（信号死/崩溃终态）、performHealthCheck（达上限）、giveUpAutoRestart、restart 的 start
      // 腿失败、退避 abort；用户主动停止由 IPC/托盘在 stop() 前置清理。故此处删除，避免越过门控。

      // 内核自动更新：代理停止 → 安全窗口，延 5s 双查后落位 staged 内核（规避 attemptAutoRestart/switchMode
      // 的 stop→start 瞬时窗口）。调度器内部守 running===false，绝不在重启间隙落位（不断流硬不变量）。
      coreUpdateScheduler?.onProxyStopped();
    });

    // 注入 LogManager 供 IPC 注册器在生产环境记录「同名 channel 重复注册」等异常（须在任意 register* 之前）
    setIpcLogger(logManager);

    // 注册 IPC 处理器（需要在 ProxyManager 创建后）
    registerConfigHandlers(configManager);
    registerPrivacyHandlers();
    registerServerHandlers(protocolParser, configManager, logManager);
    registerLogHandlers(logManager, proxyManager, isUiBroadcastActive);
    registerProxyHandlers(proxyManager, configManager);
    // §3.7：STATS_SUBSCRIBE/STATS_UNSUBSCRIBE（渲染端 useStatsTopic 声明/撤销 topic 订阅）。
    registerStatsSubscriptionHandlers(statsSubscriptionRegistry);
    registerIpInfoHandlers(ipInfoService);
    registerUnlockHandlers(unlockService);
    registerSystemHandlers();
    registerRuleResourceHandlers(ruleResourceManager);
    registerVersionHandlers(coreUpdateService);

    registerRulesHandlers(configManager);

    setCoreUpdateService(coreUpdateService, logManager);
    registerCoreUpdateHandlers();

    registerAutoStartHandlers();

    // 注册订阅处理器。§16.3.4b：手动更新节点集变化 → force-restart 入池（call-time 取 proxyManager，防循环依赖）。
    registerSubscriptionHandlers(subscriptionService, configManager, (cfg) =>
      proxyManager?.applyConfigForcingRestart(cfg)
    );

    // 注册备份与恢复处理器（注入 ruleResourceManager：恢复后补缺失的规则资源 .srs）
    registerBackupHandlers(configManager, ruleResourceManager);

    // 注册诊断报告处理器（汇集环境/脱敏配置/日志 tail → 单 Markdown）。此处 proxyManager 已构造（非空）。
    if (proxyManager) {
      const diagnosticService = new DiagnosticService(
        configManager,
        logManager,
        proxyManager,
        systemProxyManager,
        getPrivacyMode,
        // 渲染进程堆内省（issue #242 §6.2）：main→renderer executeJavaScript 取一次；DiagnosticService 内 2s 超时
        // 兜底，renderer 卡死（正是 #242 场景）不挂住导出。窗口不存在/销毁 → 返回 null（映射为 unavailable）。
        async () => {
          const win = mainWindow;
          if (!win || win.isDestroyed()) return null;
          try {
            return await win.webContents.executeJavaScript(
              'window.electron && window.electron.getRendererDiagnostics ? window.electron.getRendererDiagnostics() : null'
            );
          } catch {
            return null;
          }
        },
        // 渲染进程内存 watchdog 计数（issue #242 §4）：本会话隐藏态回收/可见态告警次数 + 阈值，随诊断导出。
        () => ({
          discardCount: rendererDiscardCount,
          warnCount: rendererWarnCount,
          thresholdMb: RENDERER_RSS_LIMIT_MB,
        }),
        // 测速专项诊断：最近一次临时测速 sing-box config + 逐节点失败 reason。DiagnosticService 内统一脱敏。
        () => speedTestService?.getLastSpeedTestDiagnostics() ?? null
      );
      registerDiagnosticHandlers(diagnosticService);
    }

    registerHelperHandlers(helperManager, proxyManager);

    const autoStartManager = createAutoStartManager();
    autoStartManager.setLogManager(logManager);
    const config = await configManager.loadConfig();
    await autoStartManager.setAutoStart(config.autoStart ?? false);

    // 注册更新处理器（窗口引用已由 createWindow() 内的刷新逻辑设置，此处无需重复）
    setUpdateService(updateService);
    // 设置更新前的清理回调，确保在安装更新前停止代理进程
    // 更新流程用非终态的 runCleanup（不消耗退出管线的一次性清理 promise）：安装失败 app 续命后，
    // 后续真正退出仍能完整拆除代理；安装成功则 app.exit 直接退，runCleanup 已先行清理。
    updateService.setCleanupCallback(runCleanup);
    registerUpdateHandlers();

    // 注册测速处理器（注入唯一编排器依赖：含 getTrayManager 惰性访问器，使渲染入口测速也回写托盘列表）
    registerSpeedTestHandlers({
      configManager,
      speedTestService,
      getMainWindow: () => mainWindow,
      getTrayManager: () => trayManager,
      logManager,
    });

    // IPC 处理器全部注册完成（汇总一条，取代各 handler 模块的逐条启动日志）
    logManager.addLog('info', 'IPC handlers 注册完成', 'Main');

    setTrayStateCallback((isRunning: boolean, hasError?: boolean) => {
      updateTrayMenuState(isRunning, hasError);
    });

    // 界面语言不再经渲染端 IPC 反向同步：改走 config.language 单一真值源——渲染端改语言写 config，
    // config-change-handler 据 config.language 重设主进程 i18n 并重渲染托盘（见 applyLanguageFromConfig 注入）。

    // 节点列表「按延迟排序」开关同步：渲染端 App.tsx 在 mount（cold-start 一次同步）+ 每次切换时推送，
    // 使托盘节点列表与下拉同序（幂等，TrayManager.setSortByLatency 同态 no-op 不重建菜单）。
    registerIpcHandler<boolean, void>(
      IPC_CHANNELS.APP_SET_NODE_SORT_BY_LATENCY,
      (_event, value: boolean) => {
        currentNodeSortByLatency = !!value; // 记住最近值，供 tray 创建后补应用（防早到 push 被丢）
        trayManager?.setSortByLatency(currentNodeSortByLatency);
      }
    );

    // 窗口控制（Linux frameless 自绘标题栏的 min/max/close 按钮调用；Mac 红绿灯 / Win titleBarOverlay 用原生按钮不经此）。
    registerIpcHandler<void, void>(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
      mainWindow?.minimize();
    });
    registerIpcHandler<void, boolean>(IPC_CHANNELS.WINDOW_MAXIMIZE_TOGGLE, () => {
      if (!mainWindow) return false;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      return mainWindow.isMaximized();
    });
    registerIpcHandler<void, void>(IPC_CHANNELS.WINDOW_CLOSE, () => {
      mainWindow?.close();
    });
    registerIpcHandler<void, boolean>(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
      return mainWindow?.isMaximized() ?? false;
    });

    trayManager = new TrayManager(
      mainWindow,
      logManager,
      buildTrayCallbacks({
        getMainWindow: () => mainWindow,
        getTrayManager: () => trayManager,
        getProxyManager: () => proxyManager,
        logManager,
        configManager,
        updateService,
        speedTestService,
        showWindow,
        updateTrayMenuState,
        setPrivacyMode,
        // 轻量模式恒不因 minimizeToTray 退出（代理不中断是其硬性契约）——等价于按 minimizeToTray=true
        // 算 shouldQuitOnAllWindowsClosed，但 hasTray 兜底仍要判：托盘图标创建失败时，轻量模式销毁窗口
        // 后台也会变成无窗口+无图标的僵尸，那种情形下仍需退出（10 分钟空闲自动触发时尤其够不着托盘菜单）。
        markLightweightModeTransition: () => {
          pendingQuitOnAllClosed = shouldQuitOnAllWindowsClosed(
            process.platform,
            true,
            !!trayManager?.hasTray()
          );
        },
      })
    );
    trayManager.createTray();
    // 补应用「按延迟排序」开关：若渲染端 mount 推送早于本行（极端时序），上面 handler 的 trayManager?. 已丢弃该值，
    // 此处用持有的最近值兜底（幂等：默认 false 时 no-op）。覆盖「持久 true 偏好在冷启被丢、托盘整会话停默认序」。
    trayManager.setSortByLatency(currentNodeSortByLatency);

    updateTrayMenuState(false);

    // 启动期延迟任务（自动连接 + 自动检查更新）已抽到 startup-tasks.scheduleStartupTasks。
    scheduleStartupTasks({
      configManager,
      coreUpdateService,
      updateService,
      logManager,
      getProxyManager: () => proxyManager,
      updateTrayMenuState,
    });

    // 订阅自动更新由 SubscriptionScheduler 接管（启动补更 + 周期巡检 + 退避 + 不打断连接），
    // 取代旧的「启动后一次性 setTimeout 拉取」。详见 subscriptionScheduler.start() 调用处。

    // CONFIG_CHANGED 监听器已抽到 config-change-handler.registerConfigChangeListener。
    registerConfigChangeListener({
      configManager,
      logManager,
      getProxyManager: () => proxyManager,
      getAutoSwitchService: () => autoSwitchService,
      getCoreUpdateScheduler: () => coreUpdateScheduler,
      updateTrayMenuState,
      getPrivacyMode,
      // 语言解析需系统偏好（auto→系统），故在 index.ts 内注入；config-change-handler 本身不依赖 electron。
      // 读 configManager 缓存而非事件 payload：saveConfig 先更新 currentConfig 再 emit CONFIG_CHANGED（见
      // config-handlers），故缓存恒是最新值；且不受 payload 形状影响（未来某发射点漏带 language、或恢复缺该键的
      // 旧备份，都不会把主进程语言静默重置成系统语言）——与「config.language 单一真值源」主旨一致。
      applyLanguageFromConfig: () =>
        setMainLanguage(
          resolveEffectiveLanguage(
            configManager.get<string>('language'),
            getPreferredSystemLanguagesSafe()
          )
        ),
    });

    // 关机/重启早期钩子：powerMonitor 'shutdown' **仅 macOS/Linux 触发**（Electron 文档），Windows 不发。
    // 故仅在 darwin/linux 注册——原 #212「补 win32」基于「Windows 也发」的错误前提（经文档/复审核实 win32
    // 不触发此事件，注册即死代码）。Windows 关机/注销由窗口级 'session-end'（见 createWindow）覆盖。
    // 兜底防 SIGTERM→cleanupResources 异步链跑不完致系统代理/DNS 残留；syncCleanupOnExit 内 marker 门控。
    if (process.platform !== 'win32') {
      powerMonitor.on('shutdown', () => {
        logManager.addLog('warn', 'OS shutdown detected (powerMonitor), syncing cleanup', 'Main');
        syncCleanupOnExit();
      });
    }

    // Dock 点击 / Finder·Spotlight 重新打开运行中的 app（macOS 经 activate，非 second-instance）。
    // hasVisibleWindows=false 涵盖窗口隐藏/最小化/已销毁三态；showWindow 已分别处理（show / restore / 重建）。
    // 旧逻辑只判 getAllWindows().length===0，隐藏窗口仍计入 → 关窗后点 Dock 无反应（根因）。
    app.on('activate', (_event, hasVisibleWindows) => {
      if (!hasVisibleWindows) {
        void showWindow();
      }
    });
  });
}

// 退出意图标记：before-quit 早于逐窗口 close 触发，置位后 close 处理器放行销毁（见 createWindow），
// 使 app.quit() 不被 close 的 preventDefault 吞成"隐藏"、will-quit 清理得以执行（根因 A 修复，跨平台）。
let isQuitting = false;
// 常驻托盘 vs 彻底退出的待决意图：主窗口每次被销毁（关窗 或 轻量模式）时就地算好、存在这里；
// window-all-closed 只消费这个最近一次算好的值，不在自己触发的那一刻重新判断。
// 根因：window-all-closed 只反映"窗口计数归零"，不反映"是哪次销毁导致的"——若还开着更新进度窗/
// sing-box 面板等独立窗口，主窗口销毁后计数不会立刻归零，事件会推迟到那些窗口之后也关闭才触发；
// 若在那一刻才重新判断，判断的其实是"最新配置"而非"当初销毁主窗口时的意图"，且曾用一次性 flag
// 做过这件事，结果 flag 在"计数暂未归零"期间一直脏着，被后续一次完全无关的关窗事件误读。
// 提前在销毁的当下算好并存下来，无论 window-all-closed 隔多久之后才真正触发都不会跑偏。
let pendingQuitOnAllClosed = false;
// 清理 memoized promise：多入口（will-quit / SIGTERM / 托盘 app.quit）共享同一次清理。
// 用 promise 而非 boolean：并发的第二入口 await 同一进行中的清理，避免 process.exit 拦腰截断它。
let cleanupPromise: Promise<void> | null = null;
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (!gotTheLock) return;
  // 只消费 pendingQuitOnAllClosed（主窗口销毁那一刻已经算好，见 close 处理器 / markLightweightModeTransition），
  // 不在这里重新判断——本事件何时触发只取决于"最后一个窗口"何时关闭（可能是更新进度窗/sing-box 面板
  // 这类独立窗口，跟主窗口销毁不同时），用当下配置重新算的话，判断的就不是当初销毁主窗口时的真实意图。
  if (pendingQuitOnAllClosed) {
    logManager.addLog('info', 'All windows closed, quitting', 'Main');
    app.quit();
  } else {
    logManager.addLog('info', 'All windows closed, staying resident in tray', 'Main');
  }
});

app.on('will-quit', async (_event) => {
  if (!gotTheLock) return;
  _event.preventDefault();

  try {
    await cleanupResources();

    if (trayManager) {
      trayManager.destroyTray();
      trayManager = null;
    }

    app.exit(0);
  } catch (error) {
    console.error('Error during app quit:', error);
    // 即使清理失败，也要退出
    app.exit(1);
  }
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, cleaning up...');
  await cleanupResources();
  trayManager?.destroyTray(); // 信号退出也显式销毁托盘，与 will-quit 一致（幂等）
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, cleaning up...');
  await cleanupResources();
  trayManager?.destroyTray();
  process.exit(0);
});

// 系统关机/注销 / 进程退出的同步兜底：停代理(fire-and-forget) + 同步关系统代理，防重启后代理残留。
function syncCleanupOnExit(): void {
  if (proxyManager) {
    // 必须传 quitting：否则 stop() 的同步前缀会一路同步拉起 Windows RunAs taskkill 的 UAC 弹框
    // （即便 fire-and-forget / process.exit 语境），违反"退出零弹框"不变量、可能在 app 死后冒孤儿 UAC。
    proxyManager.stop({ quitting: true }).catch(() => {});
  }
  // marker 门控：仅当 marker 存在（FlowZ 设置过系统代理且尚未拆除）才同步强关，
  // 防每次退出无条件 stomp 用户自配/第三方系统代理（设计 通用-E）。
  // 正常退出链 cleanupResources→disableProxy 已删 marker → 此处自然跳过，不重复操作。
  if (SystemProxyBase.readMarker()) {
    try {
      const { createSystemProxyManager } = require('./services/SystemProxyManager');
      const sysProxy = createSystemProxyManager();
      sysProxy.disableProxySync();
    } catch {
      /* ignore */
    }
  }
  // 系统 DNS 同步还原（marker 门控）：仅 FlowZ 接管过的才还原；受控 IP 是真实 8.8.8.8，
  // 即便此处漏还原也不断网（降级为真 DNS），下次启动 marker 恢复兜底。
  if (SystemDnsBase.readMarker()) {
    try {
      const { createSystemDnsManager } = require('./services/SystemDnsManager');
      const sysDns = createSystemDnsManager();
      sysDns.restoreDnsSync();
    } catch {
      /* ignore */
    }
  }
}

// 修复：旧版把关机/注销清理挂在 `app.on('session-end')` —— 但 session-end 是 BrowserWindow 的 win32 事件，
// App 从不发它（死代码 → Windows 注销/关机后系统代理残留、重启断网）。已改挂窗口级（见 createWindow 内 'session-end'）。
// macOS/Linux 关机由 launchd/systemd 发 SIGTERM → SIGTERM handler → cleanupResources 覆盖；
// 另有 powerMonitor 'shutdown' 更早钩子（whenReady 末尾注册）。process'exit'/session-end/shutdown
// 三入口统一经 syncCleanupOnExit 的 marker 门控（通用-E），仅 FlowZ 自己设置的系统代理才被强关。

// 进程退出时的最后兜底（同步执行）
process.on('exit', () => {
  if (!gotTheLock) return;
  syncCleanupOnExit();
});
