import { X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UpdateInfo } from '../../../shared/types/update';

interface AppUpdateBannerProps {
  updateInfo: UpdateInfo;
  downloading: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

/**
 * F28：发现 App 新版本时的常驻入口（Conduit .app-update-banner）。
 * 取代仅 8s 的 toast——toast 仍作即时反馈，本横幅提供持久可达的更新动作；dismiss 保留清除入口。
 */
export function AppUpdateBanner({
  updateInfo,
  downloading,
  onUpdate,
  onDismiss,
}: AppUpdateBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="app-update-banner">
      <span className="aub-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <path d="M12 3v11M8 10l4 4 4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="aub-tx">
        <b>{t('settings.about.foundUpdate', { version: updateInfo.version })}</b>
        <span>{t('settings.about.clickToInstall')}</span>
      </div>
      <button type="button" className="btn flow sm" disabled={downloading} onClick={onUpdate}>
        {downloading && <Loader2 className="h-3 w-3 animate-spin" />}
        {t('settings.about.updateNow')}
      </button>
      <button
        type="button"
        className="btn ghost sm"
        onClick={onDismiss}
        title={t('settings.coreVersion.dismiss')}
        aria-label={t('settings.coreVersion.dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
