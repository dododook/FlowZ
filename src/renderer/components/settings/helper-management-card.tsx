import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { openExternal } from '@/bridge/api-wrapper';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { InfoTooltip } from './shared/info-tooltip';
import { LOGIN_ITEMS_SETTINGS_URL } from '../../../shared/constants';

/**
 * 提权助手管理卡：状态机（检查中/未安装/后台被禁/路径不符/需修复/可升级/已安装就绪）只渲染当前活跃态一种。
 * 与首页启动提示共享同一安装逻辑（store.installHelper / uninstallHelper）。
 * backgroundDisabled / pathMismatch / upgradeable 相关 UI 仅 macOS 出现（Windows 这些 flag 恒 false）。
 */
export function HelperManagementCard() {
  const { t } = useTranslation();
  const helperStatus = useAppStore((s) => s.helperStatus);
  const refreshHelperStatus = useAppStore((s) => s.refreshHelperStatus);
  const installHelper = useAppStore((s) => s.installHelper);
  const uninstallHelper = useAppStore((s) => s.uninstallHelper);
  const [busy, setBusy] = useState<'install' | 'uninstall' | null>(null);

  const installed = helperStatus?.installed;
  const needsRepair = helperStatus?.needsRepair;
  const upgradeable = helperStatus?.upgradeable;
  const backgroundDisabled = helperStatus?.backgroundDisabled;

  // mount 刷新 + 窗口 focus（切回 FlowZ=刚在系统设置改过开关）强制 fresh 检测 + focus 后 3/6/9s 各补刷一次，
  // 捕捉 daemon 重新 bootstrap 的滞后；不常驻轮询——稳定态靠 focus 检测即可，补刷是有限重试，9s 内停。
  useEffect(() => {
    let timers: ReturnType<typeof setTimeout>[] = [];
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const refreshAndCatchUp = () => {
      clearTimers();
      refreshHelperStatus(true);
      timers = [3000, 6000, 9000].map((d) => setTimeout(() => refreshHelperStatus(true), d));
    };
    refreshAndCatchUp();
    window.addEventListener('focus', refreshAndCatchUp);
    return () => {
      window.removeEventListener('focus', refreshAndCatchUp);
      clearTimers();
    };
  }, [refreshHelperStatus]);

  // 恢复反馈闭环：backgroundDisabled 由 true → false → 提示用户「手动开启已生效」
  const prevBgDisabled = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (prevBgDisabled.current === true && backgroundDisabled === false) {
      toast.success(t('helper.backgroundRestored', '「允许在后台」已恢复，提权助手可用'));
    }
    prevBgDisabled.current = backgroundDisabled;
  }, [backgroundDisabled, t]);

  const handleInstall = async () => {
    setBusy('install');
    try {
      const res = await installHelper();
      if (res.success) toast.success(t('helper.installSuccess'));
      else toast.error(t('helper.installFail'), { description: res.error });
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async () => {
    setBusy('uninstall');
    try {
      const res = await uninstallHelper();
      if (res.success) toast.success(t('helper.uninstallSuccess'));
      else toast.error(t('helper.uninstallFail'), { description: res.error });
    } finally {
      setBusy(null);
    }
  };

  // 活跃态 → 图标色 / 徽章 pill / 单条说明（保留全部状态文案 key，收敛到当前活跃态）。
  const state: { ico: string; pill: string; label: string; desc: string } = !helperStatus
    ? { ico: 'warn', pill: 'info', label: t('helper.statusChecking'), desc: t('helper.desc') }
    : !helperStatus.installed
      ? { ico: 'err', pill: 'err', label: t('helper.statusNotInstalled'), desc: t('helper.desc') }
      : helperStatus.backgroundDisabled
        ? {
            ico: 'warn',
            pill: 'warn',
            label: t('helper.statusBackgroundDisabled', '后台运行被禁用'),
            desc: t('helper.backgroundDisabledDesc'),
          }
        : helperStatus.pathMismatch
          ? {
              ico: 'warn',
              pill: 'warn',
              label: t('helper.statusPathMismatch', '应用已移动，需修复'),
              desc: t('helper.pathMismatchDesc'),
            }
          : helperStatus.needsRepair
            ? {
                ico: 'err',
                pill: 'err',
                label: t('helper.statusNeedsRepair'),
                desc: t('helper.desc'),
              }
            : helperStatus.upgradeable
              ? {
                  ico: 'warn',
                  pill: 'warn',
                  label: t('helper.statusUpgradeable', '可升级'),
                  desc: t('helper.upgradeableDesc'),
                }
              : {
                  ico: 'ok',
                  pill: 'ok',
                  label: t('helper.statusInstalled'),
                  desc: t('helper.desc'),
                };

  return (
    <div className="card set-card">
      <div className="helper-top">
        <div className={cn('helper-ico', state.ico)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" strokeLinejoin="round" />
            <path d="M12 15V9M9 12l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="helper-info">
          <div className="helper-title">
            {t('helper.title')}
            <span className={cn('pill', state.pill)}>{state.label}</span>
            <InfoTooltip content={t('helper.descFull')} />
          </div>
          <div className="helper-desc">{state.desc}</div>
        </div>
        <div className="helper-act" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!installed && (
            <button
              type="button"
              className="btn flow sm"
              onClick={handleInstall}
              disabled={busy !== null}
            >
              {busy === 'install' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('helper.install')}
            </button>
          )}
          {installed && backgroundDisabled && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => openExternal(LOGIN_ITEMS_SETTINGS_URL)}
              disabled={busy !== null}
            >
              {t('helper.disabledOpenSettings', '打开系统设置')}
            </button>
          )}
          {installed && needsRepair && !backgroundDisabled && (
            <button
              type="button"
              className="btn flow sm"
              onClick={handleInstall}
              disabled={busy !== null}
            >
              {busy === 'install' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('helper.repair')}
            </button>
          )}
          {installed && upgradeable && !needsRepair && !backgroundDisabled && (
            <button
              type="button"
              className="btn flow sm"
              onClick={handleInstall}
              disabled={busy !== null}
            >
              {busy === 'install' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('helper.upgrade', '升级')}
            </button>
          )}
          {installed && (
            <button
              type="button"
              className="btn danger sm"
              onClick={handleUninstall}
              disabled={busy !== null}
            >
              {busy === 'uninstall' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('helper.uninstall')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
