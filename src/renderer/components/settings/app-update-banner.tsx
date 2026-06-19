import { Download, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import type { UpdateInfo } from '../../../shared/types/update';

interface AppUpdateBannerProps {
  updateInfo: UpdateInfo;
  downloading: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

/**
 * F28：发现 App 新版本时的常驻入口（复用 CoreVersionBanner 视觉范式）。
 * 取代仅 15s 的 toast——toast 仍作即时反馈，本卡片提供持久可达的更新动作。
 */
export function AppUpdateBanner({
  updateInfo,
  downloading,
  onUpdate,
  onDismiss,
}: AppUpdateBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/10 p-4 mb-4">
      <div className="flex items-start gap-3">
        <Download className="h-5 w-5 text-primary mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-primary">
            {t('settings.about.foundUpdate', { version: updateInfo.version })}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{t('settings.about.clickToInstall')}</p>
          <div className="mt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={downloading}
              onClick={onUpdate}
              className="h-7 text-xs border-primary/50 text-primary hover:bg-primary/20"
            >
              {downloading && <Loader2 className="me-1.5 h-3 w-3 animate-spin" />}
              {t('settings.about.updateNow')}
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          title={t('settings.coreVersion.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
