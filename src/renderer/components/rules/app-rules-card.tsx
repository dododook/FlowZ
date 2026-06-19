import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
import { APP_PRESETS, type AppPreset } from '../../../shared/app-rules-preset';
import type {
  AppRule,
  RuleAction,
  CustomAppPreset,
  RuleResourceListItem,
} from '../../../shared/types';
import { api } from '@/ipc/api-client';
import { AddCustomAppDialog } from './add-custom-app-dialog';
import { Plus, Trash2, Search, LayoutGrid, List, ChevronDown, AlertTriangle } from 'lucide-react';
import { availableResourceTagSet, missingResourceAppIds } from '../../../shared/rule-resource-refs';
import { toast } from 'sonner';
import { useEffect } from 'react';

// 模块级缓存：记录图标加载失败的 preset ID
// 使用模块级而非组件 state，确保组件重新挂载（主题切换/config 更新）时不会重置，
// 避免图标在「显示 img」→「加载失败」→「显示 emoji」之间反复闪变。
const _failedIconsCache = new Set<string>();

export function AppRulesCard() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);

  // -- 新增自定义应用状态 --
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  // 规则资源已下载/内置列表：标注「本地/未下载」+ 添加时判断哪些 geo 需下载进规则资源（联动）
  const [geoLocalList, setGeoLocalList] = useState<RuleResourceListItem[]>([]);

  const [appSearchQuery, setAppSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    () => (localStorage.getItem('flowz_app_view_mode') as 'comfortable' | 'compact') || 'compact'
  );

  // 使用模块级缓存（_failedIconsCache）+ React state 联动：
  // state 用于触发重渲染，cache 用于跨挂载持久化，两者保持同步。
  const [failedIcons, setFailedIcons] = useState<Set<string>>(() => new Set(_failedIconsCache));

  const handleIconError = (presetId: string) => {
    if (_failedIconsCache.has(presetId)) return; // 已记录过，无需重复 setState
    _failedIconsCache.add(presetId);
    setFailedIcons(new Set(_failedIconsCache));
  };

  useEffect(() => {
    localStorage.setItem('flowz_app_view_mode', viewMode);
  }, [viewMode]);

  // 「已下载/内置」列表：挂载即拉（卡片「规则集缺失」角标需要），打开对话框时刷新（反映新下载），随 config 变化重拉
  // （别处删除/恢复资源会改 config）。用于本地标注、添加时按需下载、以及应用卡片缺失角标。
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

  // 本地可用规则资源 tag 集合（fileExists 为真者）：用于卡片「规则集缺失」角标判定。
  const availableResTags = useMemo(() => availableResourceTagSet(geoLocalList), [geoLocalList]);

  if (!config) return null;

  const appRules: AppRule[] = config.appRules || [];
  const customPresets: CustomAppPreset[] = config.customAppPresets || [];
  // 引用了缺失 geo（已删除/文件丢失）的应用 id 集合：geo 半暂不生效（进程名仍生效），卡片角标提示去「规则资源」页恢复。
  // 仅「智能分流」模式标注——非 smart 下应用分流本就被模式忽略（由 app-policy 页顶部提示说明），再标缺失会误导。
  const isSmartMode = (config.proxyMode || 'smart').toLowerCase() === 'smart';
  const affectedAppIds = isSmartMode
    ? missingResourceAppIds(appRules, availableResTags, customPresets)
    : new Set<string>();

  // 合并预设列表进行渲染
  const allPresets: AppPreset[] = [
    ...APP_PRESETS,
    ...customPresets.map((p) => ({
      id: p.id,
      labelKey: p.name,
      emoji: p.emoji,
      iconUrl: p.iconUrl,
      geositeTags: p.geositeTags,
      geoipTags: p.geoipTags,
      category: 'tools' as const,
      isCustom: true,
    })),
  ];

  // -- 过滤后的预设列表 --
  const filteredPresets = allPresets.filter((p) => {
    if (!appSearchQuery.trim()) return true;
    const label = (p as any).isCustom ? p.labelKey : t(`rules.apps.${p.labelKey}` as any);
    return label.toLowerCase().includes(appSearchQuery.toLowerCase());
  });

  const getAppRule = (appId: string): AppRule | undefined =>
    appRules.find((r) => r.appId === appId);

  const handlePolicyChange = async (preset: AppPreset, value: string) => {
    const existing = getAppRule(preset.id);

    // 「代理(默认)」= 跟全局：保留 appRule、清 targetServerId（action='proxy' 无 target）→ rule-sel-app
    //   default=proxy-selector（嵌套跟全局）→ 「节点↔默认」= rule-sel-app default 变（PUT 热切换 0 断流），
    //   与 customRules 节点↔默认语义一致（非删 appRule 致结构变重启）。无记录则 no-op。
    if (value === 'proxy-default') {
      if (!existing) return;
      try {
        await saveConfig({
          ...config,
          appRules: appRules.map((r) =>
            r.appId === preset.id
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
    else if (value.startsWith('node-')) {
      targetServerId = value.replace('node-', '');
    }

    const newRules: AppRule[] = existing
      ? appRules.map((r) =>
          r.appId === preset.id ? { ...r, action, targetServerId, enabled: true } : r
        )
      : [...appRules, { appId: preset.id, action, targetServerId, enabled: true }];

    try {
      await saveConfig({ ...config, appRules: newRules });
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  const handleDeleteCustomApp = async (appId: string) => {
    const newPresets = customPresets.filter((p) => p.id !== appId);
    const newRules = appRules.filter((r) => r.appId !== appId);
    try {
      await saveConfig({
        ...config,
        customAppPresets: newPresets,
        appRules: newRules,
      });
    } catch {
      toast.error(t('common.saveFailed'));
      return;
    }
    toast.success(t('rules.customApp.deleted'));
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-6">
        {/* 顶部搜索框：补齐视觉突兀感 */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 group">
            <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 transition-colors group-focus-within:text-primary" />
            <Input
              placeholder={t('rules.searchApps')}
              value={appSearchQuery}
              onChange={(e) => setAppSearchQuery(e.target.value)}
              className="ps-10 h-11 bg-muted/40 border-muted-foreground/10 focus:border-primary/30 transition-all rounded-xl text-sm"
            />
          </div>

          <div className="flex items-center bg-muted/30 p-1 rounded-xl border border-muted-foreground/5">
            <Button
              variant={viewMode === 'comfortable' ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 rounded-lg ${viewMode === 'comfortable' ? 'shadow-sm' : ''}`}
              onClick={() => setViewMode('comfortable')}
              title={t('rules.viewComfortable')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'compact' ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 rounded-lg ${viewMode === 'compact' ? 'shadow-sm' : ''}`}
              onClick={() => setViewMode('compact')}
              title={t('rules.viewCompact')}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div
          className={
            viewMode === 'comfortable'
              ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4'
              : 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3'
          }
        >
          {filteredPresets.map((preset) => {
            const rule = getAppRule(preset.id);
            const isEnabled = rule?.enabled ?? false;
            const isCustom = preset.id.startsWith('custom-');

            return (
              <div key={preset.id} className="group relative">
                <Select
                  value={(() => {
                    if (!rule || !isEnabled) return 'proxy-default';
                    if (rule.action === 'direct') return 'direct';
                    if (rule.action === 'block') return 'block';
                    return rule.targetServerId ? `node-${rule.targetServerId}` : 'proxy-default';
                  })()}
                  onValueChange={(v) => handlePolicyChange(preset, v)}
                >
                  <SelectTrigger
                    className={`${viewMode === 'comfortable' ? 'h-[110px] p-3.5' : 'h-[88px] p-2.5'} w-full flex flex-col items-start rounded-xl border border-muted-foreground/10 transition-all duration-300 shadow-none focus:ring-0 [&>svg]:hidden bg-muted/40 hover:bg-muted/60 relative overflow-hidden`}
                  >
                    {/* 可点击 affordance：span 包裹避开 [&>svg]:hidden；pointer-events-none 不挡点击；hover 提亮 */}
                    <span className="pointer-events-none absolute end-2 top-2 text-muted-foreground/40 transition-colors group-hover:text-primary">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </span>
                    {/* 左上脚标：策略选择器入口提示。提升可见度（10px/80% 半粗）+ hover 提亮，与右上 chevron 联动暗示可点击 */}
                    <div
                      className={`text-[10px] text-muted-foreground/80 font-semibold tracking-tight leading-none mt-0.5 mb-1 transition-colors group-hover:text-primary ${viewMode === 'comfortable' ? 'ms-1.5' : 'ms-2.5'}`}
                    >
                      {t('rules.appRulesManualSelection')}
                    </div>

                    <div
                      className={
                        viewMode === 'comfortable'
                          ? 'flex items-center gap-2.5 w-full flex-1 ms-1.5'
                          : 'flex items-center gap-2 w-full mt-0.5 ms-2.5'
                      }
                    >
                      <div
                        className={`${viewMode === 'comfortable' ? 'h-9 w-9 border-white/10 p-1' : 'h-6 w-6 border-white/5 p-0.5'} flex items-center justify-center bg-background/80 rounded-lg shadow-sm border shrink-0 transition-transform group-hover:scale-105`}
                      >
                        {/* Bug 3 修复：基于 React state 条件渲染，避免 onError DOM 操作被重渲染覆盖 */}
                        {preset.iconUrl && !failedIcons.has(preset.id) ? (
                          <img
                            src={preset.iconUrl}
                            alt=""
                            className="h-full w-full object-contain"
                            loading="lazy"
                            onError={() => handleIconError(preset.id)}
                          />
                        ) : (
                          <span className={viewMode === 'comfortable' ? 'text-xl' : 'text-xs'}>
                            {preset.emoji}
                          </span>
                        )}
                      </div>
                      <span
                        className={`${viewMode === 'comfortable' ? 'text-[13px]' : 'text-[12px]'} font-bold truncate tracking-tight transition-colors ${
                          isEnabled ? 'text-foreground' : 'text-foreground/70'
                        }`}
                      >
                        {isCustom ? preset.labelKey : t(`rules.apps.${preset.labelKey}` as any)}
                      </span>
                    </div>

                    {viewMode === 'comfortable' && (
                      <div className="h-4 w-full flex-none opacity-0 pointer-events-none" />
                    )}

                    <div
                      className={
                        viewMode === 'comfortable'
                          ? `absolute bottom-1.5 start-2.5 end-3.5 text-[9.5px] w-full text-start font-bold tracking-normal truncate ${
                              !rule || !isEnabled
                                ? 'text-primary'
                                : rule.action === 'direct'
                                  ? 'text-success'
                                  : rule.action === 'block'
                                    ? 'text-destructive'
                                    : 'text-primary'
                            }`
                          : `text-[9px] w-full text-start font-bold tracking-normal truncate ms-2 ${
                              !rule || !isEnabled
                                ? 'text-primary'
                                : rule.action === 'direct'
                                  ? 'text-success'
                                  : rule.action === 'block'
                                    ? 'text-destructive'
                                    : 'text-primary'
                            }`
                      }
                    >
                      <div className="flex items-center gap-1">
                        <div
                          className={`${viewMode === 'comfortable' ? 'h-1.5 w-1.5' : 'h-1 w-1'} rounded-full ${
                            !rule || !isEnabled
                              ? 'bg-primary'
                              : rule.action === 'direct'
                                ? 'bg-success'
                                : rule.action === 'block'
                                  ? 'bg-destructive'
                                  : 'bg-primary'
                          }`}
                        />
                        <span className="truncate">
                          {(() => {
                            if (!rule || !isEnabled) return t('rules.proxy');
                            if (rule.action === 'direct') return t('rules.direct');
                            if (rule.action === 'block') return t('rules.block');
                            if (rule.targetServerId) {
                              const s = config.servers?.find(
                                (server) => server.id === rule.targetServerId
                              );
                              return s ? s.name : t('rules.proxy');
                            }
                            return t('rules.proxy');
                          })()}
                        </span>
                      </div>
                    </div>
                  </SelectTrigger>

                  <SelectContent className="max-h-[300px]">
                    <div className="px-2 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wide">
                      {t('rules.systemPolicy')}
                    </div>
                    <SelectItem value="proxy-default" className="text-xs font-medium text-primary">
                      {t('rules.proxy')}
                    </SelectItem>
                    <SelectItem value="direct" className="text-xs text-success">
                      {t('rules.direct')}
                    </SelectItem>
                    <SelectItem value="block" className="text-xs text-destructive">
                      {t('rules.block')}
                    </SelectItem>

                    {config.servers && config.servers.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 mt-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wide border-t">
                          {t('rules.standaloneNodes')}
                        </div>
                        <ServerSelectGroups
                          servers={config.servers}
                          valuePrefix="node-"
                          itemClassName="text-xs"
                          selectedId={rule?.targetServerId}
                        />
                      </>
                    )}
                  </SelectContent>
                </Select>

                {/* 规则集缺失角标：该应用引用的 geo 已删除/文件丢失 → geo 半暂不生效（进程名仍生效），需到「规则资源」页恢复。 */}
                {affectedAppIds.has(preset.id) && (
                  <span
                    className="absolute -top-1 -start-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm"
                    title={t(
                      'rules.appGeoMissingTip',
                      '该应用引用的分流规则集缺失（已删除或文件丢失），仅按进程名生效；请到「规则资源」页下载恢复'
                    )}
                  >
                    <AlertTriangle className="h-3 w-3" />
                  </span>
                )}

                {isCustom && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteCustomApp(preset.id);
                    }}
                    className="absolute -top-1 -end-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm z-10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}

          {/* 新增按钮：始终在最后 */}
          {!appSearchQuery && (
            <div className="group relative">
              <Button
                variant="outline"
                onClick={() => setIsAddDialogOpen(true)}
                className={`${viewMode === 'comfortable' ? 'h-[110px]' : 'h-[88px]'} w-full flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/10 bg-transparent hover:bg-muted/30 hover:border-primary/30 transition-all duration-300 shadow-none`}
              >
                <div className="h-9 w-9 flex items-center justify-center bg-muted/40 rounded-full group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                  <Plus className="h-6 w-6 text-muted-foreground/60 group-hover:text-primary" />
                </div>
                <span className="text-xs font-medium text-muted-foreground/70 group-hover:text-primary transition-colors">
                  {t('rules.createCustom')}
                </span>
              </Button>
            </div>
          )}
        </div>
      </CardContent>

      <AddCustomAppDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        config={config}
        saveConfig={saveConfig}
        geoLocalList={geoLocalList}
      />
    </Card>
  );
}
