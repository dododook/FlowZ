/**
 * 数据备份与恢复 IPC 处理器
 * 处理配置文件的导出（备份）和导入（恢复）
 */

import { IpcMainInvokeEvent, dialog, app } from 'electron';
import * as fs from 'fs/promises';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { UserConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';
import type { RuleResourceManager } from '../../services/RuleResourceManager';
import { ipcEventEmitter } from '../ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';

/** 备份文件的元数据格式 */
export interface BackupFileFormat {
  version: string;
  appVersion: string;
  exportedAt: string;
  config: UserConfig;
}

/** 配置摘要信息（用于 UI 展示） */
export interface BackupInfo {
  serverCount: number;
  manualServerCount: number;
  subscriptionCount: number;
  ruleCount: number;
  ruleSetCount: number;
  appRuleCount: number;
}

/**
 * 注册备份与恢复 IPC 处理器
 */
export function registerBackupHandlers(
  configManager: ConfigManager,
  ruleResourceManager: RuleResourceManager
): void {
  // ── 导出备份 ──────────────────────────────────────────────────────────────
  registerIpcHandler<void, { success: boolean; filePath?: string; error?: string }>(
    IPC_CHANNELS.BACKUP_EXPORT,
    async (_event: IpcMainInvokeEvent) => {
      try {
        // 获取当前配置
        const config = await configManager.loadConfig();

        // 构造备份数据
        const backup: BackupFileFormat = {
          version: '1.0',
          appVersion: app.getVersion(),
          exportedAt: new Date().toISOString(),
          config,
        };

        // 弹出保存文件对话框
        const result = await dialog.showSaveDialog({
          title: '导出 FlowZ 配置备份',
          defaultPath: `flowz-backup-${new Date().toISOString().slice(0, 10)}.flowz-backup`,
          filters: [
            { name: 'FlowZ 备份文件', extensions: ['flowz-backup'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'cancelled' };
        }

        const content = JSON.stringify(backup, null, 2);
        await fs.writeFile(result.filePath, content, 'utf-8');

        return { success: true, filePath: result.filePath };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[BackupHandlers] Export failed:', message);
        return { success: false, error: message };
      }
    }
  );

  // ── 导入备份 ──────────────────────────────────────────────────────────────
  registerIpcHandler<void, { success: boolean; info?: BackupInfo; error?: string }>(
    IPC_CHANNELS.BACKUP_IMPORT,
    async (_event: IpcMainInvokeEvent) => {
      try {
        // 弹出打开文件对话框
        const result = await dialog.showOpenDialog({
          title: '导入 FlowZ 配置备份',
          filters: [
            { name: 'FlowZ 备份文件', extensions: ['flowz-backup'] },
            { name: 'JSON 文件', extensions: ['json'] },
            { name: '所有文件', extensions: ['*'] },
          ],
          properties: ['openFile'],
        });

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'cancelled' };
        }

        const filePath = result.filePaths[0];
        const rawContent = await fs.readFile(filePath, 'utf-8');
        let parsed: any;

        try {
          parsed = JSON.parse(rawContent);
        } catch {
          return { success: false, error: 'invalid_json' };
        }

        // 兼容两种格式：
        //   1. 新格式 { version, appVersion, exportedAt, config }
        //   2. 直接的 UserConfig（旧版直接导出情况）
        let restoredConfig: UserConfig;
        if (parsed.version && parsed.config) {
          restoredConfig = parsed.config as UserConfig;
        } else if (parsed.servers !== undefined) {
          restoredConfig = parsed as UserConfig;
        } else {
          return { success: false, error: 'invalid_format' };
        }

        // 通过 ConfigManager 保存（内部会做 validateConfig 校验）
        await configManager.saveConfig(restoredConfig);

        // 广播配置变更事件
        ipcEventEmitter.sendToAll('event:configChanged', { newValue: restoredConfig });
        mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, restoredConfig);

        // 备份只含 config(ruleResources 元数据)、不含 .srs 本体：跨机/全新恢复后这些文件缺失 → fail-closed 跳过引用规则。
        // 立即补缺（重下缺失的用户资源），不等 30min scheduler tick、不受自动更新开关门控；download 内部对「引用中 +
        // 之前缺失」资源触发 core reload → 规则即时恢复。fire-and-forget：网络慢/离线不阻断恢复返回（离线留 scheduler 兜底）。
        void ruleResourceManager
          .syncMissingNow()
          .then((r) => {
            if (r.missing > 0) {
              console.log(
                `[BackupHandlers] 恢复补缺规则资源：缺 ${r.missing}，成功 ${r.ok}，失败 ${r.failed}`
              );
            }
          })
          .catch((e) =>
            console.warn('[BackupHandlers] 恢复补缺规则资源失败（下次自动更新兜底）:', e)
          );

        // 计算恢复后的摘要
        const info: BackupInfo = {
          serverCount: restoredConfig.servers?.length ?? 0,
          manualServerCount: (restoredConfig.servers ?? []).filter((s) => !s.subscriptionId).length,
          subscriptionCount: restoredConfig.subscriptions?.length ?? 0,
          ruleCount: restoredConfig.customRules?.length ?? 0,
          ruleSetCount: restoredConfig.customRuleSets?.length ?? 0,
          appRuleCount: restoredConfig.appRules?.length ?? 0,
        };

        return { success: true, info };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[BackupHandlers] Import failed:', message);
        return { success: false, error: message };
      }
    }
  );

  // ── 获取当前配置摘要 ──────────────────────────────────────────────────────
  registerIpcHandler<void, BackupInfo>(
    IPC_CHANNELS.BACKUP_GET_INFO,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return {
        serverCount: config.servers?.length ?? 0,
        manualServerCount: (config.servers ?? []).filter((s) => !s.subscriptionId).length,
        subscriptionCount: config.subscriptions?.length ?? 0,
        ruleCount: config.customRules?.length ?? 0,
        ruleSetCount: config.customRuleSets?.length ?? 0,
        appRuleCount: config.appRules?.length ?? 0,
      };
    }
  );
}
