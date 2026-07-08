import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { Info, Loader2, RotateCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
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
import { CATALOG_FILTERS, matchesCategoryFilter, type CatalogFilter } from './rule-resources-logic';

const BUILTIN_CATALOG_IDS = RULE_RESOURCE_CATALOG.map((i) => i.id);

/** 资源库 TAB：内置=随包规则集（已内置、可直接引用）；外置=远程全量（需刷新拉取）+ 自定义 URL。 */
type LibTab = 'builtin' | 'external';

/** 统一展示项：内置（RuleResourceListItem）与外置（catalog）归一为同构行渲染。 */
interface DisplayItem {
  id: string;
  name: string;
  category: RuleResourceCategory;
  path: string; // 内置=rule_set tag，外置=仓库路径（收进 title 悬浮）
  present: boolean; // 已内置 / 已下载（本地已有）
  selectable: boolean; // 可勾选下载（仅外置本地无的项）
  missing: boolean; // 标「文件缺失」（仅内置文件该在却没在）
  size?: number; // 字节（仅内置随包项可得；外置 catalog 无 size）
}

/** 资源分类 → Conduit pill 配色类（geosite 域名色 / geoip IP 色 / lite·custom 中性）。 */
export const RESOURCE_CATEGORY_PILL: Record<RuleResourceCategory, string> = {
  geosite: 'rc-site',
  'geosite-lite': 'rc-lite',
  geoip: 'rc-ip',
  'geoip-lite': 'rc-lite',
  custom: 'rc-app',
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
          size: b.size,
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
    const matched = tabItems.filter(
      (i) =>
        matchesCategoryFilter(i.category, filter) &&
        (!q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
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

  const switchTab = (v: LibTab) => {
    setTab(v);
    setSearch('');
    setSelected(new Set()); // 切 Tab 清选中，防跨 tab（内置↔外置）下载混入
  };

  const handleDownload = () => {
    onDownload(Array.from(selected).map((id) => ({ catalogId: id })));
    onOpenChange(false);
  };

  // 单行卡片（Conduit .rsc-lib-row）：勾选框 + 名称(mono, 搜索高亮) + 分类 pill + 大小(内置可得) + 状态徽标。
  // 可下载项 = 启用勾选框 + 全行 label 点击；已内置/已下载/文件缺失 = 禁用勾选框 + 对应徽标。
  const renderRow = (d: DisplayItem) => (
    <label key={d.id} className={cn('rsc-lib-row', !d.selectable && 'disabled')}>
      <input
        type="checkbox"
        className="rsc-check"
        checked={d.selectable ? selected.has(d.id) : d.present}
        disabled={!d.selectable}
        onChange={() => d.selectable && toggle(d.id)}
      />
      <span className="rc-nm mono" title={d.path}>
        <HighlightText text={d.name} query={search} />
      </span>
      <span className={cn('pill', RESOURCE_CATEGORY_PILL[d.category])}>
        {t(`ruleResources.category.${d.category}`, d.category)}
      </span>
      {d.size != null && <span className="rsc-lib-size mono tnum">{formatKb(d.size)}</span>}
      {d.present ? (
        <span className={cn('rsc-lib-badge', tab === 'builtin' ? 'bi' : 'have')}>
          {tab === 'builtin'
            ? t('ruleResources.builtinMark', '已内置')
            : t('ruleResources.downloaded', '已下载')}
        </span>
      ) : d.missing ? (
        <span className="rsc-lib-badge miss">{t('ruleResources.missing', '文件缺失')}</span>
      ) : null}
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 复用 radix Dialog（焦点陷阱/Esc/portal），置零内边距后套 Conduit .rsc-dialog-lib 内部结构；
          [&>button]:hidden 隐藏 DialogContent 自带右上角关闭钮（改用头部 .rsc-x）。 */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[520px] [&>button]:hidden">
        <DialogDescription className="sr-only">
          {t(
            'ruleResources.libraryDesc',
            '内置=随包规则集（已内置，可直接引用）；外置=刷新拉取远程全量 + 粘贴自定义 URL，可多选下载。'
          )}
        </DialogDescription>

        <div className="rsc-dialog-h">
          <DialogTitle>{t('ruleResources.library', '资源库')}</DialogTitle>
          {/* 刷新仅外置 TAB 需要（内置=随包，无远程清单可刷） */}
          {tab === 'external' && (
            <button
              className="btn ghost sm rsc-lib-refresh"
              onClick={refresh}
              disabled={refreshing}
            >
              <RotateCw className={refreshing ? 'animate-spin' : ''} />
              {t('ruleResources.refreshCatalogBtn', '刷新清单')}
            </button>
          )}
          <button
            className="rsc-x"
            aria-label={t('servers.cancel', '取消')}
            onClick={() => onOpenChange(false)}
          >
            ✕
          </button>
        </div>

        {/* 内置 / 外置 TAB（原型无此切换；真实功能保留：随包 vs 远程·URL 两态数据源） */}
        <div className="px-4 pt-3">
          <div className="tabs">
            <button className={cn(tab === 'builtin' && 'on')} onClick={() => switchTab('builtin')}>
              {t('ruleResources.libTabBuiltin', '内置 · 随包')}
            </button>
            <button
              className={cn(tab === 'external' && 'on')}
              onClick={() => switchTab('external')}
            >
              {t('ruleResources.libTabExternal', '外置 · 远程/URL')}
            </button>
          </div>
        </div>

        <div className="rsc-lib-toolbar">
          <div className="rsc-cat-filter">
            {CATALOG_FILTERS.map((f) => (
              <button
                key={f}
                className={cn('rsc-chip', filter === f && 'on')}
                onClick={() => setFilter(f)}
              >
                {f === 'all'
                  ? t('ruleResources.filterAll', '全部')
                  : f === 'lite'
                    ? t('ruleResources.filterLite', '精简')
                    : t(`ruleResources.category.${f}`, f)}
              </button>
            ))}
          </div>
          <div className="rsc-search">
            <Search />
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('ruleResources.searchCatalog', '搜索规则集')}
            />
          </div>
        </div>

        {/* 外置 TAB：粘贴自定义 URL 直接下载（真实功能保留，原型未含） */}
        {tab === 'external' && (
          <div className="flex items-center gap-2 px-4 pb-1">
            <input
              className="input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddUrl();
              }}
              placeholder={t('ruleResources.urlPlaceholder', '粘贴 .srs 规则集 URL（自定义源）')}
            />
            <button className="btn ghost sm" onClick={handleAddUrl} disabled={!url.trim()}>
              {t('ruleResources.addUrl', '添加')}
            </button>
          </div>
        )}

        {truncated && (
          <div className="rsc-lib-note">
            <Info />
            {t(
              'ruleResources.catalogTruncatedNote',
              '清单较多，仅展示前 {{shown}} 项匹配（共 {{total}} 项）· 用搜索缩小范围',
              { shown: filtered.items.length, total: filtered.total }
            )}
          </div>
        )}

        <div className="cc-hair" />

        <div className="rsc-lib-list">
          {loading ? (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
              {t('common.loading', '加载中...')}
            </div>
          ) : filtered.items.length === 0 ? (
            <div className="flex h-[200px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {externalNeedsRefresh
                ? t('ruleResources.externalNeedRefresh', '点击右上角刷新，拉取远程全量清单')
                : t('ruleResources.noCatalog', '没有匹配的规则集')}
            </div>
          ) : (
            filtered.items.map(renderRow)
          )}
        </div>

        <div className="rsc-dialog-f">
          <span className="rsc-lib-sel">
            {t('ruleResources.libSelected', '已选 {{n}} 项', { n: selected.size })}
          </span>
          <button className="btn ghost" onClick={() => onOpenChange(false)}>
            {t('servers.cancel', '取消')}
          </button>
          <button
            className="btn flow rsc-lib-dl"
            onClick={handleDownload}
            disabled={selected.size === 0}
          >
            {t('ruleResources.downloadNItems', '下载 {{count}} 项', { count: selected.size })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 字节 → 「KB / MB」简短显示（资源库行右侧，与原型 mono tnum 尺寸列一致）。 */
function formatKb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
