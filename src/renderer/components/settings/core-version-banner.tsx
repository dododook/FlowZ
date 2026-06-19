/**
 * sing-box 内核版本变更提示横幅
 * 当检测到内核版本有变化时显示，支持一键回滚到备份版本
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, X, FolderUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { api } from '@/ipc';
import { useTranslation } from 'react-i18next';

interface CoreVersionChangeInfo {
  previousVersion: string;
  currentVersion: string;
  hasBackup: boolean;
}

export function CoreVersionBanner() {
  const { t } = useTranslation();
  const [changeInfo, setChangeInfo] = useState<CoreVersionChangeInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);

  useEffect(() => {
    // 1. 初始化时主动获取当前状态（防止遗漏主进程启动时触发的事件）
    const fetchStatus = async () => {
      try {
        const info = await api.coreUpdate.getVersionInfo();
        if (
          info.lastKnownVersion &&
          info.currentVersion !== '未知' &&
          info.lastKnownVersion !== info.currentVersion
        ) {
          setChangeInfo({
            previousVersion: info.lastKnownVersion,
            currentVersion: info.currentVersion,
            hasBackup: info.hasBackup,
          });
        }
      } catch (error) {
        console.error('Failed to fetch core version info:', error);
      }
    };
    fetchStatus();

    // 2. 监听主进程推送的版本变更事件
    const unsubscribe = api.coreUpdate.onVersionChanged((data) => {
      setChangeInfo(data);
      setDismissed(false);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  if (!changeInfo || dismissed) {
    return null;
  }

  const handleRollback = async () => {
    if (!changeInfo.hasBackup) return;

    setIsRollingBack(true);
    try {
      await api.coreUpdate.rollback();
      toast.success(t('settings.coreVersion.rollbackSuccess'));
      setDismissed(true);
    } catch (error) {
      const msg = error instanceof Error ? error.message : t('settings.coreVersion.rollbackFail');
      toast.error(`${t('settings.coreVersion.rollbackFail')}: ${msg}`);
    } finally {
      setIsRollingBack(false);
    }
  };

  const handleReplaceManualCore = async () => {
    try {
      setIsReplacing(true);
      const result = await api.coreUpdate.replaceManual();
      if (result.ok) {
        // 替换成功：主进程已执行完替换流程
        toast.success(t('settings.about.coreManualReplaceSuccess'), {
          description: t('settings.about.newCoreActive'),
        });
        setDismissed(true);
      } else if (result.needConfirm && result.sameVersion && result.filePath) {
        // 同版本需确认：本横幅不承载确认框，引导用户去内核管理卡处理
        toast.info(t('settings.coreManagement.sameVersionConfirmTitle'), {
          description: t('settings.coreVersion.sameVersionGoManage'),
        });
      } else if (result.error) {
        toast.error(t('settings.about.coreUpdateFail'), { description: result.error });
      }
      // ok:false 且无 needConfirm/error → 用户取消文件选择器，静默
    } catch (error) {
      toast.error(t('settings.about.coreUpdateFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsReplacing(false);
    }
  };

  const descriptionKey = changeInfo.hasBackup ? 'changedDesc' : 'noBackupDesc';

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 mb-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
            {t('settings.coreVersion.changedTitle')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t(`settings.coreVersion.${descriptionKey}`, {
              previousVersion: changeInfo.previousVersion,
              currentVersion: changeInfo.currentVersion,
            })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {changeInfo.hasBackup && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 hover:text-amber-700 dark:hover:text-amber-300"
                onClick={handleRollback}
                disabled={isRollingBack || isReplacing}
              >
                {isRollingBack ? (
                  <>
                    <Loader2 className="me-1.5 h-3 w-3 animate-spin" />
                    {t('settings.coreVersion.rollingBack')}
                  </>
                ) : (
                  <>
                    <RotateCcw className="me-1.5 h-3 w-3" />
                    {t('settings.coreVersion.rollback')}
                  </>
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 hover:text-amber-700 dark:hover:text-amber-300"
              onClick={handleReplaceManualCore}
              disabled={isRollingBack || isReplacing}
            >
              {isReplacing ? (
                <>
                  <Loader2 className="me-1.5 h-3 w-3 animate-spin" />
                  {t('settings.about.updating')}
                </>
              ) : (
                <>
                  <FolderUp className="me-1.5 h-3 w-3" />
                  {t('settings.about.manualReplace')}
                </>
              )}
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          title={t('settings.coreVersion.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
