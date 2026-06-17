import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Download,
  Upload,
  Server,
  Rss,
  ListFilter,
  Shield,
  Database,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { api } from '@/ipc/api-client';
import type { BackupInfo } from '@/ipc/api-client';

// localStorage key for last export timestamp
const LAST_EXPORT_KEY = 'flowz_last_backup_export';

export function BackupRestoreSection() {
  const { t } = useTranslation();
  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [lastExportTime, setLastExportTime] = useState<string | null>(null);

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

  // ── Export ──────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    setIsExporting(true);
    try {
      const result = await api.backup.export();
      if (result.success) {
        const now = new Date().toLocaleString('zh-CN');
        localStorage.setItem(LAST_EXPORT_KEY, now);
        setLastExportTime(now);
        toast.success(t('settings.advanced.backup.exportSuccess'), {
          description: t('settings.advanced.backup.exportSuccessDesc'),
        });
      } else if (result.error !== 'cancelled') {
        toast.error(t('settings.advanced.backup.exportFail'), {
          description: result.error,
        });
      }
    } catch (err: any) {
      toast.error(t('settings.advanced.backup.exportFail'), {
        description: err?.message,
      });
    } finally {
      setIsExporting(false);
    }
  };

  // ── Import ──────────────────────────────────────────────────────────────────
  const handleImportConfirmed = async () => {
    setIsImporting(true);
    try {
      const result = await api.backup.import();
      if (result.success && result.info) {
        await loadInfo();
        toast.success(t('settings.advanced.backup.importSuccess'), {
          description: t('settings.advanced.backup.importSuccessDesc', {
            servers: result.info.serverCount,
            subs: result.info.subscriptionCount,
            rules: result.info.ruleCount,
          }),
        });
      } else if (result.error === 'cancelled') {
        // user cancelled file picker — do nothing
      } else if (result.error === 'invalid_json' || result.error === 'invalid_format') {
        toast.error(t('settings.advanced.backup.importInvalidFile'));
      } else {
        toast.error(t('settings.advanced.backup.importFail'), {
          description: result.error,
        });
      }
    } catch (err: any) {
      toast.error(t('settings.advanced.backup.importFail'), {
        description: err?.message,
      });
    } finally {
      setIsImporting(false);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const totalNodes = backupInfo?.serverCount ?? 0;
  const hasData = totalNodes > 0 || (backupInfo?.subscriptionCount ?? 0) > 0;

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
          disabled={isExporting || isImporting}
          onClick={handleExport}
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
          disabled={isExporting || isImporting}
          onClick={() => setShowImportConfirm(true)}
          className="flex items-center gap-1.5"
        >
          <Upload className={`h-3.5 w-3.5 ${isImporting ? 'animate-pulse' : ''}`} />
          {isImporting
            ? t('settings.advanced.backup.importing')
            : t('settings.advanced.backup.import')}
        </Button>

        {lastExportTime && (
          <span className="text-xs text-muted-foreground ml-1 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-success" />
            {t('settings.advanced.backup.lastExport')}：{lastExportTime}
          </span>
        )}
      </div>

      {/* Config overview card — styled exactly like the subscription info bar in server page */}
      <div className="flex items-start justify-between rounded-lg border bg-muted/40 px-4 py-3 gap-4">
        {hasData ? (
          <div className="flex flex-wrap gap-x-6 gap-y-2 min-w-0">
            {/* Manual servers */}
            <div className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-sm text-muted-foreground">
                {t('settings.advanced.backup.manualNodes')}
              </span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {backupInfo?.manualServerCount ?? 0}
              </Badge>
            </div>

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
                    count: totalNodes - (backupInfo?.manualServerCount ?? 0),
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

      {/* Import confirmation dialog */}
      <AlertDialog open={showImportConfirm} onOpenChange={setShowImportConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.advanced.backup.importConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.advanced.backup.importConfirmDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowImportConfirm(false);
                handleImportConfirmed();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('settings.advanced.backup.importConfirmBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
