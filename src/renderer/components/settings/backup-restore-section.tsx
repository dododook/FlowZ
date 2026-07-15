import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/ipc/api-client';
import type { BackupInfo } from '@/ipc/api-client';
import { BACKUP_CATEGORIES, type BackupCategory } from '../../../shared/backup-categories';
import { BackupCategoryDialog, CATEGORY_META } from './backup-category-dialog';

const LAST_EXPORT_KEY = 'flowz_last_backup_export';

/** 数据备份卡（Conduit 高级面板 `.card.set-card`）：概览条 `.bk-overview` + 操作 `.bk-actions` + 选类对话框。 */
export function BackupRestoreSection() {
  const { t } = useTranslation();
  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [lastExportTime, setLastExportTime] = useState<string | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPick, setImportPick] = useState<{
    filePath: string;
    available: BackupCategory[];
    counts: Partial<Record<BackupCategory, number>>;
  } | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      const info = await api.backup.getInfo();
      setBackupInfo(info);
    } catch {
      // ignore — UI degrades gracefully
    }
  }, []);

  useEffect(() => {
    loadInfo();
    setLastExportTime(localStorage.getItem(LAST_EXPORT_KEY));
  }, [loadInfo]);

  // 导出对话框的各类数量（自定义规则含规则集）。导出可选全部 6 类（含通用设置）。
  const exportCounts: Partial<Record<BackupCategory, number>> = {
    manualNodes: backupInfo?.manualServerCount ?? 0,
    meshNodes: backupInfo?.meshServerCount ?? 0,
    subscriptions: backupInfo?.subscriptionCount ?? 0,
    customRules: (backupInfo?.ruleCount ?? 0) + (backupInfo?.ruleSetCount ?? 0),
    appRules: backupInfo?.appRuleCount ?? 0,
  };

  const categoryNames = (cats: BackupCategory[]): string =>
    cats.map((c) => t(CATEGORY_META[c].i18nKey)).join(', ');

  // ── Export ──────────────────────────────────────────────────────────────────
  const doExport = async (selected: BackupCategory[]) => {
    setShowExportDialog(false);
    setIsExporting(true);
    try {
      const result = await api.backup.export(selected);
      if (result.success) {
        const now = new Date().toLocaleString('zh-CN');
        localStorage.setItem(LAST_EXPORT_KEY, now);
        setLastExportTime(now);
        toast.success(t('settings.advanced.backup.exportSuccess'), {
          description: t('settings.advanced.backup.exportSuccessDesc'),
        });
      } else if (result.error !== 'cancelled') {
        toast.error(t('settings.advanced.backup.exportFail'), { description: result.error });
      }
    } catch (err: any) {
      toast.error(t('settings.advanced.backup.exportFail'), { description: err?.message });
    } finally {
      setIsExporting(false);
    }
  };

  // ── Import：①弹文件框选文件 + 解析 → ②选类别对话框 → ③apply ────────────────────
  const handleImportClick = async () => {
    setIsImporting(true);
    try {
      const r = await api.backup.importPick();
      if (r.canceled) return; // 用户取消文件框，静默
      if (r.error === 'invalid_json' || r.error === 'invalid_format') {
        toast.error(t('settings.advanced.backup.importInvalidFile'));
        return;
      }
      if (r.error) {
        toast.error(t('settings.advanced.backup.importFail'), { description: r.error });
        return;
      }
      if (!r.available?.length) {
        toast.warning(t('settings.advanced.backup.importEmpty'));
        return;
      }
      setImportPick({ filePath: r.filePath!, available: r.available, counts: r.counts ?? {} });
      setShowImportDialog(true);
    } catch (err: any) {
      toast.error(t('settings.advanced.backup.importFail'), { description: err?.message });
    } finally {
      setIsImporting(false);
    }
  };

  const doImport = async (selected: BackupCategory[]) => {
    if (!importPick) return;
    setShowImportDialog(false);
    setIsImporting(true);
    try {
      const result = await api.backup.importApply(importPick.filePath, selected);
      if (result.success && result.info) {
        await loadInfo();
        toast.success(t('settings.advanced.backup.importSuccess'), {
          description: t('settings.advanced.backup.importSuccessDesc', {
            servers: result.info.serverCount,
            subs: result.info.subscriptionCount,
            rules: result.info.ruleCount,
          }),
        });
        // 选了但备份为空被跳过的类别 → 提示（现有数据未被覆盖）。
        if (result.skipped?.length) {
          toast.info(
            t('settings.advanced.backup.importSkipped', { cats: categoryNames(result.skipped) })
          );
        }
        // 跨平台导入：进程规则平台特定、已禁用 → 提示在规则页重映射。
        if (result.info.crossPlatformDisabledRules) {
          toast.warning(
            t('settings.advanced.backup.crossPlatformRulesDisabled', {
              count: result.info.crossPlatformDisabledRules,
            })
          );
        }
        // 含组网节点：多设备同身份可能 tailnet 冲突，提示改名/重登。
        if (result.info.meshServerCount > 0) {
          toast.warning(
            t('settings.advanced.backup.meshImportHint', { count: result.info.meshServerCount })
          );
        }
      } else if (result.error === 'invalid_json' || result.error === 'invalid_format') {
        toast.error(t('settings.advanced.backup.importInvalidFile'));
      } else {
        toast.error(t('settings.advanced.backup.importFail'), { description: result.error });
      }
    } catch (err: any) {
      toast.error(t('settings.advanced.backup.importFail'), { description: err?.message });
    } finally {
      setIsImporting(false);
      setImportPick(null);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const totalNodes = backupInfo?.serverCount ?? 0;
  const hasData = totalNodes > 0 || (backupInfo?.subscriptionCount ?? 0) > 0;
  // 整个导出/导入流程（含选类对话框打开期间）都算忙，避免对话框开着时主按钮仍可点。
  const busy = isExporting || isImporting || showExportDialog || showImportDialog;

  const manualCount = backupInfo?.manualServerCount ?? 0;
  const meshCount = backupInfo?.meshServerCount ?? 0;
  const subCount = backupInfo?.subscriptionCount ?? 0;
  const ruleCount = backupInfo?.ruleCount ?? 0;
  const appRuleCount = backupInfo?.appRuleCount ?? 0;
  const subNodeCount = totalNodes - manualCount - meshCount;

  return (
    <div className="card set-card">
      <div className="set-h">
        <b>{t('settings.advanced.backup.title')}</b>
        <small>{t('settings.advanced.backup.desc')}</small>
      </div>

      <div className="set-pad">
        {hasData ? (
          <div className="bk-overview">
            <div className="bk-stat">
              <span className="bk-n mono tnum">{manualCount}</span>
              <span className="bk-l">{t('settings.advanced.backup.manualNodes')}</span>
            </div>
            {meshCount > 0 && (
              <div className="bk-stat">
                <span className="bk-n mono tnum">{meshCount}</span>
                <span className="bk-l">{t('settings.advanced.backup.meshNodes')}</span>
              </div>
            )}
            <div className="bk-stat">
              <span className="bk-n mono tnum">{subCount}</span>
              <span className="bk-l">
                {t('settings.advanced.backup.subscriptions')}
                {subCount > 0 && (
                  <small> {t('settings.advanced.backup.subNodes', { count: subNodeCount })}</small>
                )}
              </span>
            </div>
            <div className="bk-stat">
              <span className="bk-n mono tnum">{ruleCount}</span>
              <span className="bk-l">{t('settings.advanced.backup.rules')}</span>
            </div>
            {appRuleCount > 0 && (
              <div className="bk-stat">
                <span className="bk-n mono tnum">{appRuleCount}</span>
                <span className="bk-l">{t('settings.advanced.backup.appRules')}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="ng-hint" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('settings.advanced.backup.noData')}
          </div>
        )}

        <div className="bk-actions">
          <button
            id="backup-export-btn"
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => setShowExportDialog(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path d="M12 15V3M8 7l4-4 4 4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {isExporting
              ? t('settings.advanced.backup.exporting')
              : t('settings.advanced.backup.export')}
          </button>

          <button
            id="backup-import-btn"
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={handleImportClick}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path
                d="M12 3v12M8 11l4 4 4-4M5 21h14"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {isImporting
              ? t('settings.advanced.backup.importing')
              : t('settings.advanced.backup.import')}
          </button>

          {lastExportTime && (
            <span className="bk-last">
              {t('settings.advanced.backup.lastExport')}{' '}
              <span className="mono tnum">{lastExportTime}</span>
            </span>
          )}
        </div>
      </div>

      <BackupCategoryDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        mode="export"
        categories={[...BACKUP_CATEGORIES]}
        counts={exportCounts}
        busy={isExporting}
        onConfirm={doExport}
      />

      {/* 导入：选类别对话框（仅备份含的类，默认全选；覆盖+空跳过说明在 desc） */}
      <BackupCategoryDialog
        open={showImportDialog}
        onOpenChange={(o) => {
          setShowImportDialog(o);
          if (!o) setImportPick(null);
        }}
        mode="import"
        categories={importPick?.available ?? []}
        counts={importPick?.counts ?? {}}
        busy={isImporting}
        onConfirm={doImport}
      />
    </div>
  );
}
