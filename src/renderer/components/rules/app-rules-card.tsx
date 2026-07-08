import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';
import { buildServerPickerModel } from '@/components/ui/server-picker-items';
import { FOLLOW_GLOBAL_NODE_ID } from './rule-dialog-logic';
import { APP_PRESETS } from '../../../shared/app-rules-preset';
import type {
  AppRule,
  RuleAction,
  CustomAppPreset,
  RuleResourceListItem,
} from '../../../shared/types';
import { api } from '@/ipc/api-client';
import { AddCustomAppDialog } from './add-custom-app-dialog';
import { AppCard } from './app-card';
import {
  countAppPolicies,
  deriveAppPolicy,
  groupPresetsByCategory,
  matchesAppSearch,
  type DisplayAppPreset,
} from './app-rules-logic';
import { Search, LayoutGrid, List } from 'lucide-react';
import { availableResourceTagSet, missingResourceAppIds } from '../../../shared/rule-resource-refs';
import { toast } from 'sonner';

// 模块级缓存：记录图标加载失败的 preset ID。用模块级而非组件 state，确保组件重新挂载（主题切换/config 更新）时
// 不会重置，避免图标在「显示 img」→「加载失败」→「显示 emoji」之间反复闪变。
const _failedIconsCache = new Set<string>();

/**
 * 应用分流主体（Conduit `.ap-toolbar` + `.ap-body`）：搜索 + 策略计数摘要 + 双视图切换（舒适/紧凑，紧凑由
 * `:has(.ap-viewseg button[data-view="compact"].on)` CSS 反应式排版）+ 按分类分组的应用卡网格 + 新增自定义应用虚线卡。
 * 无 `<Card>` 包裹（prototype 直挂页根）。`.ap-body` 在总开关关时经 CSS dim + 本组件加 React 原生 `inert` 阻断交互。
 */
