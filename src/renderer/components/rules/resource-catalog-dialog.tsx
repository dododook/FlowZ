import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  RotateCw,
  Search,
  Search as SearchIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/ipc/api-client';
import type {
  RuleResourceCatalogResult,
  RuleResourceCategory,
  RuleResourceDownloadItem,
  RuleResourceListItem,
} from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { RULE_RESOURCE_CATALOG, deriveResourceMeta } from '../../../shared/rule-resource-catalog';
import { resolveCatalogItemState } from './resource-catalog-utils';

const BUILTIN_CATALOG_IDS = RULE_RESOURCE_CATALOG.map((i) => i.id);

/** 资源库 TAB：内置=随包规则集（已内置、可直接引用）；外置=远程全量（需刷新拉取）+ 自定义 URL。 */
type LibTab = 'builtin' | 'external';

/** 统一展示项：内置（RuleResourceListItem）与外置（catalog）归一为同构两行渲染。 */
interface DisplayItem {
  id: string;
  name: string;
  category: RuleResourceCategory;
  path: string; // mono 次行：内置=rule_set tag，外置=仓库路径
  present: boolean; // 已内置 / 已下载（本地已有）
  selectable: boolean; // 可勾选下载（仅外置本地无的项）
  missing: boolean; // 标「文件缺失」（仅内置文件该在却没在）
}

// 分类筛选：全部 / geosite / geoip / 精简（lite）。catalog 永不含 custom（仅手动 URL 下载），故不设该选项
type CatalogFilter = 'all' | 'geosite' | 'geoip' | 'lite';
const CATALOG_FILTERS: CatalogFilter[] = ['all', 'geosite', 'geoip', 'lite'];

export const RESOURCE_CATEGORY_BADGE: Record<RuleResourceCategory, string> = {
  geosite: 'border-transparent bg-badge-blue/15 text-badge-blue',
  'geosite-lite': 'border-transparent bg-badge-blue/10 text-badge-blue',
  geoip: 'border-transparent bg-badge-purple/15 text-badge-purple',
  'geoip-lite': 'border-transparent bg-badge-purple/10 text-badge-purple',
  custom: 'border-transparent bg-muted text-muted-foreground',
};

interface ResourceCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 「本地已有」资源 id 集合（下载记录在 且 磁盘文件存在）；外置 TAB 据此判 present / 是否可勾选。 */
  presentIds: Set<string>;
  /** 随包内置规则集（已下载列表 api.list() 的 builtin 项）—— 内置 TAB 数据源。 */
  builtinItems: RuleResourceListItem[];
  onDownload: (items: RuleResourceDownloadItem[]) => void;
}

