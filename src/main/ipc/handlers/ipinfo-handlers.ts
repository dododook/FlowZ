/**
 * 出口 IP 信息 IPC 处理器：渲染端主动拉取（可 force 强刷）当前快照。
 * 推送更新走 EVENT_IP_INFO_UPDATED（由 IpInfoService.onUpdate 广播）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { IpInfoSnapshot } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import type { IpInfoService } from '../../services/IpInfoService';

export function registerIpInfoHandlers(ipInfoService: IpInfoService): void {
  // visible：手动重探的可见流程（清当前出口→检测中→结果/超时）；被动拉取不传，保留旧值不闪。
  // peek：纯读当前快照（零探测）——窗口内存回收重建后 store 为空时水合状态栏，免丢「出口无效/IP」显示。
  //   **禁用** refresh(false) 水合：proxyBlocked/error 终态 TTL 仅 10s，过期即触发真探测（正是要消灭的挂载触发面）。
  registerIpcHandler<
    { force?: boolean; visible?: boolean; peek?: boolean } | undefined,
    IpInfoSnapshot
  >(
    IPC_CHANNELS.IP_INFO_GET,
    async (
      _event: IpcMainInvokeEvent,
      args?: { force?: boolean; visible?: boolean; peek?: boolean }
    ) =>
      args?.peek
        ? ipInfoService.getSnapshot()
        : ipInfoService.refresh(args?.force ?? false, args?.visible ?? false)
  );
}
