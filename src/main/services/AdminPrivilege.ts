/**
 * 管理员权限管理服务
 * 用于检测权限状态
 *
 * 重要说明：
 * 在 macOS 上，整个 Electron 应用不应以 root 权限运行，否则会导致：
 * - 托盘图标不显示
 * - Dock 栏显示"应用程序没有响应"
 * - 配置文件路径变为 /var/root/...，导致配置隔离
 *
 * 正确的做法是：Electron 应用以普通用户身份运行，只有需要特权的
 * 子进程（如 TUN 模式的 sing-box）通过 osascript 请求管理员权限运行。
 * 这部分逻辑已在 ProxyManager.ts 中实现。
 */

import { system32 } from '../utils/win-system32';

export interface IAdminPrivilege {
  isAdmin(): boolean;
  needsElevationForTun(): boolean;
}

/**
 * 检测当前进程是否以管理员权限运行
 */
export function isRunningAsAdmin(): boolean {
  if (process.platform === 'win32') {
    return isWindowsAdmin();
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    return isMacOSAdmin(); // id -u works on both macOS and Linux
  }
  return false;
}

/**
 * Windows 管理员权限检测
 * 通过尝试访问需要管理员权限的注册表项来判断
 */
function isWindowsAdmin(): boolean {
  try {
    const { execSync } = require('child_process');
    // 绝对路径调 net.exe：PATH 缺 System32 时裸 `net session` 会 command-not-found，
    // catch 误判为"非管理员" → 触发多余 UAC/功能降级（同 reg 未找到的根因）。
    execSync(`"${system32('net.exe')}" session`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * macOS 管理员权限检测
 */
function isMacOSAdmin(): boolean {
  try {
    const { execSync } = require('child_process');
    const result = execSync('id -u', { encoding: 'utf-8' }).trim();
    return result === '0';
  } catch {
    return false;
  }
}

/**
 * 管理员权限服务类
 */
export class AdminPrivilegeService implements IAdminPrivilege {
  private _isAdmin: boolean | null = null;

  /**
   * 检测当前是否有管理员权限（带缓存）
   */
  isAdmin(): boolean {
    if (this._isAdmin === null) {
      this._isAdmin = isRunningAsAdmin();
    }
    return this._isAdmin;
  }

  /**
   * 检查 TUN 模式是否需要提升权限
   * 返回 false 因为我们不再通过重启应用来提升权限
   * sing-box 进程会在 TUN 模式下通过 osascript 自己请求管理员权限
   */
  needsElevationForTun(): boolean {
    return false;
  }

  /**
   * 清除缓存的权限状态
   */
  clearCache(): void {
    this._isAdmin = null;
  }
}

// 导出单例
export const adminPrivilegeService = new AdminPrivilegeService();
