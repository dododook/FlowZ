import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useAppStore } from '@/store/app-store';
import { enumerateResourceRefs } from '@shared/rule-resource-refs';
import { smartBaselineGeoTags } from '@shared/region-routing';
import { api } from '@/ipc/api-client';
import { cn } from '@/lib/utils';
import { InfoTooltip } from '@/components/settings/shared/info-tooltip';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Library,
  Link as LinkIcon,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { GH_PROXY_PRESETS, normalizeGhProxyPrefix } from '../../shared/gh-proxy';
import { formatBytes, formatTimeAgo } from '@/lib/format';
import type {
  RuleResourceDownloadItem,
  RuleResourceListItem,
  RuleResourceProgress,
  RuleResourceRef,
} from '@/bridge/types';
import {
  RESOURCE_CATEGORY_PILL,
  ResourceCatalogDialog,
} from '@/components/rules/resource-catalog-dialog';
import { ResourceUrlDialog } from '@/components/rules/resource-url-dialog';
import {
  isUpdateAllDisabled,
  partitionProgress,
  resourceRowAction,
} from '@/components/rules/rule-resources-logic';

const DIRECT = '__direct__';
const CUSTOM = '__custom__';

function reportDownloadResult(results: Array<{ ok: boolean }>, t: TFunction): void {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  if (fail === 0) toast.success(t('ruleResources.downloadSuccess', '已下载 {{n}} 项', { n: ok }));
  else if (ok === 0) toast.error(t('ruleResources.downloadAllFailed', '下载失败'));
  else toast.warning(t('ruleResources.partialFailed', '{{ok}} 成功，{{fail}} 失败', { ok, fail }));
}

