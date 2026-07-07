import { RealTimeLogs } from '@/components/logs';
import { getLevelPillClass } from '@/components/logs/real-time-logs-logic';
import { LogSettingsSection } from '@/components/logs/log-settings-section';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SettingsCollapsible } from '@/components/settings/settings-collapsible';
import { DiagnosticSection } from '@/components/settings/diagnostic-section';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { cn } from '@/lib/utils';

export function LogsPage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const level = config?.logLevel || 'info';

  return (
    <div className="space-y-4">
      <PageHeader title={t('logs.pageTitle')} description={t('logs.pageDesc')} />

      {/* 日志与诊断（排障归一 C1/H2/M4）：默认折叠，触发标题常显当前级别，保持日志查看器为主。 */}
      <Card>
        <CardContent className="pt-2">
          <SettingsCollapsible
            label={
              <span className="inline-flex items-center">
                {t('logs.settingsTitle', '日志与诊断')}
                <span className="ms-2 font-normal text-muted-foreground">
                  · {t('logs.currentLevel', '级别')}
                </span>
                {/* 级别 pill：形+色双编码（warn/error 语义色，其余中性），色档单一真值取自 getLevelPillClass；
                    复用 ui/badge 基座（非自绘 span），rounded/字号经 className 收窄为紧凑内联标。 */}
                <Badge
                  variant="outline"
                  className={cn(
                    'ms-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    getLevelPillClass(level)
                  )}
                >
                  {level}
                </Badge>
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
