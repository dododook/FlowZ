import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { AutoStartStatus } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { createAutoStartManager, IAutoStartManager } from '../../services/AutoStartManager';

let autoStartManager: IAutoStartManager | null = null;

function getAutoStartManager(): IAutoStartManager {
  if (!autoStartManager) {
    autoStartManager = createAutoStartManager();
  }
  return autoStartManager;
}

export function registerAutoStartHandlers(): void {
  registerIpcHandler<{ enabled: boolean }, boolean>(
    IPC_CHANNELS.AUTO_START_SET,
    async (_event: IpcMainInvokeEvent, args: { enabled: boolean }) => {
      const manager = getAutoStartManager();
      return await manager.setAutoStart(args.enabled);
    }
  );

  registerIpcHandler<void, AutoStartStatus>(
    IPC_CHANNELS.AUTO_START_GET_STATUS,
    async (_event: IpcMainInvokeEvent) => {
      const manager = getAutoStartManager();
      const enabled = await manager.isAutoStartEnabled();
      return { enabled };
    }
  );
}
