/**
 * sing-box 内核版本变更提示横幅
 * 当检测到内核版本有变化时显示，支持一键回滚到备份版本
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, X, FolderUp, Loader2 } from 'lucide-react';
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
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

  useEffect(() => {
    // 1. 初始化时主动获取当前状态（防止遗漏主进程启动时触发的事件）
    const fetchStatus = async () => {
      try {
        const info = await api.coreUpdate.getVersionInfo();
        // push 型：读 pendingChangeNotice（由更新动作显式创建），取代旧「lastKnownVersion!==currentVersion」推断式比对
        // ——后者对静默 reseed/基线对齐制造的持久不一致会每启误报（已根治）。展示即 ack 清除持久通知 → 弹一次非每启。
        if (info.pendingChangeNotice) {
          setChangeInfo({
            previousVersion: info.pendingChangeNotice.previousVersion,
            currentVersion: info.pendingChangeNotice.currentVersion,
            hasBackup: info.hasBackup,
          });
          void api.coreUpdate.ackVersionChange();
        }
      } catch (error) {
        console.error('Failed to fetch core version info:', error);
      }
    };
    fetchStatus();

    // 2. 监听主进程推送的版本变更事件（即时展示）；展示后同样 ack，防重启后 mount 复现。
    const unsubscribe = api.coreUpdate.onVersionChanged((data) => {
      setChangeInfo(data);
      setDismissed(false);
      void api.coreUpdate.ackVersionChange();
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
        // 替换成功：主进程已执行完替换流程；fork/unknown 追加来源提示（B-3）
        toast.success(t('settings.about.coreManualReplaceSuccess'), {
          description:
            result.build === 'fork'
              ? t('settings.coreManagement.manualForkNotice')
              : result.build === 'unknown'
                ? t('settings.coreManagement.manualUnknownNotice')
                : t('settings.about.newCoreActive'),
        });
        setDismissed(true);
      } else if (result.needConfirm && result.baselineOverride) {
        // 官方核旧于随包基线需确认：本横幅不承载确认框，引导用户去内核管理卡处理（B-2）
        toast.info(t('settings.coreManagement.baselineOverrideConfirmTitle'), {
          description: t('settings.coreVersion.baselineOverrideGoManage'),
        });
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
    <>
      {/* Conduit .app-update-banner 布局 + warn 色覆盖（内核版本变更 = 警示语义）。 */}
      <div
        className="app-update-banner"
        style={{ background: 'hsl(var(--warn-weak))', borderColor: 'hsl(var(--warn) / 0.3)' }}
      >
        <span className="aub-ic" style={{ background: 'hsl(var(--warn))' }}>
          <AlertTriangle />
        </span>
        <div className="aub-tx">
          <b style={{ color: 'hsl(var(--warn))' }}>{t('settings.coreVersion.changedTitle')}</b>
          <span>
            {t(`settings.coreVersion.${descriptionKey}`, {
              previousVersion: changeInfo.previousVersion,
              currentVersion: changeInfo.currentVersion,
            })}
          </span>
        </div>
        {changeInfo.hasBackup && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowRollbackConfirm(true)}
            disabled={isRollingBack || isReplacing}
          >
            {isRollingBack ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('settings.coreVersion.rollingBack')}
              </>
            ) : (
              <>
                <RotateCcw className="h-3 w-3" />
                {t('settings.coreVersion.rollback')}
              </>
            )}
          </button>
        )}
        <button
          type="button"
          className="btn ghost sm"
          onClick={handleReplaceManualCore}
          disabled={isRollingBack || isReplacing}
        >
          {isReplacing ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('settings.about.updating')}
            </>
          ) : (
            <>
              <FolderUp className="h-3 w-3" />
              {t('settings.about.manualReplace')}
            </>
          )}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setDismissed(true)}
          title={t('settings.coreVersion.dismiss')}
          aria-label={t('settings.coreVersion.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 回滚内核单层轻确认（回滚是可逆逃生通道，不加「不可撤销」红字，仅危险色确认动词） */}
      <AlertDialog open={showRollbackConfirm} onOpenChange={setShowRollbackConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.coreVersion.rollbackConfirmTitle', '回滚内核版本？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.coreVersion.rollbackConfirmDesc', {
                defaultValue: '将回滚到 {{version}}，内核会重启。',
                version: changeInfo.previousVersion,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowRollbackConfirm(false);
                void handleRollback();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('settings.coreVersion.rollback')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
