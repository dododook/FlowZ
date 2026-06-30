import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Download,
  Upload,
  Server,
  Network,
  Rss,
  ListFilter,
  Shield,
  Database,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/ipc/api-client';
import type { BackupInfo } from '@/ipc/api-client';
import { BACKUP_CATEGORIES, type BackupCategory } from '../../../shared/backup-categories';
import { BackupCategoryDialog, CATEGORY_META } from './backup-category-dialog';

// localStorage key for last export timestamp
const LAST_EXPORT_KEY = 'flowz_last_backup_export';

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

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            {t('settings.advanced.backup.title')}
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('settings.advanced.backup.desc')}
          </p>
        </div>
      </div>

      {/* Action bar — mirrors the server page button row style */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          id="backup-export-btn"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setShowExportDialog(true)}
          className="flex items-center gap-1.5"
        >
          <Download className={`h-3.5 w-3.5 ${isExporting ? 'animate-pulse' : ''}`} />
          {isExporting
            ? t('settings.advanced.backup.exporting')
            : t('settings.advanced.backup.export')}
        </Button>

        <Button
          id="backup-import-btn"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={handleImportClick}
          className="flex items-center gap-1.5"
        >
          <Upload className={`h-3.5 w-3.5 ${isImporting ? 'animate-pulse' : ''}`} />
          {isImporting
            ? t('settings.advanced.backup.importing')
            : t('settings.advanced.backup.import')}
        </Button>

        {lastExportTime && (
          <span className="text-xs text-muted-foreground ms-1 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-success" />
            {t('settings.advanced.backup.lastExport')}：{lastExportTime}
          </span>
        )}
      </div>

      {/* Config overview card — styled exactly like the subscription info bar in server page */}
      <div className="flex items-start justify-between rounded-lg border bg-muted/40 px-4 py-3 gap-4">
        {hasData ? (
          <div className="flex flex-wrap gap-x-6 gap-y-2 min-w-0">
            {/* Manual servers (non-mesh) */}
            <div className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-sm text-muted-foreground">
                {t('settings.advanced.backup.manualNodes')}
              </span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {backupInfo?.manualServerCount ?? 0}
              </Badge>
            </div>

            {/* Mesh servers (WireGuard / Tailscale) —— 与手动节点分开统计 */}
            {(backupInfo?.meshServerCount ?? 0) > 0 && (
              <div className="flex items-center gap-2">
                <Network className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-muted-foreground">
                  {t('settings.advanced.backup.meshNodes')}
                </span>
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                  {backupInfo?.meshServerCount ?? 0}
                </Badge>
              </div>
            )}

            {/* Subscriptions */}
            <div className="flex items-center gap-2">
              <Rss className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-sm text-muted-foreground">
                {t('settings.advanced.backup.subscriptions')}
              </span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {backupInfo?.subscriptionCount ?? 0}
              </Badge>
              {(backupInfo?.subscriptionCount ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">
                  (
                  {t('settings.advanced.backup.subNodes', {
                    count:
                      totalNodes -
                      (backupInfo?.manualServerCount ?? 0) -
                      (backupInfo?.meshServerCount ?? 0),
                  })}
                  )
                </span>
              )}
            </div>

            {/* Rules */}
            <div className="flex items-center gap-2">
              <ListFilter className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-sm text-muted-foreground">
                {t('settings.advanced.backup.rules')}
              </span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {backupInfo?.ruleCount ?? 0}
              </Badge>
            </div>

            {/* App rules */}
            {(backupInfo?.appRuleCount ?? 0) > 0 && (
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <span className="text-sm text-muted-foreground">
                  {t('settings.advanced.backup.appRules')}
                </span>
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                  {backupInfo?.appRuleCount ?? 0}
                </Badge>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="text-sm">{t('settings.advanced.backup.noData')}</span>
          </div>
        )}
      </div>

      {/* 导出：选类别对话框（全部 6 类可选，默认全选） */}
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
