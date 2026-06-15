import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { APP_PRESETS, type AppPreset } from '../../../shared/app-rules-preset';
import type {
  AppRule,
  RuleAction,
  CustomAppPreset,
  RuleResourceCatalogItem,
  RuleResourceListItem,
} from '../../../shared/types';
import { api } from '@/ipc/api-client';
import { GeoTagPicker } from './geo-tag-picker';
import { geoCategoryOptions, localGeoTagSet } from './geo-tag-picker-utils';
import {
  Plus,
  Trash2,
  Search,
  LayoutGrid,
  List,
  Image as ImageIcon,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react';
import { availableResourceTagSet, missingResourceAppIds } from '../../../shared/rule-resource-refs';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  const [newAppName, setNewAppName] = useState('');
  const [newAppEmoji, setNewAppEmoji] = useState('🌐');
  const [newAppIconUrl, setNewAppIconUrl] = useState('');
  const [newAppGeositeTags, setNewAppGeositeTags] = useState<string[]>([]);
  const [newAppGeoipTags, setNewAppGeoipTags] = useState<string[]>([]);
  // geo 分类 catalog（geosite/geoip 多选选择器数据源）：内置/缓存即时，全量需刷新
  const [geoCatalog, setGeoCatalog] = useState<RuleResourceCatalogItem[]>([]);
  const [geoCatalogLoading, setGeoCatalogLoading] = useState(false);
  const [geoCatalogRefreshing, setGeoCatalogRefreshing] = useState(false);
  // 规则资源已下载/内置列表：标注「本地/未下载」+ 添加时判断哪些 geo 需下载进规则资源（联动）
  const [geoLocalList, setGeoLocalList] = useState<RuleResourceListItem[]>([]);

  // -- 图标库状态 --
  const [iconGalleries, setIconGalleries] = useState<{ name: string; url: string }[]>([]);
  const [isLoadingIcons, setIsLoadingIcons] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [appSearchQuery, setAppSearchQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showIconGallery, setShowIconGallery] = useState(false);
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

  // 打开新增对话框时拉 geo 分类 catalog（getCatalog 走内置/磁盘缓存，无网络）；只拉一次，全量由刷新按钮拉
  useEffect(() => {
    if (!isAddDialogOpen || geoCatalog.length > 0) return;
    setGeoCatalogLoading(true);
    api.ruleResources
      .getCatalog()
      .then((r) => setGeoCatalog(r.items || []))
      .catch(() => setGeoCatalog([]))
      .finally(() => setGeoCatalogLoading(false));
  }, [isAddDialogOpen, geoCatalog.length]);

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

  useEffect(() => {
    if (!showIconGallery || iconGalleries.length > 0) return;

    const fetchIcons = async () => {
      setIsLoadingIcons(true);
      try {
        // 按优先级依次尝试多个 CDN 源（国内网络对 jsdelivr/github 访问不稳定）
        const fetchWithFallback = async (urls: string[]) => {
          for (const url of urls) {
            try {
              const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
              if (res.ok) return await res.json();
            } catch {
              console.warn(`Failed to fetch from ${url}, trying next...`);
            }
          }
          return null; // 所有源均失败时返回 null，不抛异常
        };

        const [qureData, edcData] = await Promise.all([
          fetchWithFallback([
            'https://cdn.jsdelivr.net/gh/Koolson/Qure/Other/QureColor-All.json',
            'https://fastly.jsdelivr.net/gh/Koolson/Qure/Other/QureColor-All.json',
            'https://raw.githubusercontent.com/Koolson/Qure/master/Other/QureColor-All.json',
          ]),
          fetchWithFallback([
            'https://cdn.jsdelivr.net/gh/erdongchanyo/icon@main/edc-filter-icon-gallery.json',
            'https://fastly.jsdelivr.net/gh/erdongchanyo/icon@main/edc-filter-icon-gallery.json',
            'https://raw.githubusercontent.com/erdongchanyo/icon/main/edc-filter-icon-gallery.json',
          ]),
        ]);

        const allIcons = [...(qureData?.icons || []), ...(edcData?.icons || [])];
        // 无论是否拿到数据都正常结束，失败时 allIcons 为空数组，UI 会显示手动输入兜底
        setIconGalleries(allIcons);
      } catch (e) {
        console.error('Failed to fetch icon galleries:', e);
        setIconGalleries([]); // 保证 isLoading 能结束，并显示兜底 UI
      } finally {
        setIsLoadingIcons(false);
      }
    };
    fetchIcons();
  }, [showIconGallery, iconGalleries.length, retryTick]);

  const filteredIcons = searchQuery
    ? iconGalleries.filter((i) => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : iconGalleries.slice(0, 100);

  const geositeOptions = useMemo(() => geoCategoryOptions(geoCatalog, 'geosite'), [geoCatalog]);
  const geoipOptions = useMemo(() => geoCategoryOptions(geoCatalog, 'geoip'), [geoCatalog]);
  const localGeositeTags = useMemo(() => localGeoTagSet(geoLocalList, 'geosite'), [geoLocalList]);
  const localGeoipTags = useMemo(() => localGeoTagSet(geoLocalList, 'geoip'), [geoLocalList]);
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

  // 拉取远程全量 geo 分类清单（内置/缓存只含精选；与「资源库」对话框同源 MetaCubeX）
  const refreshGeoCatalog = async () => {
    setGeoCatalogRefreshing(true);
    try {
      const r = await api.ruleResources.refreshCatalog();
      setGeoCatalog(r.items || []);
    } catch {
      toast.error(t('rules.customApp.geoRefreshFailed', '刷新分类清单失败'));
    } finally {
      setGeoCatalogRefreshing(false);
    }
  };

  const handleAddCustomApp = async () => {
    if (!newAppName.trim() || newAppGeositeTags.length === 0) {
      toast.error(t('rules.customApp.fillNameAndGeosite'));
      return;
    }

    const newId = `custom-${Date.now()}`;
    const newPreset: CustomAppPreset = {
      id: newId,
      name: newAppName.trim(),
      emoji: newAppEmoji.trim() || '🌐',
      iconUrl: newAppIconUrl.trim() || undefined,
      geositeTags: newAppGeositeTags,
      geoipTags: newAppGeoipTags.length > 0 ? newAppGeoipTags : undefined,
    };

    try {
      await saveConfig({
        ...config,
        customAppPresets: [...customPresets, newPreset],
        // 同注入默认 appRule（代理·跟全局），使 rule-sel-app selector 随本次添加重启一并 materialize →
        // 首次切节点即热切换，与内置预设卡片一致（否则首次设策略还要再重启一次）。删除时 handleDeleteCustomApp 一并清理。
        appRules: [...appRules, { appId: newId, action: 'proxy', enabled: true }],
      });
    } catch {
      toast.error(t('common.saveFailed'));
      return;
    }

    // fail-closed 联动规则资源：所选 geo 中尚未本地（内置随包 / 已下载）的分类 → 下载进「规则资源」→ 可见可管 +
    // 路由生成复用本地副本（见 ProxyManager.localResPath）。已无远程兜底——下载失败时该分类的 geo 半暂不生效
    // （进程名仍生效），可在「规则资源」页重试后自动恢复；故失败须可感知（toast），不再静默吞掉。
    const toDownload = [
      ...newAppGeositeTags
        .filter((tg) => !localGeositeTags.has(tg))
        .map((tg) => ({ catalogId: `geosite-${tg}` })),
      ...newAppGeoipTags
        .filter((tg) => !localGeoipTags.has(tg))
        .map((tg) => ({ catalogId: `geoip-${tg}` })),
    ];
    if (toDownload.length > 0) {
      toast.info(
        t('rules.customApp.geoDownloading', '正在下载 {{n}} 个分类规则集到规则资源', {
          n: toDownload.length,
        })
      );
      void api.ruleResources
        .download(toDownload)
        .then((results) => {
          const fail = (results || []).filter((r) => !r.ok).length;
          if (fail > 0) {
            toast.warning(
              t(
                'rules.customApp.geoDownloadPartial',
                '{{n}} 个分类下载失败，可在「规则资源」页重试（缺失时该分类不生效，进程名仍生效）',
                { n: fail }
              )
            );
          }
        })
        .catch(() => {
          toast.error(
            t('rules.customApp.geoDownloadFailed', '分类规则集下载失败，可在「规则资源」页重试')
          );
        });
    }

    setIsAddDialogOpen(false);
    setShowIconGallery(false);
    setNewAppName('');
    setNewAppEmoji('🌐');
    setNewAppIconUrl('');
    setNewAppGeositeTags([]);
    setNewAppGeoipTags([]);
    toast.success(t('rules.customApp.addSuccess'));
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
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 transition-colors group-focus-within:text-primary" />
            <Input
              placeholder={t('rules.searchApps')}
              value={appSearchQuery}
              onChange={(e) => setAppSearchQuery(e.target.value)}
              className="pl-10 h-11 bg-muted/40 border-muted-foreground/10 focus:border-primary/30 transition-all rounded-xl text-sm"
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
                    <span className="pointer-events-none absolute right-2 top-2 text-muted-foreground/40 transition-colors group-hover:text-primary">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </span>
                    {/* 左上脚标：策略选择器入口提示。提升可见度（10px/80% 半粗）+ hover 提亮，与右上 chevron 联动暗示可点击 */}
                    <div
                      className={`text-[10px] text-muted-foreground/80 font-semibold tracking-tight leading-none mt-0.5 mb-1 transition-colors group-hover:text-primary ${viewMode === 'comfortable' ? 'ml-1.5' : 'ml-2.5'}`}
                    >
                      {t('rules.appRulesManualSelection')}
                    </div>

                    <div
                      className={
                        viewMode === 'comfortable'
                          ? 'flex items-center gap-2.5 w-full flex-1 ml-1.5'
                          : 'flex items-center gap-2 w-full mt-0.5 ml-2.5'
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
                          ? `absolute bottom-1.5 left-2.5 right-3.5 text-[9.5px] w-full text-left font-bold tracking-normal truncate ${
                              !rule || !isEnabled
                                ? 'text-primary'
                                : rule.action === 'direct'
                                  ? 'text-success'
                                  : rule.action === 'block'
                                    ? 'text-destructive'
                                    : 'text-primary'
                            }`
                          : `text-[9px] w-full text-left font-bold tracking-normal truncate ml-2 ${
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
                    className="absolute -top-1 -left-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm"
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
                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm z-10"
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
                onClick={() => {
                  setShowIconGallery(false);
                  setIsAddDialogOpen(true);
                }}
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

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          {showIconGallery ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setShowIconGallery(false)}
                  >
                    <Plus className="h-4 w-4 rotate-45" />
                  </Button>
                  {t('rules.customApp.selectIconGallery')}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('rules.customApp.searchIconPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-10 text-sm bg-muted/30 border-none focus-visible:ring-1"
                  />
                </div>
                <ScrollArea className="h-[300px] pr-4">
                  <div className="grid grid-cols-5 gap-3 p-1">
                    {isLoadingIcons ? (
                      <div className="col-span-5 py-20 text-center text-sm text-muted-foreground animate-pulse">
                        {t('rules.customApp.loadingIcons')}
                      </div>
                    ) : (
                      <>
                        {!searchQuery && (
                          <Button
                            variant="outline"
                            className="h-12 w-12 p-0 text-xl hover:bg-primary/5 hover:border-primary/30"
                            onClick={() => {
                              setNewAppIconUrl('');
                              setNewAppEmoji('🌐');
                              setShowIconGallery(false);
                            }}
                          >
                            🌐
                          </Button>
                        )}
                        {filteredIcons.map((icon, idx) => (
                          <Button
                            key={`${icon.name}-${idx}`}
                            variant="ghost"
                            className="h-12 w-12 p-1.5 hover:bg-primary/5 hover:border-primary/30 border border-transparent transition-all"
                            onClick={() => {
                              setNewAppIconUrl(icon.url);
                              if (!newAppName) {
                                setNewAppName(icon.name.replace('.png', '').replace(/_/g, ' '));
                              }
                              setShowIconGallery(false);
                            }}
                          >
                            <img
                              src={icon.url}
                              className="h-full w-full object-contain"
                              alt={icon.name}
                            />
                          </Button>
                        ))}
                      </>
                    )}
                  </div>
                  {!isLoadingIcons && iconGalleries.length === 0 && (
                    <div className="py-6 px-2 space-y-3">
                      <p className="text-xs text-center text-muted-foreground">
                        {t('rules.customApp.iconLoadFailed')}
                      </p>
                      {/* 兜底方案：手动输入图标 URL */}
                      <div className="space-y-2">
                        <p className="text-[10px] text-muted-foreground">
                          {t('rules.customApp.manualIconHint')}
                        </p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="https://example.com/icon.png"
                            value={newAppIconUrl}
                            onChange={(e) => setNewAppIconUrl(e.target.value)}
                            className="h-9 text-xs bg-muted/30 border-none focus-visible:ring-1"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 h-9"
                            onClick={() => setShowIconGallery(false)}
                          >
                            {t('common.confirm')}
                          </Button>
                        </div>
                      </div>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-[10px] w-full"
                        onClick={() => setRetryTick((n) => n + 1)}
                      >
                        {t('rules.customApp.retryLoad')}
                      </Button>
                    </div>
                  )}
                </ScrollArea>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('rules.customApp.addTitle')}</DialogTitle>
                <DialogDescription>{t('rules.customApp.addDesc')}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">{t('rules.customApp.iconLabel')}</Label>
                  <div className="col-span-3">
                    <Button
                      variant="outline"
                      className="w-full flex items-center justify-between gap-3 px-4 h-12 rounded-xl group border-dashed hover:border-primary/50 hover:bg-primary/5 transition-all"
                      onClick={() => setShowIconGallery(true)}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="h-8 w-8 flex items-center justify-center shrink-0">
                          {newAppIconUrl ? (
                            <img src={newAppIconUrl} className="h-full w-full object-contain" />
                          ) : (
                            <span className="text-xl">{newAppEmoji}</span>
                          )}
                        </div>
                        <div className="flex flex-col items-start overflow-hidden">
                          <span className="text-sm font-medium">
                            {t('rules.customApp.browseIcons')}
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {newAppIconUrl
                              ? t('rules.customApp.iconSelected', { url: newAppIconUrl })
                              : t('rules.customApp.iconChoosePrompt')}
                          </span>
                        </div>
                      </div>
                      <ImageIcon className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:text-primary transition-all" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="name" className="text-right">
                    {t('rules.customApp.nameLabel')}
                  </Label>
                  <Input
                    id="name"
                    value={newAppName}
                    onChange={(e) => setNewAppName(e.target.value)}
                    placeholder={t('rules.customApp.namePlaceholder')}
                    className="col-span-3 h-10 rounded-lg bg-muted/20 border-none focus-visible:ring-1"
                  />
                </div>
                <div className="grid grid-cols-4 items-start gap-4">
                  <Label className="pt-3 text-right">Geosite</Label>
                  <div className="col-span-3">
                    <GeoTagPicker
                      options={geositeOptions}
                      value={newAppGeositeTags}
                      onChange={setNewAppGeositeTags}
                      localTags={localGeositeTags}
                      loading={geoCatalogLoading}
                      refreshing={geoCatalogRefreshing}
                      onRefresh={refreshGeoCatalog}
                      placeholder={t(
                        'rules.customApp.geoSearchPlaceholder',
                        '搜索分类，如 youtube'
                      )}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-4 items-start gap-4">
                  <Label className="pt-3 text-right">GeoIP</Label>
                  <div className="col-span-3">
                    <GeoTagPicker
                      options={geoipOptions}
                      value={newAppGeoipTags}
                      onChange={setNewAppGeoipTags}
                      localTags={localGeoipTags}
                      loading={geoCatalogLoading}
                      refreshing={geoCatalogRefreshing}
                      onRefresh={refreshGeoCatalog}
                      placeholder={t(
                        'rules.customApp.geoSearchPlaceholder',
                        '搜索分类，如 youtube'
                      )}
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleAddCustomApp}>{t('rules.customApp.save')}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
