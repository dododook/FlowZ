/**
 * 路径工具函数
 * 确保在任何权限上下文中都能获取正确的用户数据路径
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 缓存的用户数据路径（在应用启动时以普通用户身份运行时确定）
 */
let cachedUserDataPath: string | null = null;

/**
 * 检测便携模式下的数据路径
 * 检查环境变量或可执行文件同级目录是否存在 userdata 或 data 文件夹
 */
function getPortableDataPath(): string | null {
  // 1. 优先检查 electron-builder 设置的便携版环境变量
  // PORTABLE_EXECUTABLE_DIR 是 Windows 便携版 EXE 所在的目录
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }

  if (!app.isPackaged) return null;

  try {
    const exePath = app.getPath('exe');
    let appDir = path.dirname(exePath);

    // macOS 特殊处理：.app 包的同级目录
    if (process.platform === 'darwin') {
      // FlowZ.app/Contents/MacOS/FlowZ -> FlowZ.app/Contents/MacOS -> FlowZ.app/Contents -> FlowZ.app -> Parent
      appDir = path.join(appDir, '../../..');
    }

    const portableData = path.join(appDir, 'data');
    if (fs.existsSync(portableData)) return portableData;

    const portableUserdata = path.join(appDir, 'userdata');
    if (fs.existsSync(portableUserdata)) return portableUserdata;
  } catch {
    // 忽略错误
  }
  return null;
}

/**
 * 提权（root）运行时解析「真实登录用户」的家目录；普通用户 / 解析失败返回 null（用 Electron 默认）。
 * 不硬编码 /home 或 /Users 前缀——兼容 usermod -d 改过的非标准家目录（架构 review #12）。
 *
 * 优先级：
 *  1) HOME 指向真实用户家（多数 sudoers 保留 HOME；取决于 env_reset/always_set_home）→ 直接采信，兼容自定义路径；
 *  2) HOME 是 root 家（env_reset / sudo -i）→ 用 SUDO_USER 经 /etc/passwd 反查（Linux，兼容 usermod -d）；
 *     macOS 常规用户不在 /etc/passwd（走 Open Directory），退回 /Users/<user> 系统约定。
 *
 * 覆盖范围：sudo 系提权（HOME 保留 或 SUDO_USER 存在）。pkexec 整 app 提权不在范围——其设 HOME=/root、
 * 不设 SUDO_USER（仅 PKEXEC_UID），两条均 miss → 回落默认；FlowZ 的 pkexec 仅用于 helper 脚本而非整 app
 * 提权，故现实影响小（与改动前行为一致，非回归）。
 */
function resolveElevatedRealHome(): string | null {
  const isUnixRoot =
    (process.platform === 'darwin' || process.platform === 'linux') &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0;
  if (!isUnixRoot) return null;

  const home = process.env.HOME;
  if (home && home !== '/root' && home !== '/var/root') return home;

  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== 'root') {
    const fromPasswd = lookupHomeFromPasswd(sudoUser);
    if (fromPasswd) return fromPasswd;
    if (process.platform === 'darwin') return `/Users/${sudoUser}`;
  }
  return null;
}

/**
 * 解析 /etc/passwd 文本，取 username 的家目录（第 6 字段 home）。纯函数（IO 分离，便于单测）。
 * 跳过注释行 / 空行 / 字段不足；精确匹配用户名；兼容 usermod -d 的非标准家目录。
 */
export function parsePasswdHome(content: string, username: string): string | null {
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split(':'); // name:passwd:uid:gid:gecos:home:shell
    if (f[0] === username && f[5]) return f[5];
  }
  return null;
}

/** 从 /etc/passwd 取用户名对应家目录（同步、零依赖）；无文件 / 读失败 / 查不到返回 null。 */
function lookupHomeFromPasswd(username: string): string | null {
  try {
    return parsePasswdHome(fs.readFileSync('/etc/passwd', 'utf8'), username);
  } catch {
    return null; // 无 /etc/passwd（如 macOS 常规用户）或读取失败 → 由调用方回退
  }
}

/**
 * root 提权修正后的 userData 路径；非提权 / 解析失败返回 null。
 * 与 Electron 默认布局一致：macOS=~/Library/Application Support/<app>，Linux=~/.config/<app>（XDG）。
 */
function resolveElevatedUserDataPath(): string | null {
  const realHome = resolveElevatedRealHome();
  if (!realHome) return null;
  const appName = app.getName() || 'FlowZ';
  return process.platform === 'darwin'
    ? path.join(realHome, 'Library/Application Support', appName)
    : path.join(realHome, '.config', appName);
}

/**
 * 获取正确的用户数据路径。
 *
 * 以 root 运行时 app.getPath('userData') 解析到 /var/root（mac）或 /root（Linux），需回退真实用户家目录，
 * 否则内核 / 配置 / marker 等跨用户目录分裂。修正与缓存由 initUserDataPath() 统一完成（便携 / root / 默认
 * 三态，见其说明）；此处缓存未命中即委托它（而非另写一套优先级），保证两入口单一真值、不漏便携分支。
 */
