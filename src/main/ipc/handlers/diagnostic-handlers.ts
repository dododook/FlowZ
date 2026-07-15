/**
 * 导出诊断报告：生成脱敏 Markdown → 系统保存对话框 → 落盘。复用 backup-handlers 的 showSaveDialog 模式。
 */

import { IpcMainInvokeEvent, dialog } from 'electron';
import * as fs from 'fs/promises';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
import type { DiagnosticService } from '../../services/DiagnosticService';

export function registerDiagnosticHandlers(diagnosticService: DiagnosticService): void {
  registerIpcHandler<void, { success: boolean; filePath?: string; error?: string }>(
    IPC_CHANNELS.DIAGNOSTIC_EXPORT,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const report = await diagnosticService.buildReport();

        const result = await dialog.showSaveDialog({
          title: '导出 FlowZ 诊断报告',
          defaultPath: `flowz-diagnostic-${new Date().toISOString().slice(0, 10)}.md`,
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'cancelled' };
        }

        await fs.writeFile(result.filePath, report, 'utf-8');
        return { success: true, filePath: result.filePath };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[DiagnosticHandlers] Export failed:', message);
        return { success: false, error: message };
      }
    }
  );
}
