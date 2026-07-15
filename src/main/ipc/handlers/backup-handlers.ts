/**
 * 数据备份与恢复 IPC 处理器（选择性导入导出）
 * 导出：按勾选类别 pickCategories；导入：①PICK 弹文件返回类目录 → ②APPLY 按勾选 mergeCategories（整类替换+空跳过）。
 */

import { IpcMainInvokeEvent, dialog, app } from 'electron';
import * as fs from 'fs/promises';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { UserConfig } from '../../../shared/types';
import { isEndpointProtocol } from '../../../shared/endpoint-routes';
import { ruleHasProcessCondition } from '../../../shared/config-portability';
import {
  pickCategories,
  mergeCategories,
  detectCategories,
  countCategory,
  BACKUP_CATEGORIES,
  type BackupCategory,
} from '../../../shared/backup-categories';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';
import type { RuleResourceManager } from '../../services/RuleResourceManager';
import { ipcEventEmitter } from '../ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';

/** 备份文件的元数据格式。选择性导出后 config 可能只含部分类别字段 → Partial。 */
export interface BackupFileFormat {
  version: string;
  appVersion: string;
  // 导出平台（process.platform）。跨平台导入据此 sanitize 进程规则；旧备份无此字段 → 视为同平台、不处理。
  platform?: NodeJS.Platform;
  exportedAt: string;
  config: Partial<UserConfig>;
}

export interface BackupInfo {
  serverCount: number;
  manualServerCount: number;
  meshServerCount: number;
  subscriptionCount: number;
  ruleCount: number;
  ruleSetCount: number;
  appRuleCount: number;
  // 跨平台导入时被禁用的进程规则数（processName/processPath 平台特定 → enabled=false 保留供重映射）。0/同平台时不返回。
  crossPlatformDisabledRules?: number;
}

/** 解析备份文件内容（兼容新格式 {version,config} 与旧版直接 UserConfig）。返回 config(Partial) + 导出平台，或错误码。 */
function parseBackupContent(
  raw: string
): { config: Partial<UserConfig>; platform?: NodeJS.Platform } | { error: string } {
  let parsed: { version?: string; platform?: unknown; config?: unknown; servers?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid_json' };
  }
  if (parsed.version && parsed.config) {
    return {
      config: parsed.config as Partial<UserConfig>,
      platform:
        typeof parsed.platform === 'string' ? (parsed.platform as NodeJS.Platform) : undefined,
    };
  }
  if (parsed.servers !== undefined) {
    return { config: parsed as Partial<UserConfig> }; // 旧版直接导出的 UserConfig
  }
  return { error: 'invalid_format' };
}

/**
 * 跨平台 sanitize：进程规则（processName/processPath）平台特定（chrome.exe / Google Chrome / chrome），跨平台会
 * 静默失效 → 禁用而非移除（enabled=false，保留供用户重映射）。原地改 config.customRules，返回被禁用条数。
 * 详见 docs/design/config-portability.md §3。
 */
function sanitizeCrossPlatformRules(config: UserConfig, backupPlatform?: NodeJS.Platform): number {
  if (
    !backupPlatform ||
    backupPlatform === process.platform ||
    !Array.isArray(config.customRules)
  ) {
    return 0;
  }
  let n = 0;
  for (const rule of config.customRules) {
    if (rule.enabled !== false && ruleHasProcessCondition(rule)) {
      rule.enabled = false;
      n++;
    }
  }
  return n;
}

function buildBackupInfo(
  config: Partial<UserConfig>,
  crossPlatformDisabledRules?: number
): BackupInfo {
  const servers = config.servers ?? [];
  return {
    serverCount: servers.length,
    manualServerCount: servers.filter((s) => !s.subscriptionId && !isEndpointProtocol(s.protocol))
      .length,
    meshServerCount: servers.filter((s) => !s.subscriptionId && isEndpointProtocol(s.protocol))
      .length,
    subscriptionCount: config.subscriptions?.length ?? 0,
    ruleCount: config.customRules?.length ?? 0,
    ruleSetCount: config.customRuleSets?.length ?? 0,
    appRuleCount: config.appRules?.length ?? 0,
    crossPlatformDisabledRules: crossPlatformDisabledRules || undefined,
  };
}

const IMPORT_FILTERS = [
  { name: 'FlowZ 备份文件', extensions: ['flowz-backup'] },
  { name: 'JSON 文件', extensions: ['json'] },
  { name: '所有文件', extensions: ['*'] },
];

