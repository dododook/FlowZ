/**
 * 内核管理卡片（sing-box 核心版本 / 检查更新 / 回滚 / 手动替换 / 自动更新开关 / staged 待生效 / 跨带提示）。
 * 从 about-settings 的「sing-box 版本」区块迁入，与「应用更新」（App，仍在 about）视觉分开。
 * 自动更新仅在兼容版本带内（如 1.13.x→1.13.y）；跨大版本（1.13→1.14）需手动确认。
 *
 * 更新呈现 = 常驻状态 + 可选弹窗：检查到新内核后在卡内常驻显示「发现新内核 vX.Y.Z + 更新按钮」（数据放
 * store 的 availableCoreUpdate，跨设置子节卸载持久）；toast 降级为可选提醒，点击只滚动/高亮到常驻入口，
 * 不再是唯一更新触发。crossBand 时警告色 + 风险文案。
 */

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
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
import { SettingsRow } from './settings-row';
import { toast } from 'sonner';
import {
  Loader2,
  FolderUp,
  RotateCcw,
  ArrowUpCircle,
  AlertTriangle,
  Undo2,
  Trash2,
} from 'lucide-react';
import { checkCoreUpdate, updateCore } from '@/bridge/api-wrapper';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';

interface AutoStatus {
  // autoUpdateEnabled 不在此快照消费（开关 UI 直接读 config.autoUpdateCore）；事件也不再推送该字段。
  lastCheckAt: number | null;
  staged: { version: string; stagedAt: string } | null;
  crossBandLatest: string | null;
}