export function getUserDataPath(): string {
  if (!cachedUserDataPath) {
    initUserDataPath();
  }
  return cachedUserDataPath ?? app.getPath('userData');
}

/** 把路径下沉给 Electron（必须在 app.requestSingleInstanceLock() 之前调用）。 */
function applyUserDataPath(p: string): void {
  try {
    app.setPath('userData', p);
  } catch (e) {
    console.error('[Paths] Failed to set userData path:', e);
  }
}

/**
 * 设置用户数据路径（应在应用启动时尽早调用：index.ts 模块加载即调用，早于任何 service 构造）。
 *
 * 三态，命中便携 / root 修正时均 setPath 下沉给 Electron，使后续所有 app.getPath('userData')（含 paths
 * 之外 ~13 处直接调用的消费点）自动统一到正确路径：
 *  - 便携模式：重定向到可执行文件同级 data 目录；
 *  - root 提权：回退真实用户家目录。根治：原 root 修正在 getUserDataPath 内，但本函数在模块加载即把
 *    app.getPath('userData') 缓存死，getUserDataPath 的修正被 cache 屏蔽、从不执行——已用单测坐实；
 *  - 普通用户：用 Electron 默认。
 */
export function initUserDataPath(): void {
  if (cachedUserDataPath) {
    return;
  }

  // 1) 便携模式优先
  const portablePath = getPortableDataPath();
  if (portablePath) {
    cachedUserDataPath = portablePath;
    // 确保便携版数据目录存在
    if (!fs.existsSync(cachedUserDataPath)) {
      try {
        fs.mkdirSync(cachedUserDataPath, { recursive: true });
      } catch (e) {
        console.error('[Paths] Failed to create portable data directory:', e);
      }
    }
    applyUserDataPath(cachedUserDataPath);
    return;
  }

  // 2) root 提权修正：下沉 setPath 统一全栈消费点（消除 ~13 处 app.getPath('userData') 绕过）
  const elevated = resolveElevatedUserDataPath();
  if (elevated) {
    cachedUserDataPath = elevated;
    applyUserDataPath(cachedUserDataPath);
    return;
  }

  // 3) 普通用户：缓存 Electron 默认
  cachedUserDataPath = app.getPath('userData');
}

/**
 * 获取配置文件路径
 */
export function getConfigPath(): string {
  return path.join(getUserDataPath(), 'config.json');
}

/**
 * 获取 sing-box 配置文件路径
 */
export function getSingBoxConfigPath(): string {
  return path.join(getUserDataPath(), 'singbox_config.json');
}

/**
 * 获取 sing-box 日志文件路径
 */
export function getSingBoxLogPath(): string {
  return path.join(getUserDataPath(), 'singbox.log');
}

/**
 * 获取 sing-box PID 文件路径
 */
export function getSingBoxPidPath(): string {
  return path.join(getUserDataPath(), 'singbox.pid');
}

/**
 * 获取缓存数据库路径
 */
export function getCachePath(): string {
  return path.join(getUserDataPath(), 'cache.db');
}

/**
 * 规则资源目录（已下载的 .srs + catalog.json 缓存）。与内置 geo 的 <userData>/rules 分目录。
 */
export function getRuleResourcesPath(): string {
  return path.join(getUserDataPath(), 'rule-resources');
}

/**
 * 自定义规则外化目录（每条可外化 customRule 一个 source headless rule_set 文件，fswatch 热重载）。
 * 与内置 geo 的 <userData>/rules、用户 .srs 的 rule-resources 隔离，便于孤儿全量对账清扫。
 */
export function getCustomRulesDir(): string {
  return path.join(getUserDataPath(), 'custom-rules');
}

/**
 * 获取日志目录路径
 */
export function getLogsPath(): string {
  return path.join(getUserDataPath(), 'logs');
}

/**
 * sing-box 官方面板资源缓存目录（dashboard.path）。核首启时若目录为空，从 download_url 拉 zip 解此 + 写 .etag。
 * 改 singboxDashboardUrl 时删此目录使核下次启动重拉；「刷新面板资源」IPC 亦清此目录。
 */
export function getSingboxDashboardDir(): string {
  return path.join(getUserDataPath(), 'singbox-dashboard');
}

/**
 * sing-box 官方面板「运行时下载覆盖」目录（<userData>/dashboard）。
 *
 * 资源策略（见 dashboard #55）：面板默认走**随包内置**（resources/dashboard，打开即时、离线可用、根治慢启动）；
 * 此目录是**可选覆盖**——「刷新面板资源」下载新版到此处后，serve 优先用它（有下载版用下载版，否则回落内置）。
 * 与内置 geo 的 <userData>/rules、用户 .srs 的 rule-resources 分目录，便于独立清扫/重置。
 */
export function getSingboxDashboardOverrideDir(): string {
  return path.join(getUserDataPath(), 'dashboard');
}
