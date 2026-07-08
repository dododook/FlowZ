/**
 * 内核管理卡片（Conduit 高级面板 `.card.set-card`；sing-box 核心版本 / 检查更新 / 回滚 / 手动替换 /
 * 自动更新开关 / staged 待生效 / 跨带提示 / 危险区）。从 about-settings 的「sing-box 版本」区块迁入。
 * 自动更新仅在兼容版本带内（如 1.13.x→1.13.y）；跨大版本（1.13→1.14）需手动确认。
 *
 * 更新呈现 = 常驻状态 + 可选弹窗：检查到新内核后在卡内常驻显示「发现新内核 vX.Y.Z + 更新按钮」（数据放
 * store 的 availableCoreUpdate，跨设置子节卸载持久）；toast 降级为可选提醒，点击只滚动/高亮到常驻入口，
 * 不再是唯一更新触发。crossBand 时警告色 + 风险文案。
 */

import { useState, useEffect, useRef } from 'react';
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
import { Loader2, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { checkCoreUpdate, updateCore } from '@/bridge/api-wrapper';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';
import type { CoreBuildKind } from '../../../shared/core-build';
import { Srow, Swt } from './conduit-controls';

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
  // B-2 基线预判确认（上传官方核旧于随包基线，替换后下次连接将被 reseed 打回，弹框诚实告知）
  const [baselineConfirm, setBaselineConfirm] = useState<{
    uploadVersion: string;
    bundledVersion: string;
    filePath: string;
  } | null>(null);
  // B6 两个确认框
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

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

  // 替换成功提示：fork/unknown 内核追加来源提示（B-3），官方内核提示已生效。
  const showReplaceSuccess = (build?: CoreBuildKind) => {
    toast.success(t('settings.about.coreManualReplaceSuccess'), {
      description:
        build === 'fork'
          ? t('settings.coreManagement.manualForkNotice')
          : build === 'unknown'
            ? t('settings.coreManagement.manualUnknownNotice')
            : t('settings.about.newCoreActive'),
    });
  };

  // 手动替换：无参调用 → 弹文件选择器 + 预检 + 同版本/基线检测；needConfirm 时弹对应确认框。
  const handleReplaceManual = async () => {
    try {
      setReplacingManual(true);
      const result = await api.coreUpdate.replaceManual();
      if (result.ok) {
        showReplaceSuccess(result.build);
        await loadVersionInfo();
      } else if (result.needConfirm && result.baselineOverride && result.filePath) {
        // 官方核旧于随包基线：替换后下次连接会被 reseed 打回，弹框诚实告知（B-2）
        setBaselineConfirm({
          uploadVersion: result.uploadVersion ?? '',
          bundledVersion: result.bundledVersion ?? '',
          filePath: result.filePath,
        });
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
        showReplaceSuccess(result.build);
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

  // 基线预判确认后临时替换（force 越过 reseed 预判；用到下次连接为止）
  const handleConfirmBaselineReplace = async () => {
    const target = baselineConfirm;
    setBaselineConfirm(null);
    if (!target) return;
    try {
      setReplacingManual(true);
      const result = await api.coreUpdate.replaceManual({ filePath: target.filePath, force: true });
      if (result.ok) {
        showReplaceSuccess(result.build);
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

  // 来源徽章（官方=ok / 第三方=warn / 未知=idle），与 src-legend 图例同源。
  const buildPill =
    coreBuild === 'official'
      ? { cls: 'ok', label: t('settings.coreManagement.sourceOfficial', '官方') }
      : coreBuild === 'fork'
        ? { cls: 'warn', label: t('settings.coreManagement.sourceFork', '第三方') }
        : { cls: 'idle', label: t('settings.coreManagement.sourceUnknown', '未知') };

  return (
    <div className="card set-card">
      <div className="set-h">
        <b>{t('settings.coreManagement.title')}</b>
        <small>{t('settings.coreManagement.cardSub', 'sing-box 版本、来源与更新')}</small>
      </div>

      {/* 当前版本 + 来源徽章 + 检查更新 */}
      <Srow
        label={
          <>
            {t('settings.coreManagement.currentVersion')}
            <span className={cn('pill', buildPill.cls)}>{buildPill.label}</span>
          </>
        }
        desc={t('settings.coreManagement.sourceDesc', '内核来源：官方 / 第三方 / 未知 自动识别')}
      >
        <span className="mono tnum" style={{ fontSize: 13, fontWeight: 640 }}>
          {currentVersion}
        </span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={handleCheckCoreUpdate}
          disabled={busy || isForkCore}
        >
          {checkingCoreUpdate && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('settings.coreManagement.checkUpdate')}
        </button>
      </Srow>

      {/* 来源图例 */}
      <div className="src-legend">
        <span className="pill ok">{t('settings.coreManagement.sourceOfficial', '官方')}</span>
        <span className="src-note">
          {t('settings.coreManagement.srcNoteOfficial', 'GitHub 在线更新可用')}
        </span>
        <span className="pill warn">{t('settings.coreManagement.sourceFork', '第三方')}</span>
        <span className="src-note">
          {t('settings.coreManagement.srcNoteFork', '禁在线 / 自动更新')}
        </span>
        <span className="pill idle">{t('settings.coreManagement.sourceUnknown', '未知')}</span>
        <span className="src-note">
          {t('settings.coreManagement.srcNoteUnknown', '无法确认，仅提示')}
        </span>
      </div>

      {/* 第三方（非官方）内核：警告 + 已禁用在线/自动更新的说明 + 恢复官方的指引。 */}
      {isForkCore && (
        <div className="set-pad" style={{ paddingTop: 0 }}>
          <div className="set-note warn">
            <AlertTriangle />
            <div>
              <div style={{ fontWeight: 600 }}>
                {t('settings.coreManagement.nonOfficialTitle', '检测到第三方（非官方）内核')}
              </div>
              <div className="ng-hint" style={{ marginTop: 2 }}>
                {t('settings.coreManagement.nonOfficialDesc')}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 无法确认来源（源码自建/go install）：中性提示，不禁更新。 */}
      {isUnknownCore && (
        <div className="set-pad" style={{ paddingTop: 0 }}>
          <div
            className="set-note"
            style={{ background: 'hsl(var(--surface-2))', color: 'hsl(var(--fg-dim))' }}
          >
            <AlertTriangle />
            <span>
              {t(
                'settings.coreManagement.unknownBuildNote',
                '无法确认当前内核来源（可能为源码自建）。'
              )}
            </span>
          </div>
        </div>
      )}

      {/* 备份版本 + 回滚 */}
      {hasBackup && (
        <Srow
          label={t('settings.coreManagement.backupVersion')}
          desc={t('settings.coreManagement.backupVersionDesc', '升级失败或异常时可回滚至此版本')}
        >
          <span className="mono tnum" style={{ fontSize: 13, color: 'hsl(var(--fg-dim))' }}>
            {backupVersion || '—'}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowRollbackConfirm(true)}
            disabled={busy}
          >
            {rollingBack && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('settings.coreManagement.rollback')}
          </button>
        </Srow>
      )}

      {/* 常驻「发现新内核」入口（数据源 = store.availableCoreUpdate）。crossBand 时警告色 + 风险文案。 */}
      {availableCoreUpdate && (
        <div className="set-pad" style={{ paddingTop: 0 }} ref={updateEntryRef}>
          <div
            className={cn('set-note', availableCoreUpdate.crossBand ? 'warn' : 'info')}
            style={entryHighlight ? { boxShadow: '0 0 0 2px hsl(var(--flow) / 0.6)' } : undefined}
          >
            {availableCoreUpdate.crossBand ? <AlertTriangle /> : <ArrowUpCircle />}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {t('settings.coreManagement.updateAvailable', {
                  version: availableCoreUpdate.latestVersion,
                })}
              </div>
              {availableCoreUpdate.crossBand && (
                <div className="ng-hint ng-warn" style={{ marginTop: 2 }}>
                  {t('settings.coreManagement.crossBandRisk')}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn flow sm"
              onClick={() =>
                handleUpdateCore(availableCoreUpdate.downloadUrl, availableCoreUpdate.latestVersion)
              }
              disabled={busy || isForkCore}
            >
              {updatingCore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('settings.coreManagement.updateNow')}
            </button>
          </div>
        </div>
      )}

      {/* 暂存待生效（自动更新下载后待落位） */}
      {autoStatus?.staged && (
        <div className="set-pad" style={{ paddingTop: 0 }}>
          <div className="set-note info">
            <ArrowUpCircle />
            <span>
              {t('settings.coreManagement.stagedPending', { version: autoStatus.staged.version })}
            </span>
            <button
              type="button"
              className="btn flow sm"
              onClick={handleApplyStaged}
              disabled={busy || isForkCore}
              title={t('settings.coreManagement.applyNowWarn')}
            >
              {applyingStaged && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('settings.coreManagement.applyNow')}
            </button>
          </div>
        </div>
      )}

      {/* 跨版本带新版提示（不自动更新） */}
      {autoStatus?.crossBandLatest && (
        <div className="set-pad" style={{ paddingTop: 0 }}>
          <div className="set-note warn">
            <AlertTriangle />
            <span>
              {t('settings.coreManagement.crossBandFound', {
                version: autoStatus.crossBandLatest,
              })}
            </span>
          </div>
        </div>
      )}

      {/* 内核自动更新 */}
      <Srow
        label={t('settings.coreManagement.autoUpdate')}
        desc={t('settings.coreManagement.autoUpdateDesc')}
      >
        <Swt
          checked={config?.autoUpdateCore === true && !isForkCore}
          onChange={handleToggleAutoUpdate}
          disabled={isForkCore}
        />
      </Srow>

      {/* 次级：检查更新的跨带发现限制（自动更新始终带内，不受此项影响） */}
      <Srow
        label={t('settings.coreManagement.restrictCoreUpdate')}
        desc={t('settings.coreManagement.restrictCoreUpdateDesc')}
      >
        <Swt
          checked={config?.restrictCoreUpdateToCompatibleMinor !== false}
          onChange={handleToggleRestrictCoreUpdate}
          disabled={isForkCore}
        />
      </Srow>

      {/* 手动替换内核 */}
      <Srow
        label={t('settings.coreManagement.manualReplace')}
        desc={t(
          'settings.coreManagement.manualReplaceDesc',
          '导入本地 sing-box 可执行文件（同版本 / 覆盖基线需二次确认）'
        )}
      >
        <button
          type="button"
          className="btn ghost sm"
          onClick={handleReplaceManual}
          disabled={busy}
        >
          {replacingManual && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('settings.coreManagement.selectFile', '选择文件…')}
        </button>
      </Srow>

      {/* B6：危险区（重置出厂 / 完全卸载） */}
      <div className="danger-zone">
        <div className="set-sub-h">{t('settings.coreManagement.dangerZone')} · DANGER ZONE</div>
        <div className="danger-row">
          <div className="srow-main">
            <div className="srow-lbl">{t('settings.coreManagement.resetFactory')}</div>
            <div className="srow-desc">
              {t('settings.coreManagement.resetFactoryRowDesc', '恢复随 App 出厂的官方内核版本')}
            </div>
          </div>
          <button
            type="button"
            className="btn danger sm"
            onClick={() => setShowResetConfirm(true)}
            disabled={busy}
          >
            {resettingFactory && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('settings.coreManagement.resetShort', '重置')}
          </button>
        </div>
        <div className="danger-row">
          <div className="srow-main">
            <div className="srow-lbl">{t('settings.coreManagement.uninstallAll')}</div>
            <div className="srow-desc">
              {t('settings.coreManagement.uninstallRowDesc', '移除内核、助手、配置与全部本地数据')}
            </div>
          </div>
          <button
            type="button"
            className="btn danger sm"
            onClick={() => setShowUninstallConfirm(true)}
            disabled={busy}
          >
            {uninstalling && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('settings.coreManagement.uninstallShort', '完全卸载')}
          </button>
        </div>
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
                version: backupVersion || '—',
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
              {t('settings.coreManagement.rollback')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      {/* B-2 基线预判确认框（官方核旧于随包基线，替换后下次连接将被 reseed 打回） */}
      <AlertDialog
        open={baselineConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setBaselineConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.coreManagement.baselineOverrideConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.coreManagement.baselineOverrideConfirmDesc', {
                upload: baselineConfirm?.uploadVersion ?? '',
                bundled: baselineConfirm?.bundledVersion ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmBaselineReplace}>
              {t('settings.coreManagement.baselineOverrideConfirmBtn')}
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
    </div>
  );
}
