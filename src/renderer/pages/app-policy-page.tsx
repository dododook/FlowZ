import { AppRulesCard } from '@/components/rules/app-rules-card';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Beaker } from 'lucide-react';
import { useAppStore } from '@/store/app-store';

export function AppPolicyPage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  // 默认关（undefined=关闭，与后端 effectiveAppRules `!== true` 一致）；总开关切换走 config:save → 运行中全量重启
  const enabled = config?.appRoutingEnabled === true;
  // 应用分流仅「智能分流」模式生效（与后端 effectiveAppRules smart-only 一致）：global/direct 下即便开关开也不生效。
  const isSmartMode = (config?.proxyMode || 'smart').toLowerCase() === 'smart';

  const toggle = (v: boolean) => {
    if (!config) return;
    void saveConfig({ ...config, appRoutingEnabled: v });
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold">{t('rules.appRulesTitle')}</h2>
          <Badge
            variant="outline"
            className="text-xs gap-1 text-amber-500 border-amber-500/40 bg-amber-500/10 h-fit"
          >
            <Beaker className="h-3 w-3" />
            {t('rules.appRulesExperimental')}
          </Badge>
          <Switch
            className="ms-auto"
            checked={enabled}
            onCheckedChange={toggle}
            disabled={!config}
            aria-label={t('rules.appRoutingToggle', '启用应用分流')}
          />
        </div>
        <p className="text-muted-foreground mt-1">{t('rules.appRulesDesc')}</p>
        {!enabled ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {t(
              'rules.appRoutingDisabledHint',
              '应用分流已关闭：所有应用按当前分流策略走，下方规则不生效。'
            )}
          </p>
        ) : (
          !isSmartMode && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('rules.smartOnlyHint', '当前模式下不生效，仅「智能分流」模式生效。')}
            </p>
          )
        )}
      </div>

      {/* inert（React 19 原生）：关闭态同时阻断指针+键盘+辅助技术，避免「只读」却仍可 Tab 改规则触发零变更重启 */}
      <div className={enabled ? undefined : 'opacity-50'} inert={!enabled}>
        <AppRulesCard />
      </div>
    </div>
  );
}
