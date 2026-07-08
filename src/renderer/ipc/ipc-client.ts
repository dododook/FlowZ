/**
 * 渲染进程 IPC 客户端
 * 提供类型安全的 IPC 调用封装
 */

import { ApiResponse } from '../../shared/types';

interface ElectronIpcRenderer {
  invoke: <T = any>(channel: string, args?: any) => Promise<T>;
  // on 返回身份守恒的退订闭包（在 preload/Node 侧 removeListener 同一引用）；退订不再跨界传 listener。
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => () => void;
  once: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
  off: (channel: string, listener: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

/**
 * 获取 IPC Renderer 实例
 */
function getIpcRenderer(): ElectronIpcRenderer {
  if (!window.electron?.ipcRenderer) {
    console.warn('IPC Renderer is not available. Using mock for browser preview.');
    return {
      invoke: async <T>() => ({ success: true, data: [] }) as unknown as T,
      on: () => () => {},
      once: () => {},
      off: () => {},
      removeAllListeners: () => {},
    };
  }
  return window.electron.ipcRenderer as ElectronIpcRenderer;
}

/**
 * IPC 客户端类
 * 提供类型安全的 IPC 调用和事件监听
 */
type EventListener = (...args: any[]) => void;

export class IpcClient {
  private ipcRenderer: ElectronIpcRenderer;
  private eventListeners: Map<string, Set<EventListener>> = new Map();

  constructor() {
    this.ipcRenderer = getIpcRenderer();
  }

  /**
   * 调用主进程方法
   * @param channel IPC 通道名称
   * @param args 参数
   * @returns 响应数据
   */
  async invoke<TArgs = any, TResult = any>(channel: string, args?: TArgs): Promise<TResult> {
    try {
      const response = (await this.ipcRenderer.invoke(channel, args)) as ApiResponse<TResult>;

      if (!response.success) {
        const error = new Error(response.error || 'Unknown error');
        (error as any).code = response.code;
        throw error;
      }

      return response.data as TResult;
    } catch (error) {
      console.error(`[IPC Client] Error invoking ${channel}:`, error);
      throw error;
    }
  }

  /**
   * 监听主进程事件
   * @param channel 事件通道名称
   * @param listener 事件监听器
   * @returns 取消监听函数
   */
  on<T = any>(channel: string, listener: (data: T) => void): () => void {
    // 包装监听器以提取数据
    const wrappedListener = (_event: any, data: T) => {
      listener(data);
    };

    // 注册监听器；preload.on 返回身份守恒的退订闭包（在 Node 侧 removeListener 同一 wrappedListener）。
    // 退订走此闭包，而非把 wrappedListener 再传回 preload.off——跨 contextBridge 会生成新 proxy，
    // 身份不匹配导致 removeListener 静默 no-op、监听器泄漏（#242）。
    const unsubscribe = this.ipcRenderer.on(channel, wrappedListener);

    // 记录监听器以便 removeAllListeners 兜底 / getListenerCount 自检
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
    }
    this.eventListeners.get(channel)!.add(wrappedListener);

    // 返回取消监听函数：调身份守恒的退订闭包 + 清理本地账本
    return () => {
      unsubscribe();
      const listeners = this.eventListeners.get(channel);
      if (listeners) {
        listeners.delete(wrappedListener);
        if (listeners.size === 0) {
          this.eventListeners.delete(channel);
        }
      }
    };
  }

  /**
   * 监听主进程事件（仅一次）
   * @param channel 事件通道名称
   * @param listener 事件监听器
   */
  once<T = any>(channel: string, listener: (data: T) => void): void {
    const wrappedListener = (_event: any, data: T) => {
      listener(data);
    };

    this.ipcRenderer.once(channel, wrappedListener);
  }

  /**
   * 取消监听主进程事件
   * @param channel 事件通道名称
   * @param listener 事件监听器（可选，不提供则移除所有监听器）
   */
  off(channel: string, listener?: EventListener): void {
    if (listener) {
      this.ipcRenderer.off(channel, listener as any);

      const listeners = this.eventListeners.get(channel);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.eventListeners.delete(channel);
        }
      }
    } else {
      this.ipcRenderer.removeAllListeners(channel);
      this.eventListeners.delete(channel);
    }
  }

  /**
   * 移除所有事件监听器
   */
  removeAllListeners(): void {
    for (const channel of this.eventListeners.keys()) {
      this.ipcRenderer.removeAllListeners(channel);
    }
    this.eventListeners.clear();
  }

  /**
   * 获取已注册的事件通道列表
   */
  getRegisteredChannels(): string[] {
    return Array.from(this.eventListeners.keys());
  }

  /**
   * 获取指定通道的监听器数量
   */
  getListenerCount(channel: string): number {
    return this.eventListeners.get(channel)?.size || 0;
  }
}

/**
 * 全局 IPC 客户端实例
 */
export const ipcClient = new IpcClient();

/**
 * 便捷函数：调用主进程方法
 */
export async function invoke<TArgs = any, TResult = any>(
  channel: string,
  args?: TArgs
): Promise<TResult> {
  return ipcClient.invoke<TArgs, TResult>(channel, args);
}

/**
 * 便捷函数：监听主进程事件
 */
export function on<T = any>(channel: string, listener: (data: T) => void): () => void {
  return ipcClient.on<T>(channel, listener);
}

/**
 * 便捷函数：监听主进程事件（仅一次）
 */
export function once<T = any>(channel: string, listener: (data: T) => void): void {
  ipcClient.once<T>(channel, listener);
}

/**
 * 便捷函数：取消监听主进程事件
 */
export function off(channel: string, listener?: EventListener): void {
  ipcClient.off(channel, listener);
}
