import { AppRulesCard } from '@/components/rules/app-rules-card';
import { useTranslation } from 'react-i18next';
import { Info, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

/**
 * 应用分流页（Conduit `data-page="apppolicy"`）：页头（标题 + 实验性 pill + 总开关 `.ap-master`）
 * + 提示条（smart-only 信息 / inert 关闭 / 非 smart 模式警示）+ `<AppRulesCard>`（工具条 + 分组卡网格 + 新增对话框）。
 *
 * 总开关的「置灰 / 提示切换」由 conduit 反应式 CSS 驱动：页根 `data-page="apppolicy"`、总开关挂 `.ap-master`(+`on`)，
 * `:has(.ap-master:not(.on))` 命中时 CSS 隐 `.ap-hint.smart`、显 `.ap-hint.inert`、并 dim `.ap-body`。
 * 另在 `.ap-body` 加 React 19 原生 `inert`（AppRulesCard 内）阻断指针+键盘+辅助技术，避免关闭态仍可 Tab 改规则触发零变更重启。
 */
export function AppPolicyPage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  // 默认关（undefined=关闭，与后端 effectiveAppRules `!== true` 一致）；总开关切换走 config:save → 运行中全量重启。
  const enabled = config?.appRoutingEnabled === true;
  // 应用分流仅「智能分流」模式生效（与后端 effectiveAppRules smart-only 一致）：global/direct 下即便开关开也不生效。
  const isSmartMode = (config?.proxyMode || 'smart').toLowerCase() === 'smart';

  const toggle = (v: boolean) => {
    if (!config) return;
    void saveConfig({ ...config, appRoutingEnabled: v });
  };

  return (
    <section className="flex flex-col gap-4" data-page="apppolicy">
      <div className="page-h">
        <h1>{t('rules.appRulesTitle')}</h1>
        <span className="pill exp">🧪 {t('rules.appRulesExperimental')}</span>
        <div className="ap-mh">
          <span className="lbl">{t('rules.appRoutingToggle', '启用应用分流')}</span>
          {/* 总开关：conduit `.swt`（+`on`）+ `.ap-master`（反应式 CSS 锚点）。切换需重启内核。 */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('rules.appRoutingToggle', '启用应用分流')}
            title={t('rules.appRoutingToggle', '启用应用分流')}
            disabled={!config}
            onClick={() => toggle(!enabled)}
            className={cn(
              'swt ap-master',
              enabled && 'on',
              !config && 'cursor-not-allowed opacity-50'
            )}
          />
        </div>
      </div>

      {/* smart-only 信息条（总开关开时显；CSS `:has(.ap-master:not(.on))` 关时隐）。 */}
      <div className="ap-hint smart">
        <Info />
        <span>{t('rules.appRulesDesc')}</span>
      </div>

      {/* inert 关闭提示（总开关关时经 CSS 显）。「重新启用」按钮已移除——右上角 master 开关即可开回（用户反馈：勿重复）。 */}
      <div className="ap-hint inert">
        <AlertTriangle />
        <span>{t('rules.appRoutingDisabledHint')}</span>
      </div>

      {/* 非 smart 模式警示（开关开但当前模式忽略应用分流）：prototype 无此态元素，React 条件渲染 + 内联 warn 观感。 */}
      {enabled && !isSmartMode && (
        <div
          className="ap-hint"
          style={{
            background: 'hsl(var(--warn-weak))',
            color: 'hsl(var(--warn))',
            border: '1px solid hsl(var(--warn) / 0.3)',
          }}
        >
          <AlertTriangle />
          <span>{t('rules.smartOnlyHint')}</span>
        </div>
      )}

      <AppRulesCard />
    </section>
  );
}
