/**
 * 测速相关 IPC 处理器。
 *
 * 复用唯一编排器 runSpeedTest——与托盘入口同源传播（渲染逐节点广播 + 进度 + 托盘回写 + 测速态），
 * 修复历史漂移「服务器页/首页测速不同步到托盘服务器列表」（旧实现此处只广播、漏了 trayManager 回写）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { SpeedTestInvokeResult } from '../../../shared/speed-test';
import { registerIpcHandler } from '../ipc-handler';
import { runSpeedTest, type SpeedTestRunnerDeps } from '../../services/speed-test-runner';

export function registerSpeedTestHandlers(deps: SpeedTestRunnerDeps): void {
  // 服务器测速（serverIds 缺省=全部；逐节点结果/进度由 runSpeedTest 广播，托盘同步回写）
  registerIpcHandler<{ serverIds?: string[] }, SpeedTestInvokeResult>(
    IPC_CHANNELS.SERVER_SPEED_TEST,
    async (_event: IpcMainInvokeEvent, args?: { serverIds?: string[] }) => {
      const runResult = await runSpeedTest(deps, { serverIds: args?.serverIds });
      const results: Record<string, number> = {};
      for (const [id, latency] of runResult.results.entries()) {
        results[id] = latency === null ? -1 : latency;
      }
      // §16.2/§16.3.3：outcome（interrupted → toast「测速中断」）+ 波前缺席两列表（notInPool 徽标信号 + tsNotReady，
      // 合计供 toast 副行「N 未纳入」）随结果回传。
      return {
        results,
        outcome: runResult.outcome,
        notInPool: runResult.skipped.notInPool,
        tsNotReady: runResult.skipped.tsNotReady,
      };
    }
  );
}
