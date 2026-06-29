import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';
import * as path from 'path';
import { ConfigManager } from './services/ConfigManager';
import { ProtocolParser } from './services/ProtocolParser';
import { LogManager } from './services/LogManager';
import { TrayManager } from './services/TrayManager';
import { ProxyManager } from './services/ProxyManager';
import { DiagnosticService } from './services/DiagnosticService';
import { createSystemProxyManager, SystemProxyBase } from './services/SystemProxyManager';
import { createSystemDnsManager, SystemDnsBase } from './services/SystemDnsManager';
import { resourceManager } from './services/ResourceManager';
import { registerIconProtocolSchemes, registerIconProtocol } from './icon-protocol';
import { notifyUser, setDesktopNotificationsEnabled } from './notify-user';
import { mt, setMainLanguage } from './i18n';
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
  registerSystemHandlers,
  registerRuleResourceHandlers,
} from './ipc/handlers';
import { setIpcLogger, registerIpcHandler } from './ipc/ipc-handler';
import { createAutoStartManager } from './services/AutoStartManager';
import { UpdateService } from './services/UpdateService';
import { CoreUpdateService } from './services/CoreUpdateService';
import { CoreUpdateScheduler } from './services/CoreUpdateScheduler';
import { SpeedTestService } from './services/SpeedTestService';
import { AutoSwitchService } from './services/AutoSwitchService';
import { SubscriptionScheduler } from './services/SubscriptionScheduler';
import { StatsService } from './services/StatsService';
import { PlatformPrivilegeService } from './services/PlatformPrivilegeService';
import { IpInfoService } from './services/IpInfoService';
import { RuleResourceManager } from './services/RuleResourceManager';
import { UpdateNetwork } from './services/UpdateNetwork';
import { seedBuiltinRuleSets } from './services/builtin-geo-rulesets';
import { RuleResourceScheduler } from './services/RuleResourceScheduler';
import { HelperManager } from './services/HelperManager';
import { WindowsServiceHelper } from './services/WindowsServiceHelper';
import type { IPrivilegedHelper } from './services/IPrivilegedHelper';
import type { HelperStatus, UserConfig } from '../shared/types';
import { ipcEventEmitter } from './ipc/ipc-events';
import { buildTrayCallbacks } from './tray-actions';
import { scheduleStartupTasks } from './startup-tasks';
import { registerConfigChangeListener } from './config-change-handler';
import { mainEventEmitter, MAIN_EVENTS } from './ipc/main-events';
import { initUserDataPath } from './utils/paths';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { LOGIN_ITEMS_SETTINGS_URL } from '../shared/constants';
import { effectiveLogLevel } from '../shared/log-level';
import { resolveAutoLanguage } from '../shared/language';

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

// 初始化用户数据路径（必须在 app.requestSingleInstanceLock() 之前调用）
// 以确保便携模式下，锁文件和所有 Electron 数据都重定向到正确的目录
initUserDataPath();

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

// 单实例锁：防止开启多个软件实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    // 当有人试图运行第二个实例时，聚焦并显示主窗口
    showWindow();
  });
}

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
const isDevelopment = process.env.NODE_ENV === 'development';
let idleCheckInterval: NodeJS.Timeout | null = null; // 自动空闲模式轮询（powerMonitor 真实系统输入空闲）

// Privacy Mode State (Main Process)
let isPrivacyMode = false;

/**
 * 获取隐私模式状态
 */
export function getPrivacyMode(): boolean {
  return isPrivacyMode;
}

/**
 * 设置隐私模式状态
 * @param value 是否开启
 */
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
  // 通知所有窗口同步此状态
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
let statsService: StatsService | null = null;
let ipInfoService: IpInfoService | null = null;
let ruleResourceManager: RuleResourceManager | null = null;
let ruleResourceScheduler: RuleResourceScheduler | null = null;
let helperManager: IPrivilegedHelper | null = null;
let currentLanguage = 'zh-CN'; // 渲染端 APP_SET_LANGUAGE 同步的最近语言；经 setMainLanguage 喂主进程 i18n（mt() 据此取文案）。空值由 handler 的 lang||currentLanguage 兜底保留旧值（不传空给 setMainLanguage）
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

