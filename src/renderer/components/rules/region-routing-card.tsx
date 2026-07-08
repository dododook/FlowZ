import { useTranslation } from 'react-i18next';
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
    <div className="card rl-region">
      <div className="rl-region-h">
        <div className="field-lbl">{t('rules.regionRouting', 'Region routing')}</div>
        <button
          type="button"
          role="switch"
          aria-checked={region.enabled}
          aria-label={t('rules.regionRouting', 'Region routing')}
          className={`swt${region.enabled ? ' on' : ''}`}
          onClick={() => update({ enabled: !region.enabled })}
        />
      </div>

      {region.enabled && (
        <>
          <div className="cc-hair" />
          <div className="rl-region-body">
            <div className="field">
              <div className="field-lbl">
                {t('rules.region', 'Region')}{' '}
                <small>
                  {t(
                    'rules.regionRoutingDesc',
                    'Auto-route by region: local direct, overseas via proxy. Only in Smart mode.'
                  )}
                </small>
              </div>
              <div className="seg2">
                {REGIONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={region.region === r.id ? 'on' : ''}
                    onClick={() => update({ region: r.id })}
                  >
                    {t(r.key, r.fallback)}
                  </button>
                ))}
              </div>
            </div>

            <div className="rl-region-row">
              <div>
                <div className="rl-row-t">
                  {region.region === 'cn'
                    ? t('rules.regionReverseCn', 'Back to China')
                    : t('rules.regionReverse', 'Reverse (access local from abroad)')}
                </div>
                <div className="rl-row-d">
                  {t(
                    'rules.regionReverseDesc',
                    "Local via proxy, overseas direct — access the selected region's local content from abroad."
                  )}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={region.reverse}
                aria-label={
                  region.region === 'cn'
                    ? t('rules.regionReverseCn', 'Back to China')
                    : t('rules.regionReverse', 'Reverse (access local from abroad)')
                }
                className={`swt${region.reverse ? ' on' : ''}`}
                onClick={() => update({ reverse: !region.reverse })}
              />
            </div>
          </div>
        </>
      )}

      {!isSmart && (
        <div className="rl-smartonly">
          <span className="dot idle" />
          {t('rules.smartOnlyHint', 'Not active in the current mode — only Smart mode applies.')}
        </div>
      )}
    </div>
  );
}
