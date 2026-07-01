/**
 * Preload 脚本
 * 在渲染进程中暴露安全的 IPC 接口
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/**
 * OS 偏好语言（有序）：主进程经 webPreferences.additionalArguments 注入 `--flowz-sys-langs=<JSON>`。
 * 同步可读、无 IPC 时序问题，供 i18n 初始化「自动跟随系统」用（app.getLocale 恒返 en、不可用）。
 */
function readSystemLanguages(): string[] {
  const PREFIX = '--flowz-sys-langs=';
  const arg = process.argv.find((a) => a.startsWith(PREFIX));
  if (!arg) return [];
  try {
    const v = JSON.parse(arg.slice(PREFIX.length));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 界面语言「选择」（config.language 单一真值源）：主进程建窗时经 additionalArguments 注入 `--flowz-lang-choice=<值>`。
 * 同步可读、无 IPC 时序问题，供 i18n 初始化直接用（取代旧的 localStorage['app-language'] 作真值源）。空串=未注入/存量缺键。
 */
function readLanguageChoice(): string {
  const PREFIX = '--flowz-lang-choice=';
  const arg = process.argv.find((a) => a.startsWith(PREFIX));
  return arg ? arg.slice(PREFIX.length) : '';
}

/**
 * 暴露给渲染进程的 Electron API
 */
const electronAPI = {
  platform: process.platform,
  // CPU 架构（'x64'/'arm64'/...）：渲染层 TLS spoof 等按 arch 门控的特性用（ARM64 不支持）。
  arch: process.arch,
  // OS 偏好语言（有序，BCP47）：i18n「自动」解析用；空数组=未注入/取不到。
  systemLanguages: readSystemLanguages(),
  // 界面语言选择（config.language 注入值）：i18n 初始化的真值源；空串=未注入/存量缺键（回退旧 localStorage）。
  languageChoice: readLanguageChoice(),
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