// 全局异常捕获 - 主进程
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  if (logManager) {
    logManager.addLog('fatal', `未捕获的异常: ${error.message}\n${error.stack}`, 'Main');
  }

  // 在开发环境显示错误对话框
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

  // 在开发环境显示错误对话框
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

/**
 * 显示主窗口
 * 如果窗口不存在则创建，如果已存在则显示并聚焦
 */
// 创建中记忆：createWindow 在 new BrowserWindow 前 await loadConfig，多入口（启动/activate/托盘/second-instance）
// 在「无窗口」态并发触发会各自越过检查、建出两个窗口（首个泄漏）→ 所有入口共享同一次进行中的创建。
let creatingWindow: Promise<void> | null = null;
// 显式唤出请求：在途创建（可能属 silent 启动 forceShow=false）完成后由 ready-to-show 消费 → 绘制完成才显示，免未绘制帧闪现。
let pendingForceShow = false;
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

// 任一窗口关闭后重评估「无可见窗口 → 菜单栏-only」：覆盖更新进度窗关闭、主窗轻量 destroy 等
// 主窗已隐藏的边缘（hideDockIfMenubarOnly 自带 anyVisible 守卫 → 仅真无可见窗口才摘，主窗仍开则 no-op）。
// 模块级注册（早于首个窗口创建）→ 含启动期主窗。主窗红灯关走 'hide'（非 'closed'），不经此、不重复。
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
  let windowWidth = 1200;
  let windowHeight = 800;
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
  // 而 onThemeUpdated 仅在 OS 主题「切换」时修正、初始不跑（review #3）。
  const isDarkInitial = nativeTheme.shouldUseDarkColors;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 800,
    minHeight: 600,
    title: 'FlowZ',
    icon: resourceManager.getAppIconPath(),
    show: false, // 先不显示，等待加载完成
    backgroundColor: isMac ? '#00000000' : isDarkInitial ? '#1F252E' : '#E9EEF3',
    transparent: isMac,
    autoHideMenuBar: true, // 自动隐藏菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDevelopment, // 仅在开发环境启用开发者工具，生产环境禁用（除非特殊需求）
      // OS 偏好语言注入 preload（同步、无 IPC 时序问题）：供 i18n「自动跟随系统」解析。
      //   app.getLocale() 恒返 app bundle locale=en（与系统脱钩，代码多处实证），故必须用 getPreferredSystemLanguages。
      additionalArguments: [
        `--flowz-sys-langs=${JSON.stringify(getPreferredSystemLanguagesSafe())}`,
      ],
    },
    // macOS：集成式窗口（红绿灯内嵌 + sidebar 半透材质）
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'active',
    }),
    // Windows：集成式标题栏（隐藏原生栏 + 右上覆盖层按钮，对齐 Mac）+ Win11 Mica 材质。
    // Mica 仅作窗口/侧栏底（壁纸微染），内容卡片实色不透。窗口 backgroundColor 取实色主题色作兜底：
    // 物理屏+透明效果 → Mica；RDP/透明关 → DWM 回落该实色 #1F252E/#E9EEF3（不会黑）。
    // Linux 无覆盖层 API → 不进此分支，默认边框 + 实色底。
    ...(isWindows && {
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayColors(isDarkInitial),
      backgroundMaterial: 'mica',
    }),
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

  // 移除默认菜单栏（Windows/Linux）
  if (process.platform !== 'darwin') {
    mainWindow.setMenu(null);
  }

  // 注册窗口到 IPC 事件发送器，以便接收广播事件
  ipcEventEmitter.registerWindow(mainWindow);

  // 更新托盘管理器的窗口引用
  if (trayManager) {
    trayManager.setMainWindow(mainWindow);
  }

  startupMark('windowCreated');

  // 窗口加载完成后显示
  mainWindow.once('ready-to-show', async () => {
    startupMark('readyToShow');
    // 立即消费 pendingForceShow（早于任何 await，避免与并发 showWindow 竞态）：显式唤出在途 silent 启动时强制显示
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
  });

  // 开发环境加载 Vite 开发服务器
  if (isDevelopment) {
    mainWindow.loadURL('http://localhost:5173').catch((err) => {
      logManager.addLog('error', `Failed to load dev server: ${err.message}`, 'Main');
    });
    // mainWindow.webContents.openDevTools(); // 移除自动打开，改为手动打开 (Cmd+Option+I)
  } else {
    // 生产环境加载打包后的文件
    let indexPath: string;

    // 生产环境默认不打开开发者工具
    // 如果需要调试，可以通过快捷键 (Cmd/Ctrl+Shift+I) 打开，
    // 因为 webPreferences.devTools 仍然是 enable 的

    indexPath = path.join(__dirname, '../../renderer/index.html');

    mainWindow.loadFile(indexPath).catch((err) => {
      logManager.addLog('error', `Failed to load index.html: ${err.message}`, 'Main');
    });
  }

  // 处理窗口加载错误
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    logManager.addLog('error', `Window failed to load: ${errorDescription} (${errorCode})`, 'Main');
  });

  // macOS：隐藏到托盘时摘 Dock 图标（仅驻留菜单栏，不占 Dock / Cmd-Tab），重新显示时恢复。
  // 经 activation policy 状态机（见 hideDockIfMenubarOnly/restoreDockPresence），覆盖所有显隐路径。
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

  // 处理窗口关闭事件
  // 注意：必须同步调用 preventDefault()，否则窗口会直接销毁。
  // 任何 await 操作都应该在此之后。
  mainWindow.on('close', (event) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    // 退出管线（Cmd+Q/Dock/托盘退出 → app.quit() → before-quit 置 isQuitting）：放行销毁，
    // 不再 preventDefault→hide，否则 macOS 上 quit 会被吞成"隐藏"、will-quit 清理永不执行（根因 A）。
    if (isQuitting) return;

    // 默认先阻止关闭
    event.preventDefault();

    // 异步获取配置并决定是隐藏还是真正销毁
    configManager
      .loadConfig()
      .then((config) => {
        if (window.isDestroyed()) return;

        // macOS：关窗按钮恒隐藏（mac 惯例——红灯关窗不退应用），保留渲染态、避免重建开销与状态错乱
        // （焦点/激活项/currentView 不丢）。其余平台按 minimizeToTray 决定隐藏或销毁。
        if (process.platform === 'darwin' || config.minimizeToTray) {
          window.hide();
          logManager.addLog('info', 'Window hidden to tray', 'Main');
        } else {
          // 允许窗口销毁，不再 preventDefault
          // 既然已经调用过 preventDefault，我们需要手动调用 destroy
          logManager.addLog('info', 'Window destroying (minimizeToTray off)', 'Main');
          window.destroy();
        }
      })
      .catch((err) => {
        console.error('Failed to load config during window close:', err);
        if (!window.isDestroyed()) window.destroy();
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (trayManager) {
      trayManager.setMainWindow(null);
    }
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

/**
 * 更新托盘菜单状态
 * @param isProxyRunning 代理是否正在运行
 * @param hasError 是否存在连接错误
 */
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

    // 同时更新托盘图标状态
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
    speedTestService = new SpeedTestService(logManager, (s, tag) =>
      proxyManager
        ? (proxyManager.buildSpeedTestOutbound(s, tag) as Record<string, unknown> | null)
        : null
    );
    // 批次 B：把日志 sink 注入「原本裸 console、不进 app.log」的服务，补排障盲区（系统代理/配置/资源/协议）
    configManager.setLogManager(logManager);
    protocolParser.setLogManager(logManager);
    systemProxyManager.setLogManager(logManager);
    systemDnsManager.setLogManager(logManager);
    resourceManager.setLogManager(logManager);
    // 记录应用启动日志
    logManager.addLog('info', 'Application started', 'Main');

    // Windows toast 前置：设 AppUserModelID（与 electron-builder appId 一致），提升 portable 版通知可靠性（无 NSIS 注册时）。
    if (process.platform === 'win32') app.setAppUserModelId('com.flowz.app');
    // 主进程 i18n 初值按系统偏好（渲染端 APP_SET_LANGUAGE 同步到达前的桌面通知语言；与 TrayManager 初值口径一致）。
    setMainLanguage(resolveAutoLanguage(getPreferredSystemLanguagesSafe()));
    // 桌面通知总开关初始同步（运行期变更由 config-change-handler 同步）。await 确保 enabled 在后续启动步骤
    // （含 proxy 自动连接，error 通知的唯一来源）前就绪——此刻 proxy 未启动，error 不会触发，无竞态；读配置毫秒级。
    await configManager
      .loadConfig()
      .then((c) => setDesktopNotificationsEnabled(c.desktopNotifications))
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

      // 检查配置是否为默认配置（可能是因为加载失败）
      if (config.servers.length === 0 && config.selectedServerId === null) {
        // 这可能是首次启动或配置文件损坏
        logManager.addLog('warn', 'Using default configuration', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('error', `Failed to load configuration: ${errorMessage}`, 'Main');

      // 显示错误对话框通知用户
      dialog.showErrorBox(
        '配置加载失败',
        `无法加载配置文件，将使用默认配置。\n\n错误信息: ${errorMessage}`
      );
    }

    await ensureWindow(); // 走串行化入口（forceShow=false 尊重 silentStart），与 activate/托盘/second-instance 共享创建

    // 初始化 ProxyManager（需要在窗口创建后）
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
    // 类2：主更新链路 viaProxy/port 决策 providers 一次注入 UpdateNetwork（共享 configManager/proxyManager）；
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

    // 提权 helper：装一次后 TUN 模式启停 sing-box 免提权；未装则回退平台提权路径（macOS osascript / Windows UAC）。
    // macHelper 始终创建：macOS 真用（含 v5 install-core + 提权复制，注入 CoreUpdateService/PlatformPrivilegeService）；
    // Windows/Linux 上 supported=false 安全降级（这些 macOS 专属消费者不会真用它）。模块级 helperManager（供 ProxyManager
    // 路由 / 引导门控 / IPC 处理器）：Windows=WindowsServiceHelper，其余=macHelper。互不进入对方分支 → 跨平台零回归。
    const macHelper = new HelperManager(logManager);
    helperManager = process.platform === 'win32' ? new WindowsServiceHelper(logManager) : macHelper;
    proxyManager.setHelperManager(helperManager);
    coreUpdateService.setHelperManager(macHelper); // B 块：install-core 仅 macOS（Windows/Linux 得降级实例，不真用）
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

    // 流量统计：代理运行时经管理 API（gRPC）订阅 Status/Connections 流，经事件推渲染端展示。
    // getApiClient 取 ProxyManager 运行期管理 API 客户端（核未起返回 null → 不开流）。
    statsService = new StatsService(
      (stats) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_STATS_UPDATED, stats),
      () => proxyManager?.getApiClient() ?? null,
      (snap) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_CONNECTIONS_UPDATED, snap),
      // P1/P2：窗口可见才广播——隐藏（macOS hide / minimizeToTray）/销毁（轻量模式）时无 UI 消费者，
      // 跳过 broadcast（流仍维护快照）。读模块级 mainWindow 当前值（创建/销毁会变）。
      () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    );
    // 杀核前静默 StatsService：停其到管理 API 的 Status/Connections gRPC 流（核将死，提前 cancel 避免 RST 噪音）。
    proxyManager.setQuiesceStats(() => {
      statsService?.stop();
    });

    // 出口 IP 信息：经探针 inbound 测本地直连出口 / 代理出口，事件驱动刷新（无周期轮询）
    ipInfoService = new IpInfoService(
      () => proxyManager?.getProbePorts() ?? null,
      () => proxyManager?.getStatus().running ?? false,
      (snap) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_IP_INFO_UPDATED, snap)
    );
    // 启动后拉一次本地直连出口 IP 初值
    setTimeout(() => void ipInfoService?.refresh(true), 2000);

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

    // 初始化自动换节点服务
    autoSwitchService = new AutoSwitchService(
      configManager,
      proxyManager,
      logManager,
      () => mainWindow
    );
    // 根据当前配置决定是否启用
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
      }
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

    // 自动空闲模式：powerMonitor 真实系统输入空闲轮询（app ready 后才可用），替代窗口 blur/hide 边沿武装
    idleCheckInterval = setInterval(() => void checkIdleAutoModes(), IDLE_POLL_MS);

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
      // stats 订阅【不】在此发起：emit('started') 早于 ProxyManager 创建 api client（startInternal 末尾）约 0.5s，
      // 此刻 getApiClient()=null、subscribe* 早退（首页 stats 全 0 根因）。改挂 'api-client-ready'（见下）。
      subscriptionScheduler?.onProxyStarted(); // 代理就绪 → 补跑因 viaProxy 跳过的启动订阅更新
      try {
        await coreUpdateService.recordSuccessfulVersion();
        logManager.addLog('info', '已记录当前运行的内核版本基线', 'Main');
      } catch (e) {
        logManager.addLog('warn', `记录内核基线版本失败: ${e}`, 'Main');
      }

      // 代理就绪后延迟刷新出口 IP（等 selector / 探针 inbound 起来）。direct 走常规 refresh(true)；
      // proxy 出口改走 refreshProxyPostConnect（首连专用更宽退避，覆盖 TS/组网首连隧道未就绪的几秒窗口，
      // 全程转圈不闪「暂不可用」）。隧道一就绪由下方 'tailscale-selected-running' 事件链式 refreshProxy 抢先出真值。
      setTimeout(() => {
        void ipInfoService?.refresh(true);
        void ipInfoService?.refreshProxyPostConnect();
      }, 1500);
    });

    // item 1 事件驱动出口 re-probe：选中的账号制（TS）节点隧道翻 Running（就绪）→ 立即重测代理出口，
    // 不等首连退避耗尽。ProxyManager 在 STATUS 流上升沿去重发射，故此处无需再防抖；refreshProxy 经 enqueue
    // 链式排到在途首探之后，隧道一就绪即取到真出口 IP（消除「转圈直到退避耗尽」的长盲等）。
    proxyManager.on('tailscale-selected-running', () => {
      void ipInfoService?.refreshProxy();
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
      if (accountBased) {
        void ipInfoService?.refreshProxyPostConnect();
      } else {
        void ipInfoService?.refreshProxy();
      }
    });

    proxyManager.on('stopped', () => {
      statsService?.stop();

      // 停止后重测出口 IP（proxy 置 null，direct 走主进程裸直连）
      void ipInfoService?.refresh(true);

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
    registerLogHandlers(logManager, proxyManager);
    registerProxyHandlers(proxyManager, statsService);
    registerIpInfoHandlers(ipInfoService);
    registerSystemHandlers();
    registerRuleResourceHandlers(ruleResourceManager);
    registerVersionHandlers(coreUpdateService);

    registerRulesHandlers(configManager);

    // 注册核心更新处理器
    setCoreUpdateService(coreUpdateService, logManager);
    registerCoreUpdateHandlers();

    // 注册自启动处理器
    registerAutoStartHandlers();

    // 注册订阅处理器
    registerSubscriptionHandlers(subscriptionService, configManager);

    // 注册备份与恢复处理器（注入 ruleResourceManager：恢复后补缺失的规则资源 .srs）
    registerBackupHandlers(configManager, ruleResourceManager);

    // 注册诊断报告处理器（汇集环境/脱敏配置/日志 tail → 单 Markdown）。此处 proxyManager 已构造（非空）。
    if (proxyManager) {
      const diagnosticService = new DiagnosticService(
        configManager,
        logManager,
        proxyManager,
        systemProxyManager,
        getPrivacyMode
      );
      registerDiagnosticHandlers(diagnosticService);
    }

    // 注册提权 helper 处理器（macOS 免提权启停）
    registerHelperHandlers(helperManager, proxyManager);

    // 同步自启动状态
    const autoStartManager = createAutoStartManager();
    autoStartManager.setLogManager(logManager);
    const config = await configManager.loadConfig();
    await autoStartManager.setAutoStart(config.autoStart ?? false);

    // 注册更新处理器
    setUpdateService(updateService);
    updateService.setMainWindow(mainWindow);
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

    // 设置托盘状态更新回调
    setTrayStateCallback((isRunning: boolean, hasError?: boolean) => {
      updateTrayMenuState(isRunning, hasError);
    });

    // 监听渲染进程语言同步（架构 review：改走 registerIpcHandler 统一 ApiResponse 契约 + 进注册表，
    // 原裸 ipcMain.handle 是 19 个 handler 中唯一例外，绕过 wrapper 且无返回值）
    registerIpcHandler<string, void>(IPC_CHANNELS.APP_SET_LANGUAGE, (_event, lang: string) => {
      currentLanguage = lang || currentLanguage;
      setMainLanguage(currentLanguage); // 主进程 i18n（桌面通知等）同步语言
      if (trayManager) {
        trayManager.setLanguage(lang);
      }
    });

    // 节点列表「按延迟排序」开关同步：渲染端 App.tsx 在 mount（cold-start 一次同步）+ 每次切换时推送，
    // 使托盘节点列表与下拉同序（幂等，TrayManager.setSortByLatency 同态 no-op 不重建菜单）。
    registerIpcHandler<boolean, void>(
      IPC_CHANNELS.APP_SET_NODE_SORT_BY_LATENCY,
      (_event, value: boolean) => {
        currentNodeSortByLatency = !!value; // 记住最近值，供 tray 创建后补应用（防早到 push 被丢）
        trayManager?.setSortByLatency(currentNodeSortByLatency);
      }
    );

    // 创建托盘图标
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
      })
    );
    trayManager.createTray();
    // 补应用「按延迟排序」开关：若渲染端 mount 推送早于本行（极端时序），上面 handler 的 trayManager?. 已丢弃该值，
    // 此处用持有的最近值兜底（幂等：默认 false 时 no-op）。覆盖「持久 true 偏好在冷启被丢、托盘整会话停默认序」。
    trayManager.setSortByLatency(currentNodeSortByLatency);

    // 初始化托盘菜单状态
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
// 清理 memoized promise：多入口（will-quit / SIGTERM / 托盘 app.quit）共享同一次清理。
// 用 promise 而非 boolean：并发的第二入口 await 同一进行中的清理，避免 process.exit 拦腰截断它。
let cleanupPromise: Promise<void> | null = null;
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (!gotTheLock) return;
  // 在 macOS 上，即使所有窗口关闭，应用也应该继续运行（托盘模式）
  // 在其他平台上，如果启用了托盘，也应该继续运行
  // 判「图标真实存在」而非对象引用：createTray 失败被静默吞时 trayManager 非 null 但无图标 →
  // 无窗口 + 无图标仍驻留 = 不可达僵尸。hasTray() 兜住此情形。
  if (process.platform !== 'darwin' && !trayManager?.hasTray()) {
    app.quit();
  }
});

// 使用 will-quit 事件来清理资源
app.on('will-quit', async (_event) => {
  if (!gotTheLock) return;
  // 阻止默认退出，先清理资源
  _event.preventDefault();

  try {
    // 清理资源
    await cleanupResources();

    // 清理托盘图标
    if (trayManager) {
      trayManager.destroyTray();
      trayManager = null;
    }

    // 现在可以安全退出了
    app.exit(0);
  } catch (error) {
    console.error('Error during app quit:', error);
    // 即使清理失败，也要退出
    app.exit(1);
  }
});

// 处理 SIGINT 和 SIGTERM 信号
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
