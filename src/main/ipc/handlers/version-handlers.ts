/**
 * 版本信息 IPC 处理器
 * 处理版本信息相关的 IPC 请求
 */

import { IpcMainInvokeEvent, app, shell } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
// 内核版本以 core-manifest.json 为权威（构建时随内核打包的真相），非 package.json.singboxVersion（旧值易漂移）。
import coreManifest from '../../../shared/core-manifest.json';
// 构建时刻注入的真实构建日期（scripts/gen-build-info.js 生成），非运行时 new Date（B-1）。
import { BUILD_DATE } from '../../../shared/build-info';

const BUNDLED_CORE_VERSION = coreManifest.bundledCoreVersion || 'Unknown';

interface VersionInfo {
  appVersion: string;
  appName: string;
  buildDate: string;
  singBoxVersion: string;
  copyright: string;
  repositoryUrl: string;
}

import { CoreUpdateService } from '../../services/CoreUpdateService';

/**
 * 注册版本信息相关的 IPC 处理器
 */
export function registerVersionHandlers(coreUpdateService?: CoreUpdateService): void {
  registerIpcHandler<void, VersionInfo>(
    IPC_CHANNELS.VERSION_GET_INFO,
    async (_event: IpcMainInvokeEvent) => {
      let currentSingBoxVersion = BUNDLED_CORE_VERSION;
      if (coreUpdateService) {
        try {
          // About 页显示：force=false 读缓存（启动已预热）→ 避免每次进入 spawn 内核子进程致加载转圈。
          const version = await coreUpdateService.getCurrentVersion(false);
          if (version && version !== '未知') {
            currentSingBoxVersion = version;
          }
        } catch (error) {
          console.error('Failed to get core version:', error);
        }
      }

      return {
        appVersion: app.getVersion(),
        appName: 'FlowZ',
        buildDate: BUILD_DATE,
        singBoxVersion: currentSingBoxVersion,
        copyright: `© ${new Date().getFullYear()} FlowZ. All rights reserved.`,
        repositoryUrl: 'https://github.com/dododook/FlowZ',
      };
    }
  );

  // 打开外部链接
  registerIpcHandler<string, boolean>(
    IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
    async (_event: IpcMainInvokeEvent, url: string) => {
      await shell.openExternal(url);
      return true;
    }
  );
}
