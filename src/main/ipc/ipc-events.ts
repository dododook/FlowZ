/**
 * IPC 事件发送器
 * 用于从主进程向渲染进程发送事件
 */

import { BrowserWindow, WebContents } from 'electron';

/**
 * IPC 事件发送器类
 */
export class IpcEventEmitter {
  private windows: Set<BrowserWindow> = new Set();

  /**
   * 注册窗口以接收事件
   */
  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);

    // 当窗口关闭时自动注销
    window.on('closed', () => {
      this.windows.delete(window);
    });
  }

  /**
   * 注销窗口
   */
  unregisterWindow(window: BrowserWindow): void {
    this.windows.delete(window);
  }

  /**
   * 向所有注册的窗口发送事件
   */
  sendToAll<T = any>(channel: string, data: T): void {
    for (const window of this.windows) {
      if (!window.isDestroyed() && window.webContents) {
        window.webContents.send(channel, data);
      }
    }
  }

  /**
   * 向特定窗口发送事件
   */
  sendToWindow<T = any>(window: BrowserWindow, channel: string, data: T): void {
    if (!window.isDestroyed() && window.webContents) {
      window.webContents.send(channel, data);
    }
  }

  /**
   * 向特定 WebContents 发送事件
   */
  sendToWebContents<T = any>(webContents: WebContents, channel: string, data: T): void {
    if (!webContents.isDestroyed()) {
      webContents.send(channel, data);
    }
  }

  /**
   * 获取已注册的窗口数量
   */
  getWindowCount(): number {
    return this.windows.size;
  }

  /**
   * 清理所有窗口引用
   */
  clear(): void {
    this.windows.clear();
  }
}

/**
 * 全局 IPC 事件发送器实例
 */
export const ipcEventEmitter = new IpcEventEmitter();

/**
 * 便捷函数：向所有窗口广播事件
 */
export function broadcastEvent<T = any>(channel: string, data: T): void {
  ipcEventEmitter.sendToAll(channel, data);
}
