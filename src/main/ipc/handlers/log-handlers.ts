import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { LogEntry } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { LogManager } from '../../services/LogManager';
import { ProxyManager } from '../../services/ProxyManager';
import { broadcastEvent } from '../ipc-events';

/** 日志 UI 批 flush 间隔（ms）：~150ms 窗口合并多条日志为单次 IPC，渲染端单次 setState。体感无延迟。 */
const LOG_FLUSH_INTERVAL_MS = 150;
/** 不活跃（拖动/隐藏）期 pending 暂存上限：超出丢最旧并计数（落盘不受影响，仅 UI live tail 截断）。 */
const MAX_PENDING_LOG_BATCH = 500;

/**
 * @param isUiActive 可选门控谓词：返回 false（窗口不可见 或 拖动中）时只暂存日志、不广播——拖动期不打断窗口
 *   移动重绘（issue #225），隐藏期无 UI 消费者。活跃后下一 tick 一次性 flush。缺省（未注入，如旧调用）= 始终广播。
 */
export function registerLogHandlers(
  logManager: LogManager,
  proxyManager?: ProxyManager,
  isUiActive?: () => boolean
): void {
  registerIpcHandler<{ limit?: number }, LogEntry[]>(
    IPC_CHANNELS.LOGS_GET,
    async (_event: IpcMainInvokeEvent, args?: { limit?: number }) => {
      return logManager.getLogs(args?.limit);
    }
  );

  registerIpcHandler<void, void>(IPC_CHANNELS.LOGS_CLEAR, async (_event: IpcMainInvokeEvent) => {
    logManager.clearLogs();

    if (proxyManager) {
      await proxyManager.clearSingBoxLogFile();
    }
  });

  // 日志广播批处理（T1，issue #225）：原「每条 'log' 即一次 IPC broadcast」在 sing-box 启动期日志洪流下
  // → N 行 = N 次 IPC 序列化+send，撞 Windows 拖动 move modal loop（跑主线程）致拖动冻顿。改为 ~150ms 窗口
  // coalesce 成单次 EVENT_LOG_RECEIVED_BATCH（渲染端单次 setState），并按 isUiActive(可见 && !拖动) 门控。
  let pending: LogEntry[] = [];
  let droppedWhileInactive = 0;
  const flushTimer = setInterval(() => {
    if (pending.length === 0) return;
    if (isUiActive && !isUiActive()) return; // 不活跃（拖动/隐藏）→ 保留 pending 等下次活跃 tick
    const batch = pending;
    pending = [];
    if (droppedWhileInactive > 0) {
      // 诚实记录暂存溢出丢弃（不进 logManager 避免再入 pending；落盘日志不受影响）。
      console.warn(
        `[log-batch] UI 暂存溢出丢弃 ${droppedWhileInactive} 条日志（仅 UI live tail 截断，已落盘）`
      );
      droppedWhileInactive = 0;
    }
    broadcastEvent(IPC_CHANNELS.EVENT_LOG_RECEIVED_BATCH, batch);
  }, LOG_FLUSH_INTERVAL_MS);
  // 后台定时器不应拖住进程退出（Electron 主进程常驻，这里仅防御性 unref）。
  if (typeof flushTimer.unref === 'function') flushTimer.unref();

  logManager.on('log', (log: LogEntry) => {
    pending.push(log);
    if (pending.length > MAX_PENDING_LOG_BATCH) {
      pending.shift(); // 丢最旧，保最新（live tail 语义）
      droppedWhileInactive++;
    }
  });
}
