import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';

/**
 * sing-box 官方面板（opt-in 逃生舱）：开关 + 打开按钮。
 * 开关写 config.singboxDashboard，经 saveConfig→CONFIG_CHANGED 自动重启生效（不显式 restart）。
 * 「打开面板」仅开关 on 且代理运行时可点 → 调 IPC，main 用运行期 api 端口构造 /dashboard/ URL + 系统浏览器打开。
 * 父级包 `<Card><CardContent className="divide-y...">` 渲染本组件返回的 SettingsRow 片段。
 */
export function SingboxDashboardSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const { t, i18n } = useTranslation();

  const enabled = config?.singboxDashboard === true;
  const running = connectionStatus?.proxyCore?.running === true;

  // 面板 URL（形如 http://127.0.0.1:<动态端口>/dashboard/）：仅运行 + 面板开关 on 时从 main 拉一次（端口动态，渲染端构造不出）。
  // 复用 GET_SINGBOX_DASHBOARD_CONNECTION 的 url 字段——不含 secret，安全可显，供用户手动在浏览器打开。
  const [dashboardUrl, setDashboardUrl] = useState('');
  useEffect(() => {
    if (!enabled || !running) {
      setDashboardUrl('');
      return;
    }
    let cancelled = false;
    api.app
      .getSingboxDashboardConnection()
      .then((info) => {
        if (!cancelled) setDashboardUrl(info.ok ? info.url : '');
      })
      .catch(() => {
        if (!cancelled) setDashboardUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, running]);

  if (!config) return null;

  const handleToggle = (value: boolean) => {
    saveConfig({ ...config, singboxDashboard: value }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const openDashboard = () => {
    // 传渲染端实际 UI 语言（i18n.language，如 zh-CN/zh-TW），main 据此对齐内窗口面板语言；
    // 不能用 app.getLocale()（拿的是 Electron app bundle locale，FlowZ.app 未声明 zh → 恒 en，与 UI 语言脱钩）。
    api.app.openSingboxDashboard(i18n.language).catch(() => toast.error(t('common.saveFailed')));
  };

  // 复制连接信息（dashboard #55）：URL=管理 API 地址 + secret=clashApiSecret，经 IPC 从 main 现取（secret 不长驻渲染端 store）。
  // 供手动在其它面板/工具填后端用，与内窗口一键直连互为补充。
  const copyConnection = async () => {
    try {
      const info = await api.app.getSingboxDashboardConnection();
      if (!info.ok) {
        toast.error(t('settings.advanced.dashboardCopyUnavailable'));
        return;
      }
      await navigator.clipboard.writeText(`URL=${info.apiUrl}\nsecret=${info.secret}`);
      toast.success(t('settings.advanced.dashboardCopied'));
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  return (
    <>
      <SettingsRow heading label={t('settings.advanced.singboxDashboard')} />
      <SettingsRow
        label={t('settings.advanced.singboxDashboard')}
        description={t('settings.advanced.singboxDashboardDesc')}
        tooltip={t('settings.advanced.dashboardNeedsNetwork')}
      >
        <Switch checked={enabled} onCheckedChange={handleToggle} />
      </SettingsRow>
      {enabled && (
        <>
          <SettingsRow
            label={t('settings.advanced.openDashboard')}
            description={t('settings.advanced.dashboardNeedsNetwork')}
          >
            <Button variant="outline" size="sm" disabled={!running} onClick={openDashboard}>
              {t('settings.advanced.openDashboard')}
            </Button>
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.dashboardAddress')}
            description={t('settings.advanced.dashboardAddressDesc')}
          >
            {running && dashboardUrl ? (
              <button
                type="button"
                onClick={() => api.system.openExternal(dashboardUrl).catch(() => undefined)}
                title={dashboardUrl}
                className="max-w-[18rem] select-text truncate font-mono text-xs text-primary hover:underline"
              >
                {dashboardUrl}
              </button>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">
                {t('settings.advanced.dashboardAddressUnavailable')}
              </span>
            )}
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.dashboardCopyConnection')}
            description={t('settings.advanced.dashboardCopyConnectionDesc')}
          >
            <Button variant="outline" size="sm" disabled={!running} onClick={copyConnection}>
              {t('settings.advanced.dashboardCopyConnection')}
            </Button>
          </SettingsRow>
        </>
      )}
    </>
  );
}
