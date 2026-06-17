import { RealTimeLogs } from '@/components/logs';
import { LogSettingsSection } from '@/components/logs/log-settings-section';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsCollapsible } from '@/components/settings/settings-collapsible';
import { DiagnosticSection } from '@/components/settings/diagnostic-section';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';

export function LogsPage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const level = config?.logLevel || 'info';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">{t('logs.pageTitle')}</h2>
        <p className="text-muted-foreground mt-1">{t('logs.pageDesc')}</p>
      </div>

      {/* 日志与诊断（排障归一 C1/H2/M4）：默认折叠，触发标题常显当前级别，保持日志查看器为主。 */}
      <Card>
        <CardContent className="pt-2">
          <SettingsCollapsible
            label={
              <span>
                {t('logs.settingsTitle', '日志与诊断')}
                <span className="ml-2 font-normal text-muted-foreground">
                  · {t('logs.currentLevel', '级别')}: {level}
                </span>
              </span>
            }
          >
            <div className="divide-y divide-border/60">
              <LogSettingsSection />
            </div>
            <div className="pt-4">
              <DiagnosticSection />
            </div>
          </SettingsCollapsible>
        </CardContent>
      </Card>

      <RealTimeLogs
        heightClass="h-[calc(100vh-360px)] min-h-[320px]"
        initialLimit={200}
        maxBuffer={500}
      />
    </div>
  );
}
