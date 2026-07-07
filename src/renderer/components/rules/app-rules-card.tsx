import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { NodePickerGroup, NodePickerItem } from '@/components/ui/node-picker';
import { APP_PRESETS } from '../../../shared/app-rules-preset';
import { groupServersBySubscription } from '../../../shared/server-grouping';
import { isSpeedTestable } from '../../../shared/endpoint-routes';
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
import { Plus, Search, LayoutGrid, List } from 'lucide-react';
import { availableResourceTagSet, missingResourceAppIds } from '../../../shared/rule-resource-refs';
import { toast } from 'sonner';

// 模块级缓存：记录图标加载失败的 preset ID。用模块级而非组件 state，确保组件重新挂载（主题切换/config 更新）时
// 不会重置，避免图标在「显示 img」→「加载失败」→「显示 emoji」之间反复闪变。
const _failedIconsCache = new Set<string>();

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
  const targetGroups: NodePickerGroup[] = useMemo(() => {
    const grps = groupServersBySubscription(servers, subscriptions);
    return grps.length > 1
      ? grps.map((g) => ({
          id: g.id,
          label: g.isMesh
            ? t('servers.meshNodes', '组网')
            : g.isManual
              ? t('servers.manualNodes', '自建节点')
              : g.name,
        }))
      : [];
  }, [servers, subscriptions, t]);
  const targetItems: NodePickerItem[] = useMemo(() => {
    const grps = groupServersBySubscription(servers, subscriptions);
    const multi = grps.length > 1;
    return grps.flatMap((g) =>
      g.servers.map<NodePickerItem>((s) => ({
        id: s.id,
        name: s.name,
        protocol: s.protocol,
        latency: latencyMap[s.id],
        latencyNA: !isSpeedTestable(s),
        groupId: multi ? g.id : undefined,
        dotTone: 'ok',
      }))
    );
  }, [servers, subscriptions, latencyMap]);

  if (!config) return null;

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
    <Card>
      <CardContent className="space-y-5 pt-6">
        {/* 顶部工具栏：搜索 + 策略计数 + 视图切换 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="group relative min-w-[12rem] flex-1">
            <Search className="absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50 transition-colors group-focus-within:text-primary" />
            <Input
              placeholder={t('rules.searchAppsFull', '搜索应用 / geosite / 进程名…')}
              value={appSearchQuery}
              onChange={(e) => setAppSearchQuery(e.target.value)}
              className="h-11 rounded-xl border-muted-foreground/10 bg-muted/40 ps-10 text-sm transition-all focus:border-primary/30"
            />
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            <span className="font-bold text-foreground">{counts.total}</span>
            <span>{t('rules.appCountUnit', '应用')}</span>
            <span className="opacity-40">·</span>
            <span className="text-primary">
              {t('rules.proxy')} {counts.proxy}
            </span>
            <span className="text-primary">
              {t('rules.appTile.nodeTitle', '指定')} {counts.node}
            </span>
            <span className="text-success">
              {t('rules.direct')} {counts.direct}
            </span>
            <span className="text-destructive">
              {t('rules.block')} {counts.block}
            </span>
          </div>

          <SegmentedControl<'comfortable' | 'compact'>
            className="w-auto shrink-0"
            value={viewMode}
            onChange={setViewMode}
            options={[
              {
                value: 'comfortable',
                label: <LayoutGrid className="h-4 w-4" />,
                title: t('rules.viewComfortable'),
              },
              {
                value: 'compact',
                label: <List className="h-4 w-4" />,
                title: t('rules.viewCompact'),
              },
            ]}
          />
        </div>

        {/* 分类分组（空组隐）：组内无卡则整组不渲染。 */}
        {groups.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('rules.searchNoMatch', '无匹配规则')}
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map((grp) => (
              <section key={grp.category} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">
                    {t(`rules.categories.${grp.category}` as any, grp.category)}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                    {grp.presets.length}
                  </span>
                  <span className="h-px flex-1 bg-muted-foreground/10" />
                </div>
                <div
                  className={
                    viewMode === 'comfortable'
                      ? 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'
                      : 'grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3'
                  }
                >
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
                        viewMode={viewMode}
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

        {/* 新增自定义应用 */}
        {!appSearchQuery && (
          <Button
            variant="outline"
            onClick={() => setIsAddDialogOpen(true)}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/10 bg-transparent transition-all hover:border-primary/30 hover:bg-muted/30"
          >
            <Plus className="h-5 w-5 text-muted-foreground/60" />
            <span className="text-sm font-medium text-muted-foreground/80">
              {t('rules.createCustom')}
            </span>
          </Button>
        )}
      </CardContent>

      <AddCustomAppDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        config={config}
        saveConfig={saveConfig}
        geoLocalList={geoLocalList}
        onGoToResources={goToResources}
      />
    </Card>
  );
}
