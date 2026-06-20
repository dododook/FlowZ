/**
 * Preload 脚本
 * 在渲染进程中暴露安全的 IPC 接口
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/**
 * 暴露给渲染进程的 Electron API
 */
const electronAPI = {
  platform: process.platform,
  // CPU 架构（'x64'/'arm64'/...）：渲染层 TLS spoof 等按 arch 门控的特性用（ARM64 不支持）。
  arch: process.arch,
  ipcRenderer: {
    /**
     * 调用主进程方法
     */
    invoke: <T = any>(channel: string, args?: any): Promise<T> => {
      return ipcRenderer.invoke(channel, args);
    },

    /**
     * 监听主进程事件
     */
    on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
      ipcRenderer.on(channel, listener);
    },

    /**
     * 监听主进程事件（仅一次）
     */
    once: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
      ipcRenderer.once(channel, listener);
    },

    /**
     * 取消监听主进程事件
     */
    off: (channel: string, listener: (...args: any[]) => void) => {
      ipcRenderer.off(channel, listener);
    },

    /**
     * 移除所有监听器
     */
    removeAllListeners: (channel: string) => {
      ipcRenderer.removeAllListeners(channel);
    },
  },
};

/**
 * 通过 contextBridge 暴露 API
 */
contextBridge.exposeInMainWorld('electron', electronAPI);

/**
 * TypeScript 类型声明
 */
export type ElectronAPI = typeof electronAPI;
