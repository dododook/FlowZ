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
 * 获取正确的用户数据路径
 * 解决以 root 权限运行时 app.getPath('userData') 返回 /var/root/... 的问题
 *
 * 在 macOS 上，当应用以 root 权限运行时：
 * - app.getPath('userData') 返回 /var/root/Library/Application Support/FlowZ
 * - 但我们需要的是 /Users/<actual_user>/Library/Application Support/FlowZ
 *
 * 策略：
 * 1. 如果已缓存路径，直接返回
 * 2. 检查是否以 root 运行，如果是则尝试获取真实用户的路径
 * 3. 否则使用 Electron 的默认路径
 */
export function getUserDataPath(): string {
  if (cachedUserDataPath) {
    return cachedUserDataPath;
  }

  // 获取 Electron 默认的 userData 路径
  let userDataPath = app.getPath('userData');

  // 检查是否在 macOS 上以 root 运行
  if (process.platform === 'darwin' && process.getuid && process.getuid() === 0) {
    // 尝试从环境变量获取真实用户
    const sudoUser = process.env.SUDO_USER;
    const homeDir = process.env.HOME;

    if (sudoUser) {
      // 通过 SUDO_USER 构建正确的路径
      const realUserHome = `/Users/${sudoUser}`;
      const appName = app.getName() || 'FlowZ';
      userDataPath = path.join(realUserHome, 'Library/Application Support', appName);
    } else if (homeDir && homeDir.startsWith('/Users/')) {
      // 通过 HOME 环境变量获取
      const appName = app.getName() || 'FlowZ';
      // 提取用户名
      const match = homeDir.match(/^\/Users\/([^/]+)/);
      if (match) {
        userDataPath = path.join('/Users', match[1], 'Library/Application Support', appName);
      }
    }
  }

  // 缓存路径
  cachedUserDataPath = userDataPath;

  return userDataPath;
}

/**
 * 设置用户数据路径（应在应用启动时尽早调用）
 * 这确保即使后来以 root 运行部分代码，也能使用正确的路径，
 * 并且在便携模式下，Electron 的内部数据也能正确重定向。
 */
export function initUserDataPath(): void {
  if (!cachedUserDataPath) {
    // 优先尝试便携模式路径
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

      // 核心：将 Electron 的 userData 路径重定向到便携目录
      // 注意：这必须在 app.requestSingleInstanceLock() 之前调用
      try {
        app.setPath('userData', cachedUserDataPath);
      } catch (e) {
        console.error('[Paths] Failed to set userData path:', e);
      }
    } else {
      // 在应用启动时（普通用户身份）缓存路径
      cachedUserDataPath = app.getPath('userData');
    }
  }
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
