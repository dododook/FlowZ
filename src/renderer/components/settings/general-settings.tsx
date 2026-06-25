import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/store/app-store';
import { toast } from 'sonner';
import { api } from '@/ipc';
import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SettingsRow } from './settings-row';

type ToggleField =
  | 'autoStart'
  | 'silentStart'
  | 'autoConnect'
  | 'minimizeToTray'
  | 'autoCheckUpdate'
  | 'autoLightweightMode'
  | 'rememberWindowSize'
  | 'autoPrivacyMode'
  | 'desktopNotifications';

export function GeneralSettings() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  // F29：密码哈希在 main，渲染端不读明文。输入框 write-only（恒空起始），是否已设密码经 IPC 查询。
  const [passwordValue, setPasswordValue] = useState('');
  const [hasPrivacyPassword, setHasPrivacyPassword] = useState(false);
  useEffect(() => {
    api.privacy
      .hasPassword()
      .then(setHasPrivacyPassword)
      .catch(() => setHasPrivacyPassword(false));
  }, []);

  const handleToggle = async (field: ToggleField, value: boolean) => {
    if (!config) return;
    try {
      if (field === 'autoStart') {
        await api.autoStart.set(value);
      }
      await saveConfig({ ...config, [field]: value });
      toast.success(t('settings.general.successUpdate'), { duration: 2000 });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.general.failUpdate'));
    }
  };

  // F29：空白失焦不动（清除走显式按钮，避免 write-only 框误清已设密码）；非空 → main 哈希存储
  const handlePasswordSave = async (value: string) => {
    if (value === '') return;
    try {
      const { success } = await api.privacy.setPassword(value);
      if (!success) throw new Error('set password rejected');
      setPasswordValue('');
      setHasPrivacyPassword(true);
      toast.success(t('settings.general.successUpdate'), { duration: 2000 });
    } catch {
      toast.error(t('settings.general.failUpdate'));
    }
  };

  const handleClearPassword = async () => {
    try {
      await api.privacy.setPassword('');
      setPasswordValue('');
      setHasPrivacyPassword(false);
      toast.success(t('settings.general.successUpdate'), { duration: 2000 });
    } catch {
      toast.error(t('settings.general.failUpdate'));
    }
  };

  if (!config) return null;

  // 卡片分组与「网络」节一致：每个主题一张卡（启动 / 行为与隐私），而非单卡内分隔标题（UI 风格统一）。
  return (
    <div className="space-y-6">
      {/* 启动 */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.general.groupStartup', '启动')} />
          <SettingsRow
            label={t('settings.general.silentStart')}
            description={t('settings.general.silentStartDesc')}
          >
            <Switch
              checked={config.silentStart}
              onCheckedChange={(c) => handleToggle('silentStart', c)}
            />
          </SettingsRow>
          <SettingsRow label={t('settings.general.autoStartTitle')}>
            <Switch
              checked={config.autoStart}
              onCheckedChange={(c) => handleToggle('autoStart', c)}
            />
          </SettingsRow>
          <SettingsRow label={t('settings.general.autoConnect')}>
            <Switch
              checked={config.autoConnect}
              onCheckedChange={(c) => handleToggle('autoConnect', c)}
            />
          </SettingsRow>
          <SettingsRow label={t('settings.general.minimizeToTrayTitle')}>
            <Switch
              checked={config.minimizeToTray}
              onCheckedChange={(c) => handleToggle('minimizeToTray', c)}
            />
          </SettingsRow>
        </CardContent>
      </Card>

      {/* 行为与隐私 */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.general.groupBehavior', '行为与隐私')} />
          <SettingsRow label={t('settings.general.autoCheckUpdate')}>
            <Switch
              checked={config.autoCheckUpdate !== false}
              onCheckedChange={(c) => handleToggle('autoCheckUpdate', c)}
            />
          </SettingsRow>
          <SettingsRow label={t('settings.general.rememberWindowSize')}>
            <Switch
              checked={config.rememberWindowSize === true}
              onCheckedChange={(c) => handleToggle('rememberWindowSize', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.general.autoLightweightMode')}
            description={t('settings.general.autoLightweightModeDesc')}
          >
            <Switch
              checked={config.autoLightweightMode}
              onCheckedChange={(c) => handleToggle('autoLightweightMode', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.general.desktopNotifications')}
            description={t('settings.general.desktopNotificationsDesc')}
          >
            <Switch
              checked={config.desktopNotifications !== false}
              onCheckedChange={(c) => handleToggle('desktopNotifications', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.general.autoPrivacyMode')}
            description={t('settings.general.autoPrivacyModeDesc')}
          >
            <Switch
              checked={config.autoPrivacyMode === true}
              onCheckedChange={(c) => handleToggle('autoPrivacyMode', c)}
            />
          </SettingsRow>
          {config.autoPrivacyMode && (
            <SettingsRow label={t('settings.general.privacyPassword')} stacked>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  placeholder={t('settings.general.privacyPasswordPlaceholder')}
                  value={passwordValue}
                  onChange={(e) => setPasswordValue(e.target.value)}
                  onBlur={() => handlePasswordSave(passwordValue)}
                  className="h-8 max-w-[260px]"
                />
                {hasPrivacyPassword && (
                  <Button variant="outline" size="sm" className="h-8" onClick={handleClearPassword}>
                    {t('settings.general.clearPassword')}
                  </Button>
                )}
              </div>
            </SettingsRow>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
