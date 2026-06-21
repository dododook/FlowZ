import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { DEFAULT_SINGBOX_DASHBOARD_URL } from '@shared/gh-proxy';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';

/**
 * sing-box 官方面板（opt-in 逃生舱）：开关 + download_url 覆盖输入框 + 打开 / 刷新资源按钮。
 * 开关/URL 写 config，经 saveConfig→CONFIG_CHANGED 自动重启生效（不显式 restart）。改 URL → main 删缓存目录，
 * 核下次启动重拉新资源。「打开面板」仅开关 on 且代理运行时可点；返回 ok:false（资源未就绪/未联网）→ 行内提示而非裸 404。
 * 「刷新面板资源」清缓存目录，提示下次启动重拉。父级包 `<Card><CardContent className="divide-y...">`。
 */
export function SingboxDashboardSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const { t } = useTranslation();

  const [urlInput, setUrlInput] = useState('');

  // config 到达/外部变更时同步本地输入（空=用默认）。
  useEffect(() => {
    setUrlInput(config?.singboxDashboardUrl ?? '');
  }, [config?.singboxDashboardUrl]);

  if (!config) return null;

  const enabled = config.singboxDashboard === true;
  const running = connectionStatus?.proxyCore?.running === true;

  const handleToggle = (value: boolean) => {
    saveConfig({ ...config, singboxDashboard: value }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  // 输入框失焦保存覆盖 URL：空白归一为 undefined（用默认）。未变更不写。
  const handleUrlBlur = () => {
    const next = urlInput.trim() || undefined;
    const prev = config.singboxDashboardUrl ?? undefined;
    if (next === prev) return;
    saveConfig({ ...config, singboxDashboardUrl: next }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const openDashboard = () => {
    api.app
      .openSingboxDashboard()
      .then((res) => {
        if (!res?.ok) toast.error(t('settings.advanced.dashboardNotReady'));
      })
      .catch(() => toast.error(t('settings.advanced.dashboardNotReady')));
  };

  const refreshDashboard = () => {
    api.app
      .refreshSingboxDashboard()
      .then((res) => {
        if (res?.ok) toast.success(t('settings.advanced.dashboardRefreshed'));
        else toast.error(t('common.saveFailed'));
      })
      .catch(() => toast.error(t('common.saveFailed')));
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
            label={t('settings.advanced.dashboardUrl')}
            description={t('settings.advanced.dashboardUrlDesc')}
          >
            <Input
              className="w-full sm:w-80"
              value={urlInput}
              placeholder={DEFAULT_SINGBOX_DASHBOARD_URL}
              onChange={(e) => setUrlInput(e.target.value)}
              onBlur={handleUrlBlur}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.openDashboard')}
            description={t('settings.advanced.dashboardNeedsNetwork')}
          >
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!running} onClick={openDashboard}>
                {t('settings.advanced.openDashboard')}
              </Button>
              <Button variant="outline" size="sm" onClick={refreshDashboard}>
                {t('settings.advanced.dashboardRefresh')}
              </Button>
            </div>
          </SettingsRow>
        </>
      )}
    </>
  );
}