export function CoreManagementCard() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  // 常驻内核更新入口数据源（放 store：本卡随设置子节切换会卸载，本地 state 承载不了「toast 消失后入口仍在」）
  const availableCoreUpdate = useAppStore((s) => s.availableCoreUpdate);
  const setAvailableCoreUpdate = useAppStore((s) => s.setAvailableCoreUpdate);

  const [currentVersion, setCurrentVersion] = useState<string>('—');
  const [backupVersion, setBackupVersion] = useState<string | null>(null);
  const [hasBackup, setHasBackup] = useState(false);
  const [autoStatus, setAutoStatus] = useState<AutoStatus | null>(null);
  // 内核来源：official / fork（第三方→禁在线·自动更新+置灰）/ unknown（仅提示）。
  const [coreBuild, setCoreBuild] = useState<'official' | 'fork' | 'unknown'>('official');

  const [checkingCoreUpdate, setCheckingCoreUpdate] = useState(false);
  const [updatingCore, setUpdatingCore] = useState(false);
  const [replacingManual, setReplacingManual] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [applyingStaged, setApplyingStaged] = useState(false);
  const [resettingFactory, setResettingFactory] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  // 同版本换核确认（手动替换返回 needConfirm 时打开）
  const [sameVersionConfirm, setSameVersionConfirm] = useState<{
    sameVersion: string;
    filePath: string;
  } | null>(null);
  // B6 两个确认框
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);

  // 常驻入口高亮（toast 点击「跳到入口」时滚动 + 闪一下）
  const updateEntryRef = useRef<HTMLDivElement | null>(null);
  const [entryHighlight, setEntryHighlight] = useState(false);

  const loadVersionInfo = async () => {
    try {
      const info = await api.coreUpdate.getVersionInfo();
      setCurrentVersion(info.currentVersion || 'Unknown');
      setBackupVersion(info.backupVersion);
      setHasBackup(info.hasBackup);
      const build = info.build ?? 'official';
      setCoreBuild(build);
      // 换到第三方内核后清掉此前官方核检查残留的「发现新内核」常驻入口（其更新按钮已置灰，留着是误导性死 UI）。
      if (build === 'fork') setAvailableCoreUpdate(null);
    } catch (error) {
      console.error('Failed to load core version info:', error);
    }
  };

  const loadAutoStatus = async () => {
    try {
      setAutoStatus(await api.coreUpdate.getAutoStatus());
    } catch (error) {
      console.error('Failed to load core auto status:', error);
    }
  };

  useEffect(() => {
    loadVersionInfo();
    loadAutoStatus();
    // 监听主进程推送的自动更新状态变更（staged 待生效 / 跨带提示 / 落位成功）
    const unsubscribe = api.coreUpdate.onAutoStatusChanged((data) => {
      setAutoStatus((prev) => ({ ...(prev ?? data), ...data }));
      // 落位可能改变当前版本/备份 → 重拉版本信息
      void loadVersionInfo();
    });
    return () => unsubscribe();
  }, []);

  // 滚动到常驻更新入口并短暂高亮（供 toast 的「查看」动作调用）
  const focusUpdateEntry = () => {
    updateEntryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setEntryHighlight(true);
    window.setTimeout(() => setEntryHighlight(false), 1600);
  };

  const handleCheckCoreUpdate = async () => {
    try {
      setCheckingCoreUpdate(true);
      toast.info(t('settings.about.checkingCoreUpdate'));
      // 兜底超时：即便主进程因意外永不返回，20s 后也强制 reject → catch 清 loading + 报错，绝不无限转圈（终极防线）。
      const response = await Promise.race([
        checkCoreUpdate(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(t('settings.about.requestTimeout'))), 20000)
        ),
      ]);
      if (!response || !response.success) {
        toast.error(t('settings.about.checkCoreUpdateFail'), {
          description: response?.error || t('settings.about.cannotConnectServer'),
        });
        return;
      }
      const data = response.data;
      if (!data) return;
      if (data.hasUpdate && data.latestVersion && data.downloadUrl) {
        // 写入常驻入口（数据源持久；toast 仅作可选即时提醒）
        setAvailableCoreUpdate({
          latestVersion: data.latestVersion,
          downloadUrl: data.downloadUrl,
          crossBand: data.crossBand,
        });
        toast.success(t('settings.about.foundCoreUpdate', { version: data.latestVersion }), {
          description: t('settings.coreManagement.updateEntryHint'),
          action: {
            label: t('settings.coreManagement.viewUpdate'),
            onClick: focusUpdateEntry,
          },
          duration: 8000,
        });
      } else if (data.error) {
        toast.error(t('settings.about.checkCoreUpdateFail'), { description: data.error });
      } else {
        // 已是最新：清除可能残留的常驻入口
        setAvailableCoreUpdate(null);
        toast.success(t('settings.about.coreAlreadyLatest'), {
          description: t('settings.about.currentVersion', { version: data.currentVersion }),
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(t('settings.about.checkCoreUpdateFail'), {
        description: errorMessage || t('settings.about.unknownError'),
      });
    } finally {
      setCheckingCoreUpdate(false);
    }
  };

  const handleUpdateCore = async (downloadUrl: string, version: string) => {
    try {
      setUpdatingCore(true);
      toast.info(t('settings.about.updatingCore', { version }), {
        description: t('settings.about.doNotClose'),
      });
      const response = await updateCore(downloadUrl);
      if (response && response.success && response.data) {
        setAvailableCoreUpdate(null); // 更新成功：清除常驻入口
        toast.success(t('settings.about.coreUpdateSuccess'), {
          description: t('settings.about.newCoreActive'),
        });
        await loadVersionInfo();
      } else {
        toast.error(t('settings.about.coreUpdateFail'), {
          description: response?.error || t('settings.about.unknownError'),
        });
      }
    } catch (error) {
      toast.error(t('settings.about.coreUpdateFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUpdatingCore(false);
    }
  };

  const handleRollback = async () => {
    if (!hasBackup) return;
    try {
      setRollingBack(true);
      await api.coreUpdate.rollback();
      toast.success(t('settings.coreVersion.rollbackSuccess'));
      await loadVersionInfo();
    } catch (error) {
      const msg = error instanceof Error ? error.message : t('settings.coreVersion.rollbackFail');
      toast.error(`${t('settings.coreVersion.rollbackFail')}: ${msg}`);
    } finally {
      setRollingBack(false);
    }
  };

  // 手动替换：无参调用 → 弹文件选择器 + 预检 + 同版本检测；同版本返回 needConfirm 时弹确认框。
  const handleReplaceManual = async () => {
    try {
      setReplacingManual(true);
      const result = await api.coreUpdate.replaceManual();
      if (result.ok) {
        toast.success(t('settings.about.coreManualReplaceSuccess'), {
          description: t('settings.about.newCoreActive'),
        });
        await loadVersionInfo();
      } else if (result.needConfirm && result.sameVersion && result.filePath) {
        // 目标内核与当前同版本：交给用户确认后再换
        setSameVersionConfirm({ sameVersion: result.sameVersion, filePath: result.filePath });
      } else if (result.error) {
        toast.error(t('settings.about.coreUpdateFail'), { description: result.error });
      }
      // ok:false 且无 needConfirm/error → 用户取消文件选择器，静默
    } catch (error) {
      toast.error(t('settings.about.coreUpdateFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReplacingManual(false);
    }
  };

  // 同版本确认后强制替换
  const handleConfirmSameVersionReplace = async () => {
    const target = sameVersionConfirm;
    setSameVersionConfirm(null);
    if (!target) return;
    try {
      setReplacingManual(true);
      const result = await api.coreUpdate.replaceManual({ filePath: target.filePath, force: true });
      if (result.ok) {
        toast.success(t('settings.about.coreManualReplaceSuccess'), {
          description: t('settings.about.newCoreActive'),
        });
        await loadVersionInfo();
      } else if (result.error) {
        toast.error(t('settings.about.coreUpdateFail'), { description: result.error });
      }
    } catch (error) {
      toast.error(t('settings.about.coreUpdateFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReplacingManual(false);
    }
  };

  const handleApplyStaged = async () => {
    try {
      setApplyingStaged(true);
      // 按落位结果分情况反馈（修 M1：原仅以 boolean 判「已应用」，把 failed/discarded 误报成功）
      const result = await api.coreUpdate.applyStaged();
      switch (result) {
        case 'applied':
          toast.success(t('settings.coreManagement.applyNowSuccess', '新内核已应用'));
          break;
        case 'failed':
          toast.error(t('settings.coreManagement.applyNowFailed', '内核落位失败，已恢复原内核'));
          break;
        case 'discarded':
          toast.info(t('settings.coreManagement.applyNowDiscarded', '该暂存内核已不适用，已作废'));
          break;
        case 'deferred':
          toast.info(t('settings.coreManagement.applyNowDeferred', '内核暂未生效，仍待落位'));
          break;
        // noop：无暂存可应用，无需提示
      }
      await loadVersionInfo();
      await loadAutoStatus();
    } catch (error) {
      toast.error(t('settings.about.coreUpdateFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setApplyingStaged(false);
    }
  };

  // B6：重置内核到出厂版本
  const handleResetFactory = async () => {
    setShowResetConfirm(false);
    try {
      setResettingFactory(true);
      const result = await api.coreUpdate.resetFactory();
      if (result.ok) {
        setAvailableCoreUpdate(null);
        toast.success(t('settings.coreManagement.resetFactorySuccess'));
        await loadVersionInfo();
      } else {
        toast.error(t('settings.coreManagement.resetFactoryFail'), { description: result.error });
      }
    } catch (error) {
      toast.error(t('settings.coreManagement.resetFactoryFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResettingFactory(false);
    }
  };

  // B6：完全卸载 FlowZ
  const handleUninstallAll = async () => {
    setShowUninstallConfirm(false);
    try {
      setUninstalling(true);
      const result = await api.app.uninstallAll();
      if (!result.ok) {
        toast.error(t('settings.coreManagement.uninstallFail'), { description: result.error });
      }
      // ok:true 时主进程会清理并退出应用，无需前端反馈
    } catch (error) {
      toast.error(t('settings.coreManagement.uninstallFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUninstalling(false);
    }
  };

  const handleToggleAutoUpdate = (checked: boolean) => {
    if (!config) return;
    saveConfig({ ...config, autoUpdateCore: checked }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const handleToggleRestrictCoreUpdate = (checked: boolean) => {
    if (!config) return;
    saveConfig({ ...config, restrictCoreUpdateToCompatibleMinor: checked }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const busy =
    checkingCoreUpdate ||
    updatingCore ||
    replacingManual ||
    rollingBack ||
    applyingStaged ||
    resettingFactory ||
    uninstalling;

  // 第三方（非官方）内核：置灰在线/自动更新相关控件（检查更新 / 更新 / 自动更新开关 / 跨带限制 / 立即应用）。
  // 本地管理控件（手动替换 / 回滚 / 重置出厂 / 卸载）保留可用——它们是装/换内核与回到官方的逃生通道。
  const isForkCore = coreBuild === 'fork';
  const isUnknownCore = coreBuild === 'unknown';

  return (
    <Card>
      <CardContent className="pt-6">
        <h4 className="text-sm font-semibold">{t('settings.coreManagement.title')}</h4>

        <div className="mt-3 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t('settings.coreManagement.currentVersion')}
            </span>
            <span className="font-medium">{currentVersion}</span>
          </div>
          {hasBackup && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t('settings.coreManagement.backupVersion')}
              </span>
              <span className="font-medium">{backupVersion || '—'}</span>
            </div>
          )}
        </div>

        {/* 第三方（非官方）内核：警告卡 + 已禁用在线/自动更新的说明 + 恢复官方的指引。 */}
        {isForkCore && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-0.5">
              <p className="font-medium text-warning">
                {t('settings.coreManagement.nonOfficialTitle', '检测到第三方（非官方）内核')}
              </p>
              <p className="text-muted-foreground">
                {t(
                  'settings.coreManagement.nonOfficialDesc',
                  '已禁用在线更新与自动更新，以避免覆盖你手动安装的内核。如需恢复官方更新，请使用下方「回滚」或「重置到出厂内核」。'
                )}
              </p>
            </div>
          </div>
        )}
        {/* 无法确认来源（源码自建/go install）：中性提示，不禁更新。 */}
        {isUnknownCore && (
          <div className="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t(
                'settings.coreManagement.unknownBuildNote',
                '无法确认当前内核来源（可能为源码自建）。'
              )}
            </span>
          </div>
        )}

        {/* 常驻「发现新内核」入口（数据源 = store.availableCoreUpdate）。crossBand 时警告色 + 风险文案。 */}
        {availableCoreUpdate && (
          <div
            ref={updateEntryRef}
            className={[
              'mt-3 rounded-lg border p-4 transition-shadow',
              availableCoreUpdate.crossBand
                ? 'border-warning/40 bg-warning/10'
                : 'border-primary/40 bg-primary/10',
              entryHighlight ? 'ring-2 ring-primary/60' : '',
            ].join(' ')}
          >
            <div className="flex items-start gap-3">
              {availableCoreUpdate.crossBand ? (
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              ) : (
                <ArrowUpCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={[
                    'text-sm font-semibold',
                    availableCoreUpdate.crossBand ? 'text-warning' : 'text-primary',
                  ].join(' ')}
                >
                  {t('settings.coreManagement.updateAvailable', {
                    version: availableCoreUpdate.latestVersion,
                  })}
                </p>
                {availableCoreUpdate.crossBand && (
                  <p className="mt-1 text-xs text-warning">
                    {t('settings.coreManagement.crossBandRisk')}
                  </p>
                )}
                <div className="mt-3">
                  {/* 风格对齐「应用更新」按钮基准（主色默认 + w-full sm:w-auto） */}
                  <Button
                    onClick={() =>
                      handleUpdateCore(
                        availableCoreUpdate.downloadUrl,
                        availableCoreUpdate.latestVersion
                      )
                    }
                    disabled={busy || isForkCore}
                    className="w-full sm:w-auto"
                  >
                    {updatingCore && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                    {t('settings.coreManagement.updateNow')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col sm:flex-row flex-wrap gap-3">
          <Button
            onClick={handleCheckCoreUpdate}
            disabled={busy || isForkCore}
            className="w-full sm:w-auto"
          >
            {checkingCoreUpdate && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('settings.coreManagement.checkUpdate')}
          </Button>
          {hasBackup && (
            <Button
              variant="outline"
              onClick={handleRollback}
              disabled={busy}
              className="w-full sm:w-auto"
            >
              {rollingBack ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="me-2 h-4 w-4" />
              )}
              {t('settings.coreManagement.rollback')}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleReplaceManual}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {replacingManual ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <FolderUp className="me-2 h-4 w-4" />
            )}
            {t('settings.coreManagement.manualReplace')}
          </Button>
        </div>

        <Separator className="my-4" />

        <SettingsRow
          label={t('settings.coreManagement.autoUpdate')}
          description={t('settings.coreManagement.autoUpdateDesc')}
        >
          <Switch
            checked={config?.autoUpdateCore === true && !isForkCore}
            onCheckedChange={handleToggleAutoUpdate}
            disabled={isForkCore}
          />
        </SettingsRow>

        {/* 次级行：检查更新的跨带发现限制（从「高级」迁入；自动更新始终带内，不受此项影响） */}
        <SettingsRow
          label={t('settings.coreManagement.restrictCoreUpdate')}
          description={t('settings.coreManagement.restrictCoreUpdateDesc')}
        >
          <Switch
            checked={config?.restrictCoreUpdateToCompatibleMinor !== false}
            onCheckedChange={handleToggleRestrictCoreUpdate}
            disabled={isForkCore}
          />
        </SettingsRow>

        {autoStatus?.staged && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center gap-2 text-sm">
              <ArrowUpCircle className="h-4 w-4 shrink-0 text-primary" />
              <span>
                {t('settings.coreManagement.stagedPending', { version: autoStatus.staged.version })}
              </span>
            </div>
            <Button
              size="sm"
              onClick={handleApplyStaged}
              disabled={busy || isForkCore}
              title={t('settings.coreManagement.applyNowWarn')}
            >
              {applyingStaged && <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />}
              {t('settings.coreManagement.applyNow')}
            </Button>
          </div>
        )}

        {autoStatus?.crossBandLatest && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              {t('settings.coreManagement.crossBandFound', {
                version: autoStatus.crossBandLatest,
              })}
            </span>
          </div>
        )}

        <Separator className="my-4" />

        {/* B6：危险区（重置出厂 / 完全卸载） */}
        <div className="space-y-1">
          <h5 className="text-xs font-medium text-muted-foreground">
            {t('settings.coreManagement.dangerZone')}
          </h5>
          <p className="text-xs text-muted-foreground">
            {t('settings.coreManagement.dangerZoneDesc')}
          </p>
        </div>
        <div className="mt-3 flex flex-col sm:flex-row flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => setShowResetConfirm(true)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {resettingFactory ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Undo2 className="me-2 h-4 w-4" />
            )}
            {t('settings.coreManagement.resetFactory')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => setShowUninstallConfirm(true)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {uninstalling ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="me-2 h-4 w-4" />
            )}
            {t('settings.coreManagement.uninstallAll')}
          </Button>
        </div>
      </CardContent>

      {/* 同版本换核确认框 */}
      <AlertDialog
        open={sameVersionConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setSameVersionConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.coreManagement.sameVersionConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.coreManagement.sameVersionConfirmDesc', {
                version: sameVersionConfirm?.sameVersion ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSameVersionReplace}>
              {t('settings.coreManagement.sameVersionConfirmBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* B6：重置内核到出厂确认框 */}
      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.coreManagement.resetFactoryTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.coreManagement.resetFactoryDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetFactory}>
              {t('settings.coreManagement.resetFactoryConfirmBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* B6：完全卸载强警告确认框 */}
      <AlertDialog open={showUninstallConfirm} onOpenChange={setShowUninstallConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.coreManagement.uninstallTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{t('settings.coreManagement.uninstallDesc')}</p>
                <ul className="list-disc space-y-1 ps-5">
                  <li>{t('settings.coreManagement.uninstallItemHelper')}</li>
                  <li>{t('settings.coreManagement.uninstallItemCore')}</li>
                  <li>{t('settings.coreManagement.uninstallItemConfig')}</li>
                  <li>{t('settings.coreManagement.uninstallItemApp')}</li>
                </ul>
                <p className="font-medium text-destructive">
                  {t('settings.coreManagement.uninstallWarn')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUninstallAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('settings.coreManagement.uninstallConfirmBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
