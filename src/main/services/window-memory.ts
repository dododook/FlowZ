import { BrowserWindow } from 'electron';
import { LogManager } from './LogManager';

/** 销毁窗口后延迟触发内存清理的宽限（ms）：等窗口销毁事件完全传播，避免与销毁过程竞态。 */
const MEMORY_CLEANUP_DELAY_MS = 500;

export interface ReleaseWindowMemoryDeps {
  window: BrowserWindow;
  logManager: LogManager;
  /**
   * 是否延迟清空内存日志缓冲 + 磁盘 app.log（含轮转备份）+ 触发手动 V8 GC。默认 false——普通关窗
   * 只销毁渲染进程释放内存，不动日志：这一步原本只在「进入轻量模式」这个明确的主动操作里触发，若
   * 挂在每次普通关窗上，会在「关闭后 500ms 内又重新打开」或「关闭后随即退出」时，把新窗口刚生成的
   * 日志、或 will-quit 清理阶段正在写入的关键日志一并冲掉。仅 TrayManager 轻量模式路径传 true。
   */
  clearLogsAndGc?: boolean;
  /** 写进销毁日志的触发来源（如 'close'/'lightweight-mode'），供事后从 app.log 区分是哪条路径销毁的。 */
  reason?: string;
}

/**
 * 主窗渲染进程崩溃自愈的崩溃循环检测（纯逻辑，供单测）。滑动窗口内累计崩溃次数超阈值 → 判为崩溃循环
 * （损坏安装 / 持续 OOM），调用方据此停止自动重建，防 destroy→重建→再崩的 CPU 空转。
 * @returns recent 剪枝并追加本次时刻后的时间戳数组；isLoop 是否超阈值。
 */
export function detectRenderCrashLoop(
  timestamps: number[],
  now: number,
  windowMs = 60_000,
  maxCrashes = 3
): { recent: number[]; isLoop: boolean } {
  const recent = timestamps.filter((t) => now - t < windowMs);
  recent.push(now);
  return { recent, isLoop: recent.length > maxCrashes };
}

/**
 * 供「关窗释放内存」（index.ts 主窗口 close 处理）与「托盘/空闲轻量模式」（TrayManager 经
 * tray-actions.ts 的 onLightweightMode）共用，避免两处各自维护一份销毁逻辑。
 */
export function releaseWindowMemory(deps: ReleaseWindowMemoryDeps): void {
  const { window, logManager, clearLogsAndGc = false, reason } = deps;
  if (window.isDestroyed()) return;

  window.destroy();
  logManager.addLog(
    'info',
    reason
      ? `Window destroyed to release memory (${reason})`
      : 'Window destroyed to release memory',
    'Main'
  );

  if (!clearLogsAndGc) return;

  setTimeout(() => {
    logManager.clearLogs();
    if (typeof (global as any).gc === 'function') {
      (global as any).gc();
    }
  }, MEMORY_CLEANUP_DELAY_MS);
}
