/**
 * stats 订阅 IPC 处理器（batch3 §3.7 订阅驱动数据面）。
 *
 * renderer 的 useStatsTopic 经 STATS_SUBSCRIBE / STATS_UNSUBSCRIBE 声明/撤销对某 topic（stats|aggregate|detail）的
 * 订阅；主进程据订阅集派生 worker demand（无订阅者逐级停机）+ 只 relay 给对应订阅者。订阅 wc 取 event.sender（其
 * destroyed 由 registry 兜底自动清，防 renderer 崩溃/重载泄漏）。订阅即回初始帧亦在 registry.subscribe 内完成。
 */
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type StatsTopic } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
import type { StatsSubscriptionRegistry } from '../../services/StatsSubscriptionRegistry';

const VALID_TOPICS: readonly StatsTopic[] = ['stats', 'aggregate', 'detail'];

/** IPC 边界防御：只接受三个已知 topic 字面量，畸形入参一律拒（不落进 registry）。 */
function isStatsTopic(v: unknown): v is StatsTopic {
  return typeof v === 'string' && (VALID_TOPICS as readonly string[]).includes(v);
}

export function registerStatsSubscriptionHandlers(registry: StatsSubscriptionRegistry): void {
  registerIpcHandler<{ topic: StatsTopic }, void>(
    IPC_CHANNELS.STATS_SUBSCRIBE,
    (event: IpcMainInvokeEvent, args) => {
      // 非法 topic 静默忽略（不抛：避免 renderer 侧订阅 promise reject 噪音；正常路径 topic 恒来自受控联合类型）。
      if (isStatsTopic(args?.topic)) registry.subscribe(event.sender, args.topic);
    }
  );

  registerIpcHandler<{ topic: StatsTopic }, void>(
    IPC_CHANNELS.STATS_UNSUBSCRIBE,
    (event: IpcMainInvokeEvent, args) => {
      if (isStatsTopic(args?.topic)) registry.unsubscribe(event.sender, args.topic);
    }
  );
}