export function registerBackupHandlers(
  configManager: ConfigManager,
  ruleResourceManager: RuleResourceManager
): void {
  // ── 导出备份（按勾选类别）──────────────────────────────────────────────────
  registerIpcHandler<
    { categories?: BackupCategory[] },
    { success: boolean; filePath?: string; error?: string }
  >(IPC_CHANNELS.BACKUP_EXPORT, async (_event: IpcMainInvokeEvent, args) => {
    try {
      const config = await configManager.loadConfig();
      const selected = args?.categories?.length ? args.categories : [...BACKUP_CATEGORIES];
      const picked = pickCategories(config, selected);

      const backup: BackupFileFormat = {
        version: '1.0',
        appVersion: app.getVersion(),
        platform: process.platform,
        exportedAt: new Date().toISOString(),
        config: picked,
      };

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

      await fs.writeFile(result.filePath, JSON.stringify(backup, null, 2), 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[BackupHandlers] Export failed:', message);
      return { success: false, error: message };
    }
  });

  // ── 导入①PICK：弹文件框 + 解析 → 返回备份含哪些类 + 各类数量（不 apply）──────────
  registerIpcHandler<
    void,
    {
      canceled: boolean;
      filePath?: string;
      available?: BackupCategory[];
      counts?: Partial<Record<BackupCategory, number>>;
      error?: string;
    }
  >(IPC_CHANNELS.BACKUP_IMPORT_PICK, async (_event: IpcMainInvokeEvent) => {
    const result = await dialog.showOpenDialog({
      title: '导入 FlowZ 配置备份',
      filters: IMPORT_FILTERS,
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = result.filePaths[0];
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      return { canceled: false, error: 'read_failed' };
    }
    const parsed = parseBackupContent(raw);
    if ('error' in parsed) {
      return { canceled: false, error: parsed.error };
    }
    const available = detectCategories(parsed.config);
    const counts: Partial<Record<BackupCategory, number>> = {};
    for (const cat of available) counts[cat] = countCategory(parsed.config, cat);
    return { canceled: false, filePath, available, counts };
  });

  // ── 导入②APPLY：按所选类整类替换 + 空跳过 + 跨平台 sanitize + 保存 ─────────────
  registerIpcHandler<
    { filePath: string; categories: BackupCategory[] },
    { success: boolean; info?: BackupInfo; skipped?: BackupCategory[]; error?: string }
  >(IPC_CHANNELS.BACKUP_IMPORT_APPLY, async (_event: IpcMainInvokeEvent, args) => {
    try {
      if (!args?.filePath || !args.categories?.length) {
        return { success: false, error: 'invalid_args' };
      }
      let raw: string;
      try {
        raw = await fs.readFile(args.filePath, 'utf-8');
      } catch {
        return { success: false, error: 'read_failed' };
      }
      const parsed = parseBackupContent(raw);
      if ('error' in parsed) {
        return { success: false, error: parsed.error };
      }

      const current = await configManager.loadConfig();
      const { config: merged, skipped } = mergeCategories(current, parsed.config, args.categories);

      // 仅当导入了自定义规则才需 sanitize（其余类无进程规则）。
      let crossPlatformDisabledRules = 0;
      if (args.categories.includes('customRules')) {
        crossPlatformDisabledRules = sanitizeCrossPlatformRules(merged, parsed.platform);
        if (crossPlatformDisabledRules > 0) {
          console.log(
            `[BackupHandlers] 跨平台导入（${parsed.platform}→${process.platform}）：禁用 ${crossPlatformDisabledRules} 条进程规则（保留供重映射）`
          );
        }
      }

      // 通过 ConfigManager 保存（内部 validateConfig 校验）。失效 selectedServerId 已在 mergeCategories
      // 末尾归零（validateConfig 对失效引用是 throw、非归零，否则整份导入失败）。
      await configManager.saveConfig(merged);

      // 重新 loadConfig 让迁移（含 FakeIP-TUN 待纠正评估）对导入配置即时生效，再广播 fresh——否则导入的 systemProxy
      // 冻结态直接广播 merged（flag 未评估）会漏掉 FakeIP-TUN 纠正窗口、被同会话切 TUN 永久消费。
      const fresh = await configManager.loadConfig();
      ipcEventEmitter.sendToAll('event:configChanged', { newValue: fresh });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, fresh);

      // 备份只含 config(ruleResources 元数据)、不含 .srs 本体：恢复后缺失 → 立即补缺（fire-and-forget，离线留 scheduler 兜底）。
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

      const info = buildBackupInfo(merged, crossPlatformDisabledRules);
      return { success: true, info, skipped: skipped.length ? skipped : undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[BackupHandlers] Import apply failed:', message);
      return { success: false, error: message };
    }
  });

  // ── 获取当前配置摘要 ──────────────────────────────────────────────────────
  registerIpcHandler<void, BackupInfo>(
    IPC_CHANNELS.BACKUP_GET_INFO,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return buildBackupInfo(config);
    }
  );
}
