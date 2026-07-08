/**
 * IPC 处理器注册和管理
 * 提供类型安全的 IPC 处理器注册功能
 */

import { app, ipcMain, IpcMainInvokeEvent } from 'electron';
import { ApiResponse } from '../../shared/types';
import { IpcChannel } from '../../shared/ipc-channels';
import type { LogManager } from '../services/LogManager';

/** 开发环境标识（与 index.ts 一致：仅 NODE_ENV=development 暴露堆栈等调试信息） */
const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * 可选的 LogManager 实例（由 main/index.ts 在启动期经 setIpcLogger 注入）。
 * 用于生产期把「同名 channel 重复注册」这类异常记入应用日志（开发期直接抛错，无需此实例）。
 */
let ipcLogger: LogManager | null = null;

/**
 * 注入 LogManager 供 IPC 注册器在生产环境记录异常（如同名 channel 重复注册）。
 * 在 main/index.ts 创建 LogManager 之后、注册任何 IPC handler 之前调用一次。
 */
export function setIpcLogger(logManager: LogManager | null): void {
  ipcLogger = logManager;
}

/**
 * IPC 处理器函数类型
 */
export type IpcHandler<TArgs = any, TResult = any> = (
  event: IpcMainInvokeEvent,
  args: TArgs
) => Promise<TResult> | TResult;

/**
 * IPC 处理器注册器类
 * 提供统一的错误处理和响应包装
 */
export class IpcHandlerRegistry {
  private handlers: Map<IpcChannel, IpcHandler> = new Map();

  /**
   * 注册 IPC 处理器
   * @param channel IPC 通道名称（收紧为 IpcChannel 联合类型，编译期根治孤儿字面量）
   * @param handler 处理器函数
   */
  register<TArgs = any, TResult = any>(
    channel: IpcChannel,
    handler: IpcHandler<TArgs, TResult>
  ): void {
    if (this.handlers.has(channel)) {
      // 同名 channel 二次注册是 bug（后注册者静默覆盖前者，导致前者的 handler 失效且难排查）。
      // 开发期直接抛错及早暴露；生产期不能崩主进程，改为记入 LogManager 供事后排查。
      const msg = `IPC handler for channel "${channel}" is already registered. Overwriting.`;
      if (!app.isPackaged) {
        throw new Error(msg);
      }
      ipcLogger?.addLog('warn', msg, 'IpcHandlerRegistry');
    }

    // 包装处理器，添加错误处理和响应格式化
    const wrappedHandler = async (
      event: IpcMainInvokeEvent,
      args: TArgs
    ): Promise<ApiResponse<TResult>> => {
      try {
        const result = await handler(event, args);

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        console.error(`[IPC] Error handling channel "${channel}":`, error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = (error as any)?.code;
        const errorStack = error instanceof Error ? error.stack : undefined;

        // 记录详细错误堆栈：仅开发环境输出，生产环境不暴露堆栈
        if (isDevelopment && errorStack) {
          console.error(`[IPC] Stack trace:`, errorStack);
        }

        return {
          success: false,
          error: errorMessage,
          code: errorCode,
        };
      }
    };

    this.handlers.set(channel, wrappedHandler);
    // 覆盖注册前必须先摘除旧 handler：Electron 的 ipcMain.handle 对同名 channel 二次调用会直接
    // throw "Attempted to register a second handler"。生产分支已选择「不崩、记 warn 后覆盖」，若不先
    // removeHandler，紧随的 handle 仍会抛崩主进程，与「生产不崩」意图相悖。removeHandler 对未注册
    // channel 是安全 no-op（首次注册无副作用），与 unregister() 的用法一致。
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrappedHandler);
  }

  /**
   * 注销 IPC 处理器
   * @param channel IPC 通道名称
   */
  unregister(channel: IpcChannel): void {
    if (this.handlers.has(channel)) {
      ipcMain.removeHandler(channel);
      this.handlers.delete(channel);
    }
  }

  /**
   * 注销所有 IPC 处理器
   */
  unregisterAll(): void {
    for (const channel of this.handlers.keys()) {
      ipcMain.removeHandler(channel);
    }
    this.handlers.clear();
  }

  /**
   * 获取已注册的通道列表
   */
  getRegisteredChannels(): IpcChannel[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 检查通道是否已注册
   */
  isRegistered(channel: IpcChannel): boolean {
    return this.handlers.has(channel);
  }
}

/**
 * 全局 IPC 处理器注册器实例
 */
export const ipcHandlerRegistry = new IpcHandlerRegistry();

/**
 * 便捷函数：注册 IPC 处理器
 */
export function registerIpcHandler<TArgs = any, TResult = any>(
  channel: IpcChannel,
  handler: IpcHandler<TArgs, TResult>
): void {
  ipcHandlerRegistry.register(channel, handler);
}
