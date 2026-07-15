import { useAppStore } from '@/store/app-store';
import { toast } from 'sonner';
import { api } from '@/ipc';
import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
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
  | 'desktopNotifications'
  | 'disableHardwareAcceleration'
  | 'disableWindowEffects';

export function GeneralSettings() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  // F29：密码哈希在 main，渲染端不读明文。输入框 write-only（恒空起始），是否已设密码经 IPC 查询。
  // macOS 关窗恒不退出 app（红灯关窗是平台惯例，shouldQuitOnAllWindowsClosed 对 darwin 恒 false）→
  // minimizeToTray 在 macOS 上完全无效，隐藏该开关（否则是个拨了没反应的死开关）。
  const isMac = window.electron?.platform === 'darwin';
  // disableWindowEffects 仅规避 Windows Mica 合成失效 → 仅 Windows 显示（其它平台开了无意义）。
  const isWindows = window.electron?.platform === 'win32';
  // Linux 已在主进程无条件禁用硬件加速（index.ts「Linux 一律禁用硬件加速换稳定」）→ disableHardwareAcceleration
  // 在 Linux 上是拨了没反应的死开关，且 OFF 态会谎称「硬件加速开启」误导用户白跑一轮自救；Mica 开关又仅 Windows。
  // 故 Linux 上整张图形兼容卡无可用项 → 整卡隐藏（同 minimizeToTray 在 macOS 的死开关隐藏惯例）。
  const isLinux = window.electron?.platform === 'linux';
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

  // Conduit 开关：静态复用 prototype 的 .swt 按钮（role=switch），保留 config 真值与 handleToggle。
  const Toggle = ({ field, checked }: { field: ToggleField; checked: boolean }) => (
    <button
      type="button"
      className={cn('swt', checked && 'on')}
      role="switch"
      aria-checked={checked}
      onClick={() => handleToggle(field, !checked)}
    />
  );

  // 卡片分组与「网络」节一致：每个主题一张卡（启动 / 行为与隐私），set-h 作卡头。
  return (
    <div className="set-panel">
      {/* 启动 */}
      <div className="card set-card">
        <div className="set-h">
          <b>{t('settings.general.groupStartup', '启动')}</b>
          <small>{t('settings.general.startupSub', '应用启动与托盘行为')}</small>
        </div>
        <SettingsRow
          label={t('settings.general.silentStart')}
          description={t('settings.general.silentStartDesc')}
        >
          <Toggle field="silentStart" checked={config.silentStart} />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.autoStartTitle')}
          description={t('settings.general.autoStartDesc', '登录系统时自动运行 FlowZ')}
        >
          <Toggle field="autoStart" checked={config.autoStart} />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.autoConnect')}
          description={t('settings.general.autoConnectDesc', '恢复上次的出口节点与接管方式并连接')}
        >
          <Toggle field="autoConnect" checked={config.autoConnect} />
        </SettingsRow>
        {!isMac && (
          <SettingsRow
            label={t('settings.general.minimizeToTrayTitle')}
            description={t('settings.general.minimizeToTrayDesc')}
          >
            <Toggle field="minimizeToTray" checked={config.minimizeToTray} />
          </SettingsRow>
        )}
      </div>

      {/* 行为与隐私 */}
      <div className="card set-card">
        <div className="set-h">
          <b>{t('settings.general.groupBehavior', '行为与隐私')}</b>
          <small>{t('settings.general.behaviorSub', '更新提示、窗口与隐私遮罩')}</small>
        </div>
        <SettingsRow
          label={t('settings.general.autoCheckUpdate')}
          description={t('settings.general.autoCheckUpdateDesc', '发现新版本时在关于页提示')}
        >
          <Toggle field="autoCheckUpdate" checked={config.autoCheckUpdate !== false} />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.rememberWindowSize')}
          description={t('settings.general.rememberWindowSizeDesc', '下次打开时还原上次的窗口布局')}
        >
          <Toggle field="rememberWindowSize" checked={config.rememberWindowSize === true} />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.desktopNotifications')}
          description={t('settings.general.desktopNotificationsDesc')}
        >
          <Toggle field="desktopNotifications" checked={config.desktopNotifications !== false} />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.autoLightweightMode')}
          description={t('settings.general.autoLightweightModeDesc')}
        >
          <Toggle field="autoLightweightMode" checked={config.autoLightweightMode} />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.autoPrivacyMode')}
          description={t('settings.general.autoPrivacyModeDesc')}
        >
          <Toggle field="autoPrivacyMode" checked={config.autoPrivacyMode === true} />
        </SettingsRow>
        {config.autoPrivacyMode && (
          <SettingsRow label={t('settings.general.privacyPassword')}>
            <input
              className="input"
              type="password"
              placeholder={t('settings.general.privacyPasswordPlaceholder')}
              value={passwordValue}
              onChange={(e) => setPasswordValue(e.target.value)}
              onBlur={() => handlePasswordSave(passwordValue)}
              aria-label={t('settings.general.privacyPassword')}
              style={{ width: 200 }}
            />
            {hasPrivacyPassword && (
              <button type="button" className="btn ghost sm" onClick={handleClearPassword}>
                {t('settings.general.clearPassword')}
              </button>
            )}
          </SettingsRow>
        )}
      </div>

      {/* 图形兼容（逃生门）：显示异常/白屏时的用户自救开关，均需重启生效（描述内注明）。Linux 整卡隐藏（见 isLinux）。 */}
      {!isLinux && (
        <div className="card set-card">
          <div className="set-h">
            <b>{t('settings.general.groupGraphics', '图形兼容')}</b>
            <small>{t('settings.general.graphicsSub', '显示异常或白屏时的自救选项')}</small>
          </div>
          <SettingsRow
            label={t('settings.general.disableHardwareAcceleration')}
            description={t('settings.general.disableHardwareAccelerationDesc')}
          >
            <Toggle
              field="disableHardwareAcceleration"
              checked={config.disableHardwareAcceleration === true}
            />
          </SettingsRow>
          {isWindows && (
            <SettingsRow
              label={t('settings.general.disableWindowEffects')}
              description={t('settings.general.disableWindowEffectsDesc')}
            >
              <Toggle field="disableWindowEffects" checked={config.disableWindowEffects === true} />
            </SettingsRow>
          )}
        </div>
      )}
    </div>
  );
}