export function RuleResourcesPage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const ghPrefix = config?.ghProxyPrefix || '';

  const [items, setItems] = useState<RuleResourceListItem[]>([]);
  const [progress, setProgress] = useState<Map<string, RuleResourceProgress>>(new Map());
  // 已下载列表 TAB 区分：全部 / 内置（随包）/ 外置（用户下载）。
  const [listTab, setListTab] = useState<'all' | 'builtin' | 'external'>('all');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState('');
  // GitHub 加速 3+ 选下拉（Conduit .rsc-sel）：受控开合 + 点击外部收起。
  const [accelOpen, setAccelOpen] = useState(false);
  const accelRef = useRef<HTMLDivElement>(null);
  // 已下载表内搜索（原型表头搜索框）：按名称即时过滤。
  const [tableSearch, setTableSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    name: string;
    rules: RuleResourceRef[];
  } | null>(null);
  // 重置为出厂=高危（丢弃已下载更新），点击先二次确认，确认后才真正写运行时目录。
  const [resetConfirm, setResetConfirm] = useState<RuleResourceListItem | null>(null);

  const refresh = useCallback(() => {
    api.ruleResources
      .list()
      .then(setItems)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unsub = api.ruleResources.onProgress((p) => {
      setProgress((prev) => {
        const next = new Map(prev);
        if (p.status === 'done') next.delete(p.id);
        else next.set(p.id, p);
        return next;
      });
      if (p.status === 'done') refresh();
    });
    return unsub;
  }, [refresh]);

  // .rsc-sel 下拉点击外部收起
  useEffect(() => {
    if (!accelOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (accelRef.current && !accelRef.current.contains(e.target as Node)) setAccelOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [accelOpen]);

  // 「本地已有」= 下载记录在 且 磁盘文件实际存在（fileExists）；文件被删 → 不在此集 → 资源库对话框回到可勾选可重下。
  // 用全集 items（非 filteredItems）构建，确保对话框判定不受当前 TAB 过滤影响。
  const presentIds = new Set(items.filter((i) => i.fileExists).map((i) => i.id));
  // TAB 过滤：内置 = 随包资源（builtin:true）；外置 = 用户下载。
  const filteredItems =
    listTab === 'all'
      ? items
      : items.filter((i) => (listTab === 'builtin' ? i.builtin : !i.builtin));
  // 表头搜索（名称子串匹配，大小写不敏感）叠加在 TAB 过滤之上。
  const searchQ = tableSearch.trim().toLowerCase();
  const displayedItems = searchQ
    ? filteredItems.filter((i) => i.name.toLowerCase().includes(searchQ))
    : filteredItems;

  // 页头/表头摘要：总项数、占用（存在文件求和）、缺失项数。
  const totalCount = items.length;
  const totalBytes = items.reduce((s, i) => s + (i.fileExists ? i.size : 0), 0);
  const missingCount = items.filter((i) => !i.fileExists).length;

  const handleDownload = async (downloadItems: RuleResourceDownloadItem[]) => {
    if (downloadItems.length === 0) return;
    try {
      const results = await api.ruleResources.download(downloadItems);
      refresh();
      reportDownloadResult(results, t);
    } catch {
      refresh();
      toast.error(t('ruleResources.downloadAllFailed', '下载失败'));
    }
  };

  const handleRedownload = async (id: string) => {
    try {
      const r = await api.ruleResources.redownload(id);
      refresh();
      if (!r.ok) toast.error(t('ruleResources.downloadAllFailed', '下载失败'));
    } catch {
      refresh();
      toast.error(t('ruleResources.downloadAllFailed', '下载失败'));
    }
  };

  const confirmReset = async () => {
    const item = resetConfirm;
    setResetConfirm(null);
    if (!item || !item.builtin) return;
    const tag = item.id.replace(/^builtin:/, '');
    try {
      const r = await api.ruleResources.resetBuiltin(tag);
      refresh();
      if (r.ok) toast.success(t('ruleResources.resetSuccess', '已重置为出厂版'));
      else toast.error(t('ruleResources.resetFailed', '重置失败'));
    } catch {
      refresh();
      toast.error(t('ruleResources.resetFailed', '重置失败'));
    }
  };

  const handleDelete = async (item: RuleResourceListItem) => {
    if (item.builtin) return; // 内置不可删（兜底，UI 已隐藏入口）
    try {
      // 未 force 删除：后端按当前 config 判断——被启用规则引用则回传 needConfirm + 引用明细（不删），否则直接删。
      const res = await api.ruleResources.delete(item.id);
      if (res.needConfirm && res.referencingRules) {
        setDeleteConfirm({ id: item.id, name: item.name, rules: res.referencingRules });
        return;
      }
      refresh(); // 无引用 → 已删
    } catch {
      toast.error(t('ruleResources.deleteFailed', '删除失败'));
    }
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) return;
    try {
      await api.ruleResources.delete(target.id, true); // force：确认后真正删除
    } catch {
      toast.error(t('ruleResources.deleteFailed', '删除失败'));
    }
    refresh();
  };

  const dismissError = (id: string) =>
    setProgress((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

  // 相对时间渲染（i18n）
  const renderTimeAgo = (iso?: string): string => {
    const ago = formatTimeAgo(iso);
    if (!ago) return '—';
    if (ago.key === 'justNow') return t('ruleResources.timeJustNow', '刚刚');
    const cap = ago.key.charAt(0).toUpperCase() + ago.key.slice(1);
    return t(`ruleResources.time${cap}`, '{{n}} 前', { n: ago.n });
  };

  // 自动更新设置（默认开启：仅显式 false 才关；老配置 undefined 视为开）
  const autoUpdate = config?.ruleResourceAutoUpdate !== false;
  const intervalHours = config?.ruleResourceUpdateIntervalHours ?? 12;

  // 客户端计算「谁引用了该资源」——供 referencedBy 悬浮明细。与后端 referencingRules 同口径：
  // enumerateResourceRefs（路由规则 res:/geo 条件 + 应用分流 geo）+ 智能分流 geo 基线（系统隐式引用）。
  const refsByItemId = useMemo(() => {
    const map = new Map<string, { kind: 'route' | 'app' | 'system'; label: string }[]>();
    if (!config) return map;
    const baseline = smartBaselineGeoTags(config);
    for (const it of items) {
      const refs = enumerateResourceRefs(it.id, config).map((r) => ({
        kind: r.kind,
        // app 引用 label 是裸 labelKey（如 'youtube'）——须加 `rules.apps.` 前缀 t()（与删除弹窗同口径），
        // 否则内置 app 名不翻译（显 'youtube' 而非 'YouTube'）；自定义应用键不存在时回落原名。
        label: r.kind === 'app' ? t(`rules.apps.${r.label}`, r.label) : r.label,
      }));
      // 系统基线仅归属内置默认（与主进程 referencingRules 同口径）：用户下载的同名 geosite-cn 不挂系统引用。
      if (it.id.startsWith('builtin:') && baseline.has(it.id.slice('builtin:'.length))) {
        refs.push({ kind: 'system', label: t('ruleResources.smartBaselineRef', '智能分流基线') });
      }
      map.set(it.id, refs);
    }
    return map;
  }, [items, config, t]);
  const INTERVALS = [6, 12, 24, 72, 168];

  const handleAutoUpdateToggle = (enabled: boolean) => {
    void api.ruleResources.setAutoUpdate({ enabled, intervalHours });
  };
  const handleIntervalChange = (h: string) => {
    void api.ruleResources.setAutoUpdate({ enabled: true, intervalHours: Number(h) });
  };
  const handleUpdateAll = async () => {
    try {
      const results = await api.ruleResources.updateAll();
      refresh();
      if (results.length === 0) return;
      reportDownloadResult(results, t);
    } catch {
      refresh();
      toast.error(t('ruleResources.downloadAllFailed', '下载失败'));
    }
  };

  // gh-proxy 设置
  const selectValue =
    ghPrefix === '' ? DIRECT : GH_PROXY_PRESETS.includes(ghPrefix as never) ? ghPrefix : CUSTOM;

  const applyGhProxy = async (value: string) => {
    const res = await api.ruleResources.setGhProxy(value);
    if (!res.ok) toast.error(t('ruleResources.invalidProxyHost', '加速域名不合法'));
  };

  const onSelectGhProxy = (v: string) => {
    if (v === DIRECT) {
      setCustomMode(false);
      void applyGhProxy('');
    } else if (v === CUSTOM) {
      setCustomMode(true);
      setCustomInput(GH_PROXY_PRESETS.includes(ghPrefix as never) ? '' : ghPrefix);
    } else {
      setCustomMode(false);
      void applyGhProxy(v);
    }
  };

  const applyCustom = () => {
    const v = customInput.trim();
    if (!v) return;
    const normalized = normalizeGhProxyPrefix(v);
    if (!normalized) {
      toast.error(t('ruleResources.invalidProxyHost', '加速域名不合法'));
      return;
    }
    void applyGhProxy(normalized);
    setCustomMode(false);
  };

  const accelLabel =
    selectValue === DIRECT
      ? t('ruleResources.direct', '直连（不加速）')
      : selectValue === CUSTOM
        ? t('ruleResources.custom', '自定义…')
        : ghPrefix;
  const accelOptions: Array<{ value: string; label: string; hint: string }> = [
    {
      value: DIRECT,
      label: t('ruleResources.direct', '直连（不加速）'),
      hint: t('ruleResources.accelHintDirect', '官方源 · 可能较慢'),
    },
    ...GH_PROXY_PRESETS.map((p) => ({
      value: p as string,
      label: p as string,
      hint: t('ruleResources.accelHintPreset', '镜像加速'),
    })),
    {
      value: CUSTOM,
      label: t('ruleResources.custom', '自定义…'),
      hint: t('ruleResources.accelHintCustom', '自填镜像域名'),
    },
  ];

  const { active: activeRows, error: errorRows } = partitionProgress(Array.from(progress.values()));
  const hasAnyRow = displayedItems.length > 0 || activeRows.length > 0 || errorRows.length > 0;

  return (
    <div className="flex flex-col gap-4" data-page="resources">
      {/* 页头：标题 + 摘要（项数/占用/缺失）+ 资源库 / URL 下载入口 */}
      <div className="page-h">
        <h1>{t('ruleResources.pageTitle', '规则资源')}</h1>
        <span className="rsc-summary">
          {t('ruleResources.summaryCount', '共 {{n}} 项', { n: totalCount })}
          {' · '}
          <span className="mono tnum">{formatBytes(totalBytes)}</span>
          {missingCount > 0 && (
            <>
              {' · '}
              <b>{t('ruleResources.summaryMissing', '{{n}} 项缺失', { n: missingCount })}</b>
            </>
          )}
        </span>
        <div className="rsc-head-actions">
          <button className="btn ghost sm" onClick={() => setCatalogOpen(true)}>
            <Library />
            {t('ruleResources.library', '资源库')}
          </button>
          <button className="btn ghost sm" onClick={() => setUrlOpen(true)}>
            <LinkIcon />
            {t('ruleResources.manualUrl', 'URL 下载')}
          </button>
        </div>
      </div>

      {/* 设置区：GitHub 加速 + 自动更新（双列卡片） */}
      <div className="rsc-settings">
        {/* GitHub 加速 */}
        <div className="card rsc-card">
          <div className="field-lbl">
            {t('ruleResources.ghProxy', 'GitHub 加速')}{' '}
            <small>{t('ruleResources.ghProxySmall', '资源经此处下载')}</small>
          </div>
          <div className="cc-hair" />
          <div className="rsc-body">
            <div className="rsc-field-row">
              <label>{t('ruleResources.downloadMethod', '下载方式')}</label>
              <div className="rsc-sel" ref={accelRef} onClick={() => setAccelOpen((o) => !o)}>
                <span className="rsc-sel-val">{accelLabel}</span>
                <span className="rsc-sel-chev">▾</span>
                <div className="rsc-sel-menu" hidden={!accelOpen}>
                  {accelOptions.map((o) => (
                    <button
                      key={o.value}
                      className={cn(o.value === selectValue && 'on')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectGhProxy(o.value);
                        setAccelOpen(false);
                      }}
                    >
                      <span className="rsc-o-lbl">{o.label}</span>
                      <span className="rsc-o-hint">{o.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {customMode && (
              <div className="rsc-field-row">
                <label>{t('ruleResources.customDomainLabel', '自定义加速域名')}</label>
                <input
                  className="input mono"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onBlur={applyCustom}
                  onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
                  placeholder="https://your-proxy.example/"
                  spellCheck={false}
                />
              </div>
            )}
            <p className="rsc-hint">
              <span className="dot idle" />
              {t('ruleResources.ghProxyHint', '留空回退直连；下载失败自动回退直连兜底。')}
            </p>
          </div>
        </div>

        {/* 自动更新 */}
        <div className="card rsc-card">
          <div className="rsc-card-head">
            <div className="field-lbl">
              {t('ruleResources.autoUpdate', '自动更新')}{' '}
              <small>
                {t('ruleResources.autoUpdateDesc', '按设定间隔自动重新下载已下载的规则资源')}
              </small>
              <InfoTooltip content={t('ruleResources.autoUpdateDescFull')} />
            </div>
            <button
              className={cn('swt', autoUpdate && 'on')}
              role="switch"
              aria-checked={autoUpdate}
              aria-label={t('ruleResources.autoUpdate', '自动更新')}
              onClick={() => handleAutoUpdateToggle(!autoUpdate)}
            />
          </div>
          <div className="cc-hair" />
          <div className="rsc-body">
            {autoUpdate && (
              <div className="rsc-field-row">
                <label>{t('ruleResources.updateInterval', '更新间隔')}</label>
                <div className="seg2">
                  {INTERVALS.map((h) => (
                    <button
                      key={h}
                      className={cn(intervalHours === h && 'on')}
                      onClick={() => handleIntervalChange(String(h))}
                    >
                      {t(`ruleResources.interval.h${h}`, h < 24 ? `${h} 小时` : `${h / 24} 天`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="rsc-hint">
              <span className={cn('dot', autoUpdate ? 'ok' : 'idle')} />
              {autoUpdate
                ? t('ruleResources.autoUpdateOnHint', '已开启，按所选间隔在后台刷新已下载资源')
                : t('ruleResources.autoUpdateOffHint', '已关闭，资源需手动更新')}
            </p>
          </div>
        </div>
      </div>

      {/* 已下载资源表 */}
      <div className="card rsc-table-card">
        <div className="rsc-table-head">
          <div className="tabs">
            {(['all', 'builtin', 'external'] as const).map((tabKey) => (
              <button
                key={tabKey}
                className={cn(listTab === tabKey && 'on')}
                onClick={() => setListTab(tabKey)}
              >
                {tabKey === 'all'
                  ? t('ruleResources.listTabAll', '全部')
                  : tabKey === 'builtin'
                    ? t('ruleResources.listTabBuiltin', '内置')
                    : t('ruleResources.listTabExternal', '外置')}
              </button>
            ))}
          </div>
          <span className="rsc-th-count">
            {t('ruleResources.tableUsage', '占用')}{' '}
            <span className="mono tnum">{formatBytes(totalBytes)}</span>
          </span>
          <div className="rsc-th-right">
            <button
              className="btn ghost sm rsc-update-all"
              onClick={handleUpdateAll}
              disabled={isUpdateAllDisabled(items.length, activeRows.length)}
              title={t('ruleResources.updateAll', '全部更新')}
            >
              <RefreshCw />
              {t('ruleResources.updateAll', '全部更新')}
            </button>
            <div className="rsc-search">
              <Search />
              <input
                className="input"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder={t('ruleResources.searchDownloaded', '搜索资源…')}
              />
            </div>
          </div>
        </div>
        <div className="cc-hair" />
        {!hasAnyRow ? (
          <div
            className="px-4 py-10 text-center text-[13px]"
            style={{ color: 'hsl(var(--fg-faint))' }}
          >
            {tableSearch
              ? t('ruleResources.searchEmpty', '未找到匹配的资源')
              : listTab === 'all'
                ? t('ruleResources.empty', '暂无规则资源，点击「资源库」或「URL 下载」添加')
                : t('ruleResources.emptyTab', '该分类下暂无资源')}
          </div>
        ) : (
          <div className="rsc-table-scroll">
            {/* fit-to-width：名称列弹性截断、其余固定，操作列在默认 800 窄窗恒显不被横滚遮盖（用户反馈）。 */}
            <table
              className="rsc-table rsc-fit"
              style={{ tableLayout: 'fixed', width: '100%', minWidth: 0 }}
            >
              <colgroup>
                <col />
                <col style={{ width: 74 }} />
                <col style={{ width: 78 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 66 }} />
                <col style={{ width: 92 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('ruleResources.colName', '名称')}</th>
                  <th>{t('ruleResources.colType', '分类')}</th>
                  <th className="rc-r">{t('ruleResources.colSize', '大小')}</th>
                  <th>{t('ruleResources.colUpdated', '更新于')}</th>
                  <th className="rc-r">{t('ruleResources.colRef', '引用')}</th>
                  <th className="rc-r">{t('common.actions', '操作')}</th>
                </tr>
              </thead>
              <tbody>
                {/* 下载中（临时行，置顶） */}
                {activeRows.map((p) => (
                  <tr key={`act-${p.id}`} className="rc-downloading">
                    <td>
                      <div className="rc-name">
                        <span className="rc-nm mono">{p.name}</span>
                        <span className="rc-badge dl">
                          {t('ruleResources.downloadingBadge', '下载中')}
                        </span>
                      </div>
                    </td>
                    <td colSpan={4}>
                      <div className="rc-prog-inner">
                        <div className="bar">
                          <i style={{ width: `${p.percent ?? 0}%` }} />
                        </div>
                        <span className="rc-prog-pct mono tnum">
                          {p.status === 'queued'
                            ? t('ruleResources.queued', '等待中…')
                            : p.percent != null
                              ? `${p.percent}%`
                              : formatBytes(p.received)}
                        </span>
                      </div>
                    </td>
                    <td className="rc-r" />
                  </tr>
                ))}
                {/* 失败（临时行） */}
                {errorRows.map((p) => (
                  <tr key={`err-${p.id}`} className="rc-failed">
                    <td>
                      <div className="rc-name">
                        <span className="rc-nm mono">{p.name}</span>
                        <span className="rc-badge fail">
                          {t('ruleResources.failedBadge', '失败')}
                        </span>
                      </div>
                    </td>
                    <td colSpan={4}>
                      <div className="rc-fail-cell">
                        <span className="dot warn" />
                        {t(
                          `ruleResources.error.${p.errorCode}`,
                          t('ruleResources.downloadAllFailed', '下载失败')
                        )}
                      </div>
                    </td>
                    <td className="rc-r">
                      <div className="rc-ops">
                        <button
                          className="btn ghost icon"
                          title={t('ruleResources.dismiss', '忽略')}
                          onClick={() => dismissError(p.id)}
                        >
                          <X />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {/* 已下载 */}
                {displayedItems.map((item) => {
                  const missing = !item.fileExists;
                  // 计数 + 浮窗同源于 refs（refsByItemId），避免与 item.referencedBy（主进程快照）竞态不一致
                  // （config 已更新但 list() 未回 → 一处显「未引用」另一处浮窗却列出引用）。
                  const refs = refsByItemId.get(item.id) ?? [];
                  const refText =
                    refs.length > 0
                      ? t('ruleResources.referencedBy', '{{n}} 条规则', { n: refs.length })
                      : item.builtin
                        ? t('ruleResources.builtinRef', '智能分流')
                        : t('ruleResources.refNone', '未引用');
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="rc-name">
                          <span className="rc-nm mono" title={item.name}>
                            {item.name}
                          </span>
                          {item.builtin && (
                            <span className="rc-badge bi">
                              {t('ruleResources.builtinBadge', '内置')}
                            </span>
                          )}
                          {missing && (
                            <span className="rc-badge miss">
                              {t('ruleResources.missing', '文件缺失')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={cn('pill', RESOURCE_CATEGORY_PILL[item.category])}>
                          {t(`ruleResources.category.${item.category}`, item.category)}
                        </span>
                      </td>
                      <td className="rc-r rc-num mono tnum">
                        {missing ? '—' : formatBytes(item.size)}
                      </td>
                      <td
                        className="rc-time"
                        title={
                          item.downloadedAt ? new Date(item.downloadedAt).toLocaleString() : ''
                        }
                      >
                        {renderTimeAgo(item.downloadedAt)}
                      </td>
                      <td
                        className={cn('rc-r rc-ref', refs.length === 0 && !item.builtin && 'none')}
                      >
                        {refs.length > 0 ? (
                          // 悬停明细（radix HoverCard，portal 不被表格 overflow 裁剪 + openDelay 1s）：显具体被谁引用。
                          <HoverCard openDelay={1000} closeDelay={80}>
                            <HoverCardTrigger asChild>
                              <span className="cursor-default underline decoration-dotted decoration-fg-faint underline-offset-2">
                                {refText}
                              </span>
                            </HoverCardTrigger>
                            <HoverCardContent
                              align="end"
                              className="flex w-auto min-w-[176px] max-w-[280px] flex-col gap-1.5 p-2.5"
                            >
                              {refs.map((r, i) => (
                                <div key={i} className="flex items-baseline gap-2">
                                  <span className={cn('rc-ref-kind', r.kind)}>
                                    {r.kind === 'route'
                                      ? t('ruleResources.refKindRoute', '路由')
                                      : r.kind === 'app'
                                        ? t('ruleResources.refKindApp', '应用')
                                        : t('ruleResources.refKindSystem', '系统')}
                                  </span>
                                  <span className="truncate text-[12px] text-foreground">
                                    {r.label}
                                  </span>
                                </div>
                              ))}
                            </HoverCardContent>
                          </HoverCard>
                        ) : (
                          refText
                        )}
                      </td>
                      <td className="rc-r">
                        <div className="rc-ops">
                          <button
                            className="btn ghost icon"
                            onClick={() => handleRedownload(item.id)}
                            title={t('ruleResources.update', '更新')}
                          >
                            <RotateCw />
                          </button>
                          {resourceRowAction(item) === 'reset' ? (
                            <button
                              className="btn ghost icon"
                              onClick={() => setResetConfirm(item)}
                              title={t('ruleResources.reset', '重置为出厂')}
                            >
                              <RotateCcw />
                            </button>
                          ) : (
                            <button
                              className="btn ghost icon rc-icon-del"
                              onClick={() => handleDelete(item)}
                              title={t('ruleResources.delete', '删除')}
                            >
                              <Trash2 />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ResourceCatalogDialog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        presentIds={presentIds}
        builtinItems={items.filter((i) => i.builtin)}
        onDownload={handleDownload}
      />
      <ResourceUrlDialog open={urlOpen} onOpenChange={setUrlOpen} onDownload={handleDownload} />

      {/* 删除引用确认（AlertDialog + Conduit .rsc-dialog 内部结构） */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <AlertDialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[440px]">
          <div className="rsc-dialog-h">
            <AlertDialogTitle>{t('ruleResources.deleteTitle', '删除规则资源')}</AlertDialogTitle>
            <button
              className="rsc-x"
              aria-label={t('common.cancel', '取消')}
              onClick={() => setDeleteConfirm(null)}
            >
              ✕
            </button>
          </div>
          <AlertDialogDescription asChild>
            <div className="rsc-dialog-b">
              <p className="rsc-del-lead">
                {t(
                  'ruleResources.deleteReferencedDesc',
                  '「{{name}}」正被以下 {{n}} 项规则引用，删除后将暂时失效（重新下载该资源后自动恢复）：',
                  { name: deleteConfirm?.name, n: deleteConfirm?.rules.length ?? 0 }
                )}
              </p>
              {/* 分两组、措辞区分后果：路由规则=暂时失效（warn）；应用分流=改走智能分流·进程名仍生效（ok，fail-closed 解耦） */}
              {(['route', 'app'] as const).map((kind) => {
                const group = deleteConfirm?.rules.filter((r) => r.kind === kind) ?? [];
                if (group.length === 0) return null;
                const warn = kind === 'route';
                return (
                  <div key={kind} className={cn('rsc-ref-group', warn ? 'warn' : 'ok')}>
                    <div className="rsc-ref-group-h">
                      <span className={cn('dot', warn ? 'warn' : 'idle')} />
                      {warn
                        ? t('ruleResources.deleteGroupRoute', '路由规则（暂时失效·重下恢复）')
                        : t(
                            'ruleResources.deleteGroupApp',
                            '应用分流（改走智能分流·重下恢复·进程名仍生效）'
                          )}
                      <small>
                        {t('ruleResources.refGroupCount', '{{n}} 条', { n: group.length })}
                      </small>
                    </div>
                    <ul className="rsc-ref-list">
                      {group.map((r) => (
                        <li key={`${r.kind}-${r.id}`}>
                          <span className="pill rc-app">
                            {warn
                              ? t('ruleResources.refKindRoute', '路由')
                              : t('ruleResources.refKindApp', '应用')}
                          </span>
                          <span className="mono">
                            {r.kind === 'app' && r.appBuiltin
                              ? t(`rules.apps.${r.label}` as never, r.label)
                              : r.label}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </AlertDialogDescription>
          <div className="rsc-dialog-f">
            <button className="btn ghost" onClick={() => setDeleteConfirm(null)}>
              {t('common.cancel', '取消')}
            </button>
            <button className="btn danger" onClick={confirmDelete}>
              {t('ruleResources.deleteAnyway', '仍要删除')}
            </button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* 重置为出厂二次确认（高危：丢弃已下载更新，恢复随包版本） */}
      <AlertDialog open={!!resetConfirm} onOpenChange={(o) => !o && setResetConfirm(null)}>
        <AlertDialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[440px]">
          <div className="rsc-dialog-h">
            <AlertDialogTitle>{t('ruleResources.resetTitle', '重置为出厂版')}</AlertDialogTitle>
            <button
              className="rsc-x"
              aria-label={t('common.cancel', '取消')}
              onClick={() => setResetConfirm(null)}
            >
              ✕
            </button>
          </div>
          <AlertDialogDescription asChild>
            <div className="rsc-dialog-b">
              <p className="rsc-del-lead">
                {t(
                  'ruleResources.resetConfirmDesc',
                  '将「{{name}}」恢复为随 App 出厂的版本，已下载更新的内容会丢失（之后可重新更新）。',
                  { name: resetConfirm?.name }
                )}
              </p>
            </div>
          </AlertDialogDescription>
          <div className="rsc-dialog-f">
            <button className="btn ghost" onClick={() => setResetConfirm(null)}>
              {t('common.cancel', '取消')}
            </button>
            <button className="btn danger" onClick={confirmReset}>
              {t('ruleResources.resetConfirmBtn', '重置为出厂')}
            </button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
