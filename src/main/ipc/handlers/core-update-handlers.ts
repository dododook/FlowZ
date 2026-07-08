import { registerIpcHandler } from '../ipc-handler';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { CoreUpdateService } from '../../services/CoreUpdateService';
import { LogManager } from '../../services/LogManager';

let coreUpdateService: CoreUpdateService | null = null;

export function setCoreUpdateService(service: CoreUpdateService, _logger: LogManager) {
  coreUpdateService = service;
}

export function registerCoreUpdateHandlers() {
  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_CHECK, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.checkUpdate();
  });

  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_RUN, async (_, downloadUrl: string) => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.updateCore(downloadUrl);
  });

  registerIpcHandler(IPC_CHANNELS.CORE_GET_VERSION_INFO, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.getVersionInfo();
  });

  registerIpcHandler(IPC_CHANNELS.CORE_ROLLBACK, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    await coreUpdateService.rollbackCore();
    return true;
  });

  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_ACK_VERSION_CHANGE, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    coreUpdateService.ackPendingChangeNotice();
    return true;
  });

  registerIpcHandler(
    IPC_CHANNELS.CORE_REPLACE_MANUAL,
    async (_, opts?: { filePath?: string; force?: boolean }) => {
      if (!coreUpdateService) {
        throw new Error('CoreUpdateService not initialized');
      }
      return await coreUpdateService.replaceManualCore(opts);
    }
  );

  // 重置内核到出厂：把随 App 出厂的 bundled 核重新落位回受保护目录/bundle（force 跳过同版本短路）
  registerIpcHandler(IPC_CHANNELS.CORE_RESET_FACTORY, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.resetCoreToFactory();
  });

  // 内核自动更新状态（lastCheckAt / staged 待生效 / 跨带提示）
  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_GET_AUTO_STATUS, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.getAutoStatus();
  });

  // 用户点「立即应用」：停代理→换核→重启（唯一允许主动断流）
  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_APPLY_STAGED, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.applyStagedNow();
  });
}
