import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { openExternal } from '@/bridge/api-wrapper';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from './shared/info-tooltip';
import { LOGIN_ITEMS_SETTINGS_URL } from '../../../shared/constants';

/**
 * 提权助手管理卡（macOS / Windows）：展示安装/就绪状态，提供安装/修复/卸载入口。
 * 与首页启动提示共享同一安装逻辑（store.installHelper / uninstallHelper）。
 * backgroundDisabled / pathMismatch / upgradeable 相关 UI 仅 macOS 渲染（Windows 这些 flag 恒 false，分支自然不显示）；
 * Windows 走「安装服务=一次 UAC、之后零提权」语义，文案（管理员授权框）平台通用。
 * macOS「允许在后台」被关时：检测到 backgroundDisabled → 提示 + 一键打开系统设置引导用户手动开启（程序无法翻动
 * 用户关掉的 BTM allowed 位，Apple SMAppService 无此 API）。开关恢复后状态会在几秒内自动刷新（focus / 轮询触发）。
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

  // mount 强制刷新 + 窗口 focus（切回 FlowZ=刚在系统设置改过开关）强制 fresh 检测 + focus 后 3/6/9s 各补刷一次：
  // 捕捉"开开关后 daemon 重新 bootstrap 完成"的滞后,使开开关后切回**一次**即在几秒内自动转「已安装就绪」。
  // **不常驻轮询**——开关关/需修复是稳定态,靠 focus 检测即可、不持续耗资源;补刷是 focus 触发的有限重试,9s 内停。
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

  // 状态徽章
  const statusBadge = () => {
    if (!helperStatus) return <Badge variant="secondary">{t('helper.statusChecking')}</Badge>;
    if (!helperStatus.installed)
      return <Badge variant="outline">{t('helper.statusNotInstalled')}</Badge>;
    if (helperStatus.backgroundDisabled)
      return (
        <Badge variant="destructive">
          {t('helper.statusBackgroundDisabled', '后台运行被禁用')}
        </Badge>
      );
    if (helperStatus.pathMismatch)
      return (
        <Badge variant="destructive">{t('helper.statusPathMismatch', '应用已移动，需修复')}</Badge>
      );
    if (helperStatus.needsRepair)
      return <Badge variant="destructive">{t('helper.statusNeedsRepair')}</Badge>;
    if (helperStatus.upgradeable)
      return <Badge variant="secondary">{t('helper.statusUpgradeable', '可升级')}</Badge>;
    return <Badge variant="default">{t('helper.statusInstalled')}</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {t('helper.title')}
          <InfoTooltip content={t('helper.descFull')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('helper.desc')}</p>
        {helperStatus?.backgroundDisabled && (
          <p className="text-sm text-destructive">
            {t(
              'helper.backgroundDisabledDesc',
              '系统设置中本应用的「允许在后台」已被关闭，提权助手无法运行，TUN 启停将退回每次弹管理员授权框。请点击下方「打开系统设置」，在「登录项与扩展」中重新开启 FlowZ 的「允许在后台」。开启后本页状态会在几秒内自动恢复。'
            )}
          </p>
        )}
        {helperStatus?.pathMismatch && !helperStatus?.backgroundDisabled && (
          <p className="text-sm text-destructive">
            {t(
              'helper.pathMismatchDesc',
              '提权助手登记的核心路径与当前应用不一致（应用可能被移动过），TUN 免授权启动将失效，请点击修复。'
            )}
          </p>
        )}
        {upgradeable && !needsRepair && !backgroundDisabled && (
          <p className="text-sm text-muted-foreground">
            {t(
              'helper.upgradeableDesc',
              '提权助手有新版本。当前版本 TUN 启停照常可用；升级后内核更新也将免授权（写入受保护目录）。可按需点击下方「升级」。'
            )}
          </p>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('helper.statusLabel')}</span>
          {statusBadge()}
        </div>

        <div className="flex gap-2 pt-1">
          {!installed && (
            <Button onClick={handleInstall} disabled={busy !== null}>
              {busy === 'install' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('helper.install')}
            </Button>
          )}
          {installed && backgroundDisabled && (
            <Button onClick={() => openExternal(LOGIN_ITEMS_SETTINGS_URL)} disabled={busy !== null}>
              {t('helper.disabledOpenSettings', '打开系统设置')}
            </Button>
          )}
          {installed && needsRepair && !backgroundDisabled && (
            <Button onClick={handleInstall} disabled={busy !== null}>
              {busy === 'install' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('helper.repair')}
            </Button>
          )}
          {installed && upgradeable && !needsRepair && !backgroundDisabled && (
            <Button onClick={handleInstall} disabled={busy !== null}>
              {busy === 'install' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('helper.upgrade', '升级')}
            </Button>
          )}
          {installed && (
            <Button variant="destructive" onClick={handleUninstall} disabled={busy !== null}>
              {busy === 'uninstall' && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('helper.uninstall')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
