/**
 * 测速相关 IPC 处理器。
 *
 * 复用唯一编排器 runSpeedTest——与托盘入口同源传播（渲染逐节点广播 + 进度 + 托盘回写 + 测速态），
 * 修复历史漂移「服务器页/首页测速不同步到托盘服务器列表」（旧实现此处只广播、漏了 trayManager 回写）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
import { runSpeedTest, type SpeedTestRunnerDeps } from '../../services/speed-test-runner';

/**
 * 注册测速相关的 IPC 处理器。
 * @param deps 唯一编排器依赖（configManager / speedTestService / getMainWindow / getTrayManager / logManager）。
 */
export function registerSpeedTestHandlers(deps: SpeedTestRunnerDeps): void {
  // 服务器测速（serverIds 缺省=全部；逐节点结果/进度由 runSpeedTest 广播，托盘同步回写）
  registerIpcHandler<{ serverIds?: string[] }, Record<string, number>>(
    IPC_CHANNELS.SERVER_SPEED_TEST,
    async (_event: IpcMainInvokeEvent, args?: { serverIds?: string[] }) => {
      const rawResults = await runSpeedTest(deps, { serverIds: args?.serverIds });
      const results: Record<string, number> = {};
      for (const [id, latency] of rawResults.entries()) {
        results[id] = latency === null ? -1 : latency;
      }
      return results;
    }
  );
}
