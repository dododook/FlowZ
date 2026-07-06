/**
 * Preload 脚本
 * 在渲染进程中暴露安全的 IPC 接口
 */

import { contextBridge, ipcRenderer, IpcRendererEvent, webFrame } from 'electron';
import type { RendererHeapSample } from '../shared/process-metrics';

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
  /**
   * 渲染进程堆内省（issue #242 §6.2 泄漏观测）：main 经 executeJavaScript('window.electron.getRendererDiagnostics()')
   * 取一次堆分层用于诊断导出。sandbox:false 下 preload 可用 process/webFrame；各取数独立 try/catch，任一取不到只
   * 缺省该字段（不整体失败）。返回原始 Electron 口径（heap/processMemory=KB，resources=bytes），main 侧再换算 MB。
   */
  getRendererDiagnostics: async (): Promise<RendererHeapSample> => {
    const out: RendererHeapSample = {};
    try {
      const p = process as NodeJS.Process & {
        getHeapStatistics?: () => Record<string, number>;
        getProcessMemoryInfo?: () => Promise<Record<string, number>>;
      };
      if (typeof p.getHeapStatistics === 'function')
        out.heap = p.getHeapStatistics() as RendererHeapSample['heap'];
      if (typeof p.getProcessMemoryInfo === 'function')
        out.processMemory = (await p.getProcessMemoryInfo()) as RendererHeapSample['processMemory'];
    } catch {
      /* 忽略：字段缺省 */
    }
    try {
      out.resources = webFrame.getResourceUsage() as unknown as RendererHeapSample['resources'];
    } catch {
      /* 忽略：字段缺省 */
    }
    return out;
  },
  ipcRenderer: {
    /**
     * 调用主进程方法
     */
    invoke: <T = any>(channel: string, args?: any): Promise<T> => {
      return ipcRenderer.invoke(channel, args);
    },

    /**
     * 监听主进程事件，返回「身份守恒」的退订闭包。
     *
     * 为什么退订不能靠渲染层把 listener 再传回来：跨 contextBridge 每传一次函数都会生成一个新 proxy，
     * 退订时传回的 proxy ≠ 注册时的 proxy → ipcRenderer.removeListener 按引用比对失败、静默 no-op，
     * 监听器泄漏（#242：窗口最小化/恢复循环每轮 detach/attach 净增一个 EVENT_<topic> 监听器，旧监听器
     * 仍持续触发，CPU 攀升）。
     * 解法：在 preload/Node 侧自建 wrappedListener 并注册，退订闭包在同侧直接 removeListener 同一引用——
     * 退订全程不跨界、不依赖函数身份守恒，proxy 每次新建也无妨。
     */
    on: (
      channel: string,
      listener: (event: IpcRendererEvent, ...args: any[]) => void
    ): (() => void) => {
      const wrappedListener = (event: IpcRendererEvent, ...args: any[]) => listener(event, ...args);
      ipcRenderer.on(channel, wrappedListener);
      return () => {
        ipcRenderer.removeListener(channel, wrappedListener);
      };
    },

    /**
     * 监听主进程事件（仅一次）
     */
    once: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
      ipcRenderer.once(channel, listener);
    },

    /**
     * 取消监听主进程事件（旧路径，身份不守恒——渲染层传回的 listener 是新 proxy，removeListener 多为 no-op）。
     * 现役退订走 on() 返回的闭包；此方法仅保留兼容，实际退订应优先用 on 的返回值 / removeAllListeners 兜底。
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