export function ResourceCatalogDialog({
  open,
  onOpenChange,
  presentIds,
  builtinItems,
  onDownload,
}: ResourceCatalogDialogProps) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<RuleResourceCatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<LibTab>('builtin');
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch('');
    setFilter('all');
    setTab('builtin');
    setUrl('');
    setLoading(true);
    api.ruleResources
      .getCatalog()
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setLoading(false));
  }, [open]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.ruleResources.refreshCatalog();
      setCatalog(res);
      toast.success(t('ruleResources.refreshOk', '资源库已更新'));
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      toast.error(
        code === 'rate_limited'
          ? t('ruleResources.rateLimited', 'GitHub 请求频繁，请稍后再试')
          : t('ruleResources.refreshFailed', '刷新资源库失败')
      );
    } finally {
      setRefreshing(false);
    }
  };

  const builtinIds = useMemo(() => new Set(BUILTIN_CATALOG_IDS), []);
  // 内置 TAB = 随包规则集（present=文件在、selectable=false，仅展示「已内置」不可下载勾选）；
  // 外置 TAB = 远程 catalog 精选之外的项：本地无（未下载 / 下载过但文件被删）→ 可勾选下载；本地有 → 展示「已下载」不可重复勾选。
  const tabItems = useMemo<DisplayItem[]>(() => {
    if (tab === 'builtin') {
      return builtinItems.map((b) => {
        const present = b.fileExists;
        return {
          id: b.id,
          name: b.name,
          category: b.category,
          path: b.id.replace(/^builtin:/, ''),
          present,
          ...resolveCatalogItemState('builtin', present),
        };
      });
    }
    return (catalog?.items || [])
      .filter((i) => !builtinIds.has(i.id))
      .map((i) => {
        const present = presentIds.has(i.id);
        return {
          id: i.id,
          name: i.name,
          category: i.category,
          path: i.path,
          present,
          ...resolveCatalogItemState('external', present),
        };
      });
  }, [tab, builtinItems, catalog, builtinIds, presentIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byCat = (i: DisplayItem) =>
      filter === 'all' ||
      (filter === 'lite' ? i.category.endsWith('-lite') : i.category === filter);
    const matched = tabItems.filter(
      (i) => byCat(i) && (!q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
    );
    return { items: matched.slice(0, 200), total: matched.length };
  }, [tabItems, search, filter]);

  const truncated = filtered.total > filtered.items.length;
  // 外置尚未拉取远程全量（catalog 仍是内置/缓存，无精选外的项）→ 提示刷新
  const externalNeedsRefresh = tab === 'external' && !search && tabItems.length === 0;

  const handleAddUrl = () => {
    const u = url.trim();
    if (!u) return;
    const meta = deriveResourceMeta(u);
    onDownload([{ url: u, name: meta.name, category: meta.category }]);
    onOpenChange(false);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDownload = () => {
    onDownload(Array.from(selected).map((id) => ({ catalogId: id })));
    onOpenChange(false);
  };

  // 两行卡片式行：行1 = name(bold) + 右侧[分类 badge][状态 badge]（self-center 垂直居中）；
  // 行2 = path(tag/仓库路径, mono muted, min-w-0 truncate 独占整行，不再被徽标挤压换行)。
  // 可下载项 = Checkbox + label 全行点击；已内置/已下载 = 绿色 CheckCircle + 状态徽标，不可勾选。
  const renderItem = (d: DisplayItem) => {
    const meta = (
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{d.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{d.path}</div>
      </div>
    );
    const badges = (
      <div className="flex shrink-0 items-center gap-1.5 self-center">
        <Badge variant="outline" className={RESOURCE_CATEGORY_BADGE[d.category]}>
          {t(`ruleResources.category.${d.category}`, d.category)}
        </Badge>
        {d.present && (
          <Badge variant="outline" className="border-transparent bg-success/15 text-success">
            {tab === 'builtin'
              ? t('ruleResources.builtinMark', '已内置')
              : t('ruleResources.downloaded', '已下载')}
          </Badge>
        )}
        {/* 「文件缺失」仅内置文件该在却没在（语义见 resolveCatalogItemState）；
            外置未下载是常态，不标缺失——Checkbox 已表达「可下载」。 */}
        {d.missing && (
          <Badge
            variant="outline"
            className="border-transparent bg-destructive/15 text-xs text-destructive"
          >
            {t('ruleResources.missing', '文件缺失')}
          </Badge>
        )}
      </div>
    );
    if (d.selectable) {
      return (
        <label
          key={d.id}
          className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/50"
        >
          <Checkbox
            checked={selected.has(d.id)}
            onCheckedChange={() => toggle(d.id)}
            className="mt-0.5"
          />
          {meta}
          {badges}
        </label>
      );
    }
    return (
      <div key={d.id} className="flex items-start gap-3 px-3 py-2.5">
        {d.present ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        ) : (
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        )}
        {meta}
        {badges}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{t('ruleResources.library', '资源库')}</DialogTitle>
            {/* 刷新仅外置 TAB 需要（内置=随包，无远程清单可刷）。带文字 outline 按钮，比纯图标更可发现。 */}
            {tab === 'external' && (
              <div className="flex items-center gap-2 pr-6">
                {catalog?.fetchedAt && (
                  <span className="text-xs text-muted-foreground">
                    {t('ruleResources.catalogUpdatedAt', '更新于')}{' '}
                    {new Date(catalog.fetchedAt).toLocaleDateString()}
                  </span>
                )}
                <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
                  <RotateCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                  {t('ruleResources.refreshCatalogBtn', '刷新清单')}
                </Button>
              </div>
            )}
          </div>
          <DialogDescription>
            {t(
              'ruleResources.libraryDesc',
              '内置=随包规则集（已内置，可直接引用）；外置=刷新拉取远程全量 + 粘贴自定义 URL，可多选下载。'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <SegmentedControl<LibTab>
            value={tab}
            onChange={(v) => {
              setTab(v);
              setSearch('');
              setSelected(new Set()); // 切 Tab 清选中，防跨 tab（内置↔外置）下载混入
            }}
            options={[
              { value: 'builtin', label: t('ruleResources.libTabBuiltin', '内置 · 随包') },
              { value: 'external', label: t('ruleResources.libTabExternal', '外置 · 远程/URL') },
            ]}
          />

          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('ruleResources.searchCatalog', '搜索规则集')}
              className="pl-8"
            />
          </div>

          <SegmentedControl<CatalogFilter>
            value={filter}
            onChange={setFilter}
            options={CATALOG_FILTERS.map((f) => ({
              value: f,
              label:
                f === 'all'
                  ? t('ruleResources.filterAll', '全部')
                  : f === 'lite'
                    ? t('ruleResources.filterLite', '精简')
                    : t(`ruleResources.category.${f}`, f),
            }))}
          />

          {tab === 'external' && (
            <div className="flex items-center gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddUrl();
                }}
                placeholder={t('ruleResources.urlPlaceholder', '粘贴 .srs 规则集 URL（自定义源）')}
                className="font-mono text-sm"
              />
              <Button variant="outline" onClick={handleAddUrl} disabled={!url.trim()}>
                {t('ruleResources.addUrl', '添加')}
              </Button>
            </div>
          )}

          <ScrollArea className="h-80 rounded-md border">
            {loading ? (
              <div className="flex h-80 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('common.loading', '加载中...')}
              </div>
            ) : filtered.items.length === 0 ? (
              <div className="flex h-80 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {externalNeedsRefresh
                  ? t('ruleResources.externalNeedRefresh', '点击右上角刷新，拉取远程全量清单')
                  : t('ruleResources.noCatalog', '没有匹配的规则集')}
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {filtered.items.map(renderItem)}
                {truncated && (
                  <div className="flex items-center justify-center gap-1.5 px-3 py-3 text-xs text-muted-foreground">
                    <SearchIcon className="h-3.5 w-3.5" />
                    {t('ruleResources.searchMore', '结果较多，继续输入以精确搜索')}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('servers.cancel', '取消')}
          </Button>
          <Button onClick={handleDownload} disabled={selected.size === 0}>
            {t('ruleResources.downloadNItems', '下载 {{count}} 项', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
