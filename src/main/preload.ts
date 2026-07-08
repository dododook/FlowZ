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
 * off 账本：listener proxy → (channel → wrapped 栈)。on 注册时记账，off(channel, listener) 据此取回
 * preload 侧真实注册的 wrapped 引用完成退订（跨 contextBridge 函数身份不守恒，直调 ipcRenderer.off 多为
 * no-op）。WeakMap 键随渲染层函数代理回收，不阻止 GC、无泄漏。
 */
const offLedger = new WeakMap<
  (...args: any[]) => void,
  Map<string, ((event: IpcRendererEvent, ...args: any[]) => void)[]>
>();

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
      // 账本：按 (listener proxy, channel) 记 wrapped，供 off(channel, listener) 真退订。
      // contextBridge 对同一渲染层函数的重复跨界若保持 proxy 身份则账本命中；不保持则 off 回退直调（不劣于原状）。
      let byChannel = offLedger.get(listener);
      if (!byChannel) {
        byChannel = new Map();
        offLedger.set(listener, byChannel);
      }
      const stack = byChannel.get(channel) ?? [];
      stack.push(wrappedListener);
      byChannel.set(channel, stack);
      return () => {
        ipcRenderer.removeListener(channel, wrappedListener);
        const s = offLedger.get(listener)?.get(channel);
        if (s) {
          const i = s.indexOf(wrappedListener);
          if (i >= 0) s.splice(i, 1);
        }
      };
    },

    /**
     * 监听主进程事件（仅一次）
     */
    once: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
      ipcRenderer.once(channel, listener);
    },

    /**
     * 取消监听主进程事件。先查账本按 (listener, channel) 取 wrapped 真退订（LIFO 取最近注册的一个，
     * 与 EventEmitter removeListener 语义一致）；账本未命中（proxy 身份未保持/未经 on 注册）回退直调
     * ipcRenderer.off——原路径，多为 no-op 但不劣化。现役退订仍首选 on() 返回的闭包。
     */
    off: (channel: string, listener: (...args: any[]) => void) => {
      const stack = offLedger.get(listener as (...args: any[]) => void)?.get(channel);
      const wrapped = stack?.pop();
      if (wrapped) {
        ipcRenderer.removeListener(channel, wrapped as (...args: any[]) => void);
        return;
      }
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