export function AppRulesCard() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const subscriptions = useAppStore((state) => state.config?.subscriptions || []);
  const latencyMap = useAppStore((state) => state.latencyMap);

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  // 规则资源已下载/内置列表：标注「本地/未下载」+ 添加时判断哪些 geo 需下载进规则资源（联动）
  const [geoLocalList, setGeoLocalList] = useState<RuleResourceListItem[]>([]);

  const [appSearchQuery, setAppSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all'); // 分类筛选（用户反馈）：'all' 或某 category
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    () => (localStorage.getItem('flowz_app_view_mode') as 'comfortable' | 'compact') || 'compact'
  );

  // 模块级缓存（_failedIconsCache）+ state 联动：state 触发重渲染，cache 跨挂载持久，两者同步。
  const [failedIcons, setFailedIcons] = useState<Set<string>>(() => new Set(_failedIconsCache));
  const handleIconError = (presetId: string) => {
    if (_failedIconsCache.has(presetId)) return;
    _failedIconsCache.add(presetId);
    setFailedIcons(new Set(_failedIconsCache));
  };

  useEffect(() => {
    localStorage.setItem('flowz_app_view_mode', viewMode);
  }, [viewMode]);

  // 「已下载/内置」列表：挂载即拉（卡片「规则集缺失」角标需要），打开对话框时刷新（反映新下载），随 config 变化重拉。
  useEffect(() => {
    let active = true;
    api.ruleResources
      .list()
      .then((list) => {
        if (active) setGeoLocalList(list);
      })
      .catch(() => {
        if (active) setGeoLocalList([]);
      });
    return () => {
      active = false;
    };
  }, [isAddDialogOpen, config]);

  const availableResTags = useMemo(() => availableResourceTagSet(geoLocalList), [geoLocalList]);

  // 指定节点 `.npick` 数据（按订阅/自建分组 + 延迟徽标）。应用分流「指定节点」= 具体节点，故不含「跟随全局」哨兵
  // （跟随全局由「代理」瓦片承担）。父级算一次，各卡共用（value 由各卡自身 targetServerId 决定）。
  const servers = config?.servers || [];
  // 对齐路由规则：跟随全局哨兵置顶（= proxy-default）+ 具体节点（= node-<id>），由「代理」瓦片下方 picker 统一承接。
  // 共享映射与首页/规则/detour 口径统一。
  const { items: targetItems, groups: targetGroups } = useMemo(
    () =>
      buildServerPickerModel({
        servers,
        subscriptions,
        latencyMap,
        meshLabel: t('servers.meshNodes', '组网'),
        manualLabel: t('servers.manualNodes', '自建节点'),
        sentinel: { id: FOLLOW_GLOBAL_NODE_ID, name: t('rules.defaultNodeTip'), role: 'follow' },
      }),
    [servers, subscriptions, latencyMap, t]
  );

  if (!config) return null;

  const enabled = config.appRoutingEnabled === true;
  const appRules: AppRule[] = config.appRules || [];
  const customPresets: CustomAppPreset[] = config.customAppPresets || [];
  const isSmartMode = (config.proxyMode || 'smart').toLowerCase() === 'smart';
  // 引用了缺失 geo 的应用 id：geo 半暂不生效（进程名仍生效）；仅 smart 模式标注（非 smart 应用分流本被忽略）。
  const affectedAppIds = isSmartMode
    ? missingResourceAppIds(appRules, availableResTags, customPresets)
    : new Set<string>();

  // 归一展示预设（内置 + 自定义）：category 放宽为 string 以容纳自定义分类；自定义带 processNames/isCustom。
  const allPresets: DisplayAppPreset[] = [
    ...APP_PRESETS.map((p) => ({ ...p, category: p.category as string })),
    ...customPresets.map<DisplayAppPreset>((p) => ({
      id: p.id,
      labelKey: p.name,
      emoji: p.emoji,
      iconUrl: p.iconUrl,
      geositeTags: p.geositeTags,
      geoipTags: p.geoipTags,
      processNames: p.processNames,
      category: p.category || 'tools',
      isCustom: true,
    })),
  ];

  const getAppRule = (appId: string): AppRule | undefined =>
    appRules.find((r) => r.appId === appId);
  const labelOf = (p: DisplayAppPreset): string =>
    p.isCustom ? p.labelKey : t(`rules.apps.${p.labelKey}` as any);

  // 策略计数（over 全部预设，独立于搜索）：顶部摘要。O(预设数) 廉价，直接算（早退后不可用 hook）。
  const counts = countAppPolicies(
    allPresets.map((p) => p.id),
    getAppRule
  );

  // 搜索过滤（应用名 / geosite / geoip / 进程名）→ 按分类分组（空组隐）。
  const filteredPresets = allPresets.filter((p) => matchesAppSearch(p, labelOf(p), appSearchQuery));
  const groups = groupPresetsByCategory(filteredPresets);
  // 分类筛选：chip 列表取全量分类（不随搜索消失，顺序稳定）；选中某类只显该组。
  // 纯计算（非 useMemo）：早退 `if (!config) return null` 之后加 hook 会违反 Rules-of-Hooks（config null→载入时
  // hook 数变化崩溃）；且 allPresets 每渲染是新数组、memo 依赖恒变本就失效。groupPresetsByCategory 廉价，直接算。
  const allCategories = groupPresetsByCategory(allPresets).map((g) => g.category);
  // 生效分类：categoryFilter 指向的类若已不在（删完该类最后一个自定义应用 / 越界）→ 回落 'all'，
  // 避免死角（chip 消失却仍按它过滤 → 永久空 body 无高亮 chip）。
  const effectiveCategory =
    categoryFilter !== 'all' && allCategories.includes(categoryFilter) ? categoryFilter : 'all';
  const shownGroups =
    effectiveCategory === 'all' ? groups : groups.filter((g) => g.category === effectiveCategory);

  const handlePolicyChange = async (presetId: string, value: string) => {
    const existing = getAppRule(presetId);

    // 「代理(跟全局)」= 保留 appRule、清 targetServerId（action='proxy' 无 target）→ rule-sel-app default 变
    // （PUT 热切换 0 断流）。无记录则 no-op。
    if (value === 'proxy-default') {
      if (!existing) return;
      try {
        await saveConfig({
          ...config,
          appRules: appRules.map((r) =>
            r.appId === presetId
              ? { ...r, action: 'proxy', targetServerId: undefined, enabled: true }
              : r
          ),
        });
      } catch {
        toast.error(t('common.saveFailed'));
      }
      return;
    }

    let action: RuleAction = 'proxy';
    let targetServerId: string | undefined = undefined;
    if (value === 'direct') action = 'direct';
    else if (value === 'block') action = 'block';
    else if (value.startsWith('node-')) targetServerId = value.replace('node-', '');

    const newRules: AppRule[] = existing
      ? appRules.map((r) =>
          r.appId === presetId ? { ...r, action, targetServerId, enabled: true } : r
        )
      : [...appRules, { appId: presetId, action, targetServerId, enabled: true }];

    try {
      await saveConfig({ ...config, appRules: newRules });
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  const handleDeleteCustomApp = async (appId: string) => {
    try {
      await saveConfig({
        ...config,
        customAppPresets: customPresets.filter((p) => p.id !== appId),
        appRules: appRules.filter((r) => r.appId !== appId),
      });
    } catch {
      toast.error(t('common.saveFailed'));
      return;
    }
    toast.success(t('rules.customApp.deleted'));
  };

  const goToResources = () => setCurrentView('ruleResources');

  return (
    <>
      {/* 工具条：搜索 + 策略计数摘要 + 双视图切换 */}
      <div className="ap-toolbar">
        <label className="ap-search">
          <Search />
          <input
            type="text"
            placeholder={t('rules.searchAppsFull', '搜索应用 / geosite / 进程名…')}
            value={appSearchQuery}
            onChange={(e) => setAppSearchQuery(e.target.value)}
          />
        </label>

        <div className="ap-summary mono">
          <b>{counts.total}</b> {t('rules.appCountUnit', '应用')}
          {' · '}
          <span className="s-proxy">
            {t('rules.proxy')} {counts.proxy}
          </span>
          {' · '}
          <span className="s-proxy">
            {t('rules.appTile.nodeTitle', '指定')} {counts.node}
          </span>
          {' · '}
          <span className="s-direct">
            {t('rules.direct')} {counts.direct}
          </span>
          {' · '}
          <span className="s-block">
            {t('rules.block')} {counts.block}
          </span>
        </div>

        <div
          className="seg2 ap-viewseg"
          role="group"
          aria-label={t('rules.viewDensity', '视图密度')}
        >
          <button
            type="button"
            data-view="comfort"
            className={cn(viewMode === 'comfortable' && 'on')}
            title={t('rules.viewComfortable')}
            aria-label={t('rules.viewComfortable')}
            aria-pressed={viewMode === 'comfortable'}
            onClick={() => setViewMode('comfortable')}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-view="compact"
            className={cn(viewMode === 'compact' && 'on')}
            title={t('rules.viewCompact')}
            aria-label={t('rules.viewCompact')}
            aria-pressed={viewMode === 'compact'}
            onClick={() => setViewMode('compact')}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 分类筛选 chips（用户反馈）：全部 + 各分类，选中只显该组。≥2 分类才显。 */}
      {allCategories.length > 1 && (
        <div
          className="ap-catfilter"
          role="group"
          aria-label={t('rules.categoryFilter', '分类筛选')}
        >
          <button
            type="button"
            className={cn('ap-cat-chip', effectiveCategory === 'all' && 'on')}
            onClick={() => setCategoryFilter('all')}
          >
            {t('common.all', '全部')}
          </button>
          {allCategories.map((c) => (
            <button
              key={c}
              type="button"
              className={cn('ap-cat-chip', effectiveCategory === c && 'on')}
              onClick={() => setCategoryFilter(c)}
            >
              {t(`rules.categories.${c}` as any, c)}
            </button>
          ))}
        </div>
      )}

      {/* 应用卡网格（总开关关时经 CSS dim + React `inert` 阻断交互）。空组由 CSS `.ap-group:not(:has(.app-card))` 隐。 */}
      <div className="ap-body" inert={!enabled}>
        {shownGroups.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-fg-faint">
            {t('rules.searchNoMatch', '无匹配规则')}
          </div>
        ) : (
          <div className="ap-groups">
            {shownGroups.map((grp) => (
              <section key={grp.category} className="ap-group">
                <div className="ap-cat">
                  <span className="nm">
                    {t(`rules.categories.${grp.category}` as any, grp.category)}
                  </span>
                  <span className="n mono">{grp.presets.length}</span>
                </div>
                <div className="ap-cards">
                  {grp.presets.map((preset) => {
                    const rule = getAppRule(preset.id);
                    const kind = deriveAppPolicy(rule);
                    const nodeLabel =
                      kind === 'node'
                        ? servers.find((s) => s.id === rule?.targetServerId)?.name
                        : undefined;
                    return (
                      <AppCard
                        key={preset.id}
                        preset={preset}
                        rule={rule}
                        policyKind={kind}
                        missing={affectedAppIds.has(preset.id)}
                        label={labelOf(preset)}
                        subText={t(`rules.categories.${grp.category}` as any, grp.category)}
                        nodeLabel={nodeLabel}
                        targetItems={targetItems}
                        targetGroups={targetGroups}
                        iconFailed={failedIcons.has(preset.id)}
                        onIconError={() => handleIconError(preset.id)}
                        onPolicyChange={(v) => handlePolicyChange(preset.id, v)}
                        onDelete={
                          preset.isCustom ? () => handleDeleteCustomApp(preset.id) : undefined
                        }
                        onGoToResources={goToResources}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* 新增自定义应用虚线卡（搜索时隐）。 */}
        {!appSearchQuery && (
          <div className="ap-add-zone">
            <button type="button" className="add-card" onClick={() => setIsAddDialogOpen(true)}>
              <span className="ic">＋</span>
              <span className="add-tx">
                <span className="t">{t('rules.createCustom')}</span>
                <small>{t('rules.customApp.addDesc')}</small>
              </span>
            </button>
          </div>
        )}
      </div>

      <AddCustomAppDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        config={config}
        saveConfig={saveConfig}
        geoLocalList={geoLocalList}
        onGoToResources={goToResources}
      />
    </>
  );
}
