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
  const { t } = useTranslation();

  if (!config) return null;

  const enabled = config.singboxDashboard === true;
  const running = connectionStatus?.proxyCore?.running === true;

  const handleToggle = (value: boolean) => {
    saveConfig({ ...config, singboxDashboard: value }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const openDashboard = () => {
    api.app.openSingboxDashboard().catch(() => toast.error(t('common.saveFailed')));
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
        <SettingsRow
          label={t('settings.advanced.openDashboard')}
          description={t('settings.advanced.dashboardNeedsNetwork')}
        >
          <Button variant="outline" size="sm" disabled={!running} onClick={openDashboard}>
            {t('settings.advanced.openDashboard')}
          </Button>
        </SettingsRow>
      )}
    </>
  );
}
