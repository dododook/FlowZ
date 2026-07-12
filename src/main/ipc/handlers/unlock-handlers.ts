/**
 * 解锁检测 IPC 处理器：
 *  - unlock:run {force?} → 跑一轮检测（gating/单飞/缓存/节流在 service 内），返回完整快照。
 *  - unlock:get → 纯读最近快照（页面挂载水合，零网络），无则 null。
 * 增量点亮走 EVENT_UNLOCK_PROGRESS、失效走 EVENT_UNLOCK_INVALIDATED（由 service 回调广播）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { UnlockSnapshot } from '../../../shared/unlock-detection';
import { registerIpcHandler } from '../ipc-handler';
import type { UnlockDetectionService } from '../../services/unlock/UnlockDetectionService';

export function registerUnlockHandlers(unlockService: UnlockDetectionService): void {
  registerIpcHandler<{ force?: boolean } | undefined, UnlockSnapshot>(
    IPC_CHANNELS.UNLOCK_RUN,
    async (_event: IpcMainInvokeEvent, args?: { force?: boolean }) =>
      unlockService.run(args?.force ?? false)
  );

  registerIpcHandler<undefined, UnlockSnapshot | null>(
    IPC_CHANNELS.UNLOCK_GET,
    async (_event: IpcMainInvokeEvent) => unlockService.getSnapshot()
  );
}
