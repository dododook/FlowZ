import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { effectiveRegionRouting } from '../../../shared/region-routing';
import type { RegionId, RegionRoutingConfig } from '../../../shared/types';

/** 地区分流（内置 geo 基线场景）卡片：开关 + 地区选择 + 反向（回国/反向 自适应）。仅智能分流模式生效。 */
const REGIONS: { id: RegionId; key: string; fallback: string }[] = [
  { id: 'cn', key: 'rules.regionCn', fallback: 'Mainland China' },
  { id: 'ir', key: 'rules.regionIr', fallback: 'Iran' },
  { id: 'ru', key: 'rules.regionRu', fallback: 'Russia' },
];

export function RegionRoutingCard() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const setConfigValue = useAppStore((s) => s.setConfigValue);
  const region = effectiveRegionRouting(config ?? {});
  const isSmart = (config?.proxyMode || 'smart').toLowerCase() === 'smart';

  const update = (patch: Partial<RegionRoutingConfig>) => {
    void setConfigValue('regionRouting', { ...region, ...patch });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t('rules.regionRouting', 'Region routing')}</CardTitle>
            <CardDescription className="mt-1.5 leading-relaxed">
              {t(
                'rules.regionRoutingDesc',
                'Auto-route by region: local direct, overseas via proxy. Only in Smart mode.'
              )}
            </CardDescription>
          </div>
          <Switch
            checked={region.enabled}
            onCheckedChange={(v) => update({ enabled: v })}
            aria-label={t('rules.regionRouting', 'Region routing')}
          />
        </div>
      </CardHeader>
      {region.enabled && (
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">{t('rules.region', 'Region')}</p>
            <div className="inline-flex rounded-lg border bg-secondary/40 p-1">
              {REGIONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => update({ region: r.id })}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-sm transition-colors',
                    region.region === r.id
                      ? 'bg-background font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(r.key, r.fallback)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5 pe-3">
              <p className="text-sm font-medium">
                {region.region === 'cn'
                  ? t('rules.regionReverseCn', 'Back to China')
                  : t('rules.regionReverse', 'Reverse (access local from abroad)')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  'rules.regionReverseDesc',
                  "Local via proxy, overseas direct — access the selected region's local content from abroad."
                )}
              </p>
            </div>
            <Switch checked={region.reverse} onCheckedChange={(v) => update({ reverse: v })} />
          </div>
          {!isSmart && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t(
                'rules.smartOnlyHint',
                'Not active in the current mode — only Smart mode applies.'
              )}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
