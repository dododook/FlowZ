import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsRow } from '@/components/settings/settings-row';
import { Library, Link as LinkIcon, RotateCw, RotateCcw, RefreshCw, Trash2, X } from 'lucide-react';
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
  ResourceCatalogDialog,
  RESOURCE_CATEGORY_BADGE,
} from '@/components/rules/resource-catalog-dialog';
import { ResourceUrlDialog } from '@/components/rules/resource-url-dialog';

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
  // 已下载列表 TAB 区分：全部 / 内置（随包）/ 外置（用户下载）。与资源库对话框同款分段控件。
  const [listTab, setListTab] = useState<'all' | 'builtin' | 'external'>('all');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    name: string;
    rules: RuleResourceRef[];
  } | null>(null);

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

  // 「本地已有」= 下载记录在 且 磁盘文件实际存在（fileExists）；文件被删 → 不在此集 → 资源库对话框回到可勾选可重下。
  // 用全集 items（非 filteredItems）构建，确保对话框判定不受当前 TAB 过滤影响。
  const presentIds = new Set(items.filter((i) => i.fileExists).map((i) => i.id));
  // TAB 过滤：内置 = 随包资源（builtin:true）；外置 = 用户下载。
  const filteredItems =
    listTab === 'all'
      ? items
      : items.filter((i) => (listTab === 'builtin' ? i.builtin : !i.builtin));

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

  const handleReset = async (item: RuleResourceListItem) => {
    if (!item.builtin) return;
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

  const errorRows = Array.from(progress.values()).filter((p) => p.status === 'error');
  const activeRows = Array.from(progress.values()).filter(
    (p) => p.status === 'downloading' || p.status === 'queued'
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{t('ruleResources.pageTitle', '规则资源')}</h2>
          <p className="text-muted-foreground mt-1">
            {t('ruleResources.pageDesc', '下载并管理 sing-box .srs 规则集，供路由规则快速引用')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCatalogOpen(true)}>
            <Library className="me-2 h-4 w-4" />
            {t('ruleResources.library', '资源库')}
          </Button>
          <Button variant="outline" onClick={() => setUrlOpen(true)}>
            <LinkIcon className="me-2 h-4 w-4" />
            {t('ruleResources.manualUrl', 'URL 下载')}
          </Button>
        </div>
      </div>

      {/* GitHub 加速 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('ruleResources.ghProxy', 'GitHub 加速')}</CardTitle>
          <CardDescription>
            {t('ruleResources.ghProxyDesc', '可选，默认直连。下载 GitHub 资源较慢时可选择加速域名')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={selectValue} onValueChange={onSelectGhProxy}>
            <SelectTrigger className="w-full sm:w-[360px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DIRECT}>{t('ruleResources.direct', '直连（不加速）')}</SelectItem>
              {GH_PROXY_PRESETS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>{t('ruleResources.custom', '自定义…')}</SelectItem>
            </SelectContent>
          </Select>
          {customMode && (
            <div className="flex gap-2 sm:w-[360px]">
              <Input
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onBlur={applyCustom}
                onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
                placeholder="https://your-proxy.example/"
                className="font-mono text-sm"
              />
              <Button onClick={applyCustom}>{t('common.confirm', '确定')}</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 自动更新 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('ruleResources.autoUpdate', '自动更新')}</CardTitle>
          <CardDescription>
            {t(
              'ruleResources.autoUpdateDesc',
              '按设定间隔自动重新下载已下载的规则资源（sing-box 不会自动更新本地规则集）'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border/60">
            <SettingsRow label={t('ruleResources.autoUpdate', '自动更新')}>
              <Switch checked={autoUpdate} onCheckedChange={handleAutoUpdateToggle} />
            </SettingsRow>
            {autoUpdate && (
              <SettingsRow label={t('ruleResources.updateInterval', '更新间隔')} stacked>
                <SegmentedControl<string>
                  value={String(intervalHours)}
                  onChange={handleIntervalChange}
                  options={INTERVALS.map((h) => ({
                    value: String(h),
                    label: t(`ruleResources.interval.h${h}`, h < 24 ? `${h} 小时` : `${h / 24} 天`),
                  }))}
                />
              </SettingsRow>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 已下载资源 */}
      <Card>
        <CardHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>{t('ruleResources.downloadedTitle', '已下载资源')}</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleUpdateAll}
                disabled={items.length === 0 || activeRows.length > 0}
              >
                <RefreshCw className="me-2 h-4 w-4" />
                {t('ruleResources.updateAll', '全部更新')}
              </Button>
            </div>
            {/* tab 下沉独占一行，整宽自适应（与「更新间隔」分段控件同款 w-full） */}
            <SegmentedControl<'all' | 'builtin' | 'external'>
              value={listTab}
              onChange={setListTab}
              options={[
                { value: 'all', label: t('ruleResources.listTabAll', '全部') },
                { value: 'builtin', label: t('ruleResources.listTabBuiltin', '内置') },
                { value: 'external', label: t('ruleResources.listTabExternal', '外置') },
              ]}
            />
          </div>
        </CardHeader>
        <CardContent>
          {filteredItems.length === 0 && activeRows.length === 0 && errorRows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {listTab === 'all'
                ? t('ruleResources.empty', '暂无规则资源，点击「资源库」或「URL 下载」添加')
                : t('ruleResources.emptyTab', '该分类下暂无资源')}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ruleResources.colName', '名称')}</TableHead>
                  <TableHead className="w-[110px]">{t('ruleResources.colType', '分类')}</TableHead>
                  <TableHead className="w-[100px]">{t('ruleResources.colSize', '大小')}</TableHead>
                  <TableHead className="w-[110px]">
                    {t('ruleResources.colUpdated', '更新于')}
                  </TableHead>
                  <TableHead className="w-[120px]">{t('ruleResources.colRef', '引用')}</TableHead>
                  <TableHead className="w-[100px] text-end">
                    {t('common.actions', '操作')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* 下载中（临时行，置顶） */}
                {activeRows.map((p) => (
                  <TableRow key={`act-${p.id}`}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell colSpan={4}>
                      <div className="h-1.5 w-full overflow-hidden rounded bg-secondary">
                        <div
                          className={`h-full bg-primary ${p.percent == null ? 'animate-pulse w-1/3' : ''}`}
                          style={p.percent != null ? { width: `${p.percent}%` } : undefined}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {p.status === 'queued'
                          ? t('ruleResources.queued', '等待中…')
                          : p.percent != null
                            ? `${p.percent}%`
                            : formatBytes(p.received)}
                      </span>
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}
                {/* 失败（临时行） */}
                {errorRows.map((p) => (
                  <TableRow key={`err-${p.id}`} className="bg-destructive/5">
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell colSpan={4} className="text-sm text-destructive">
                      {t(
                        `ruleResources.error.${p.errorCode}`,
                        t('ruleResources.downloadAllFailed', '下载失败')
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="sm" onClick={() => dismissError(p.id)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {/* 已下载 */}
                {filteredItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <div className="max-w-[200px] truncate font-medium" title={item.name}>
                          {item.name}
                        </div>
                        {item.builtin && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {t('ruleResources.builtinBadge', '内置')}
                          </Badge>
                        )}
                      </div>
                      {!item.fileExists && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-destructive/15 text-destructive"
                        >
                          {t('ruleResources.missing', '文件缺失')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={RESOURCE_CATEGORY_BADGE[item.category]}>
                        {t(`ruleResources.category.${item.category}`, item.category)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBytes(item.size)}
                    </TableCell>
                    <TableCell
                      className="text-xs text-muted-foreground"
                      title={item.downloadedAt ? new Date(item.downloadedAt).toLocaleString() : ''}
                    >
                      {renderTimeAgo(item.downloadedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.referencedBy > 0
                        ? t('ruleResources.referencedBy', '{{n}} 条规则', {
                            n: item.referencedBy,
                          })
                        : item.builtin
                          ? t('ruleResources.builtinRef', '智能分流')
                          : '—'}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRedownload(item.id)}
                          title={t('ruleResources.update', '更新')}
                        >
                          <RotateCw className="h-4 w-4" />
                        </Button>
                        {item.builtin ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleReset(item)}
                            title={t('ruleResources.reset', '重置为出厂')}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(item)}
                            title={t('ruleResources.delete', '删除')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ResourceCatalogDialog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        presentIds={presentIds}
        builtinItems={items.filter((i) => i.builtin)}
        onDownload={handleDownload}
      />
      <ResourceUrlDialog open={urlOpen} onOpenChange={setUrlOpen} onDownload={handleDownload} />

      <AlertDialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ruleResources.deleteTitle', '删除规则资源')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {t(
                    'ruleResources.deleteReferencedDesc',
                    '「{{name}}」正被以下 {{n}} 项规则引用，删除后将暂时失效（重新下载该资源后自动恢复）：',
                    { name: deleteConfirm?.name, n: deleteConfirm?.rules.length ?? 0 }
                  )}
                </p>
                {/* 分两组、措辞区分后果：路由规则=暂时失效；应用分流=改走智能分流、进程名仍生效（fail-closed 解耦） */}
                {(['route', 'app'] as const).map((kind) => {
                  const group = deleteConfirm?.rules.filter((r) => r.kind === kind) ?? [];
                  if (group.length === 0) return null;
                  return (
                    <div key={kind} className="space-y-1">
                      <p className="text-xs font-medium text-foreground/80">
                        {kind === 'route'
                          ? t('ruleResources.deleteGroupRoute', '路由规则（暂时失效·重下恢复）')
                          : t(
                              'ruleResources.deleteGroupApp',
                              '应用分流（改走智能分流·重下恢复·进程名仍生效）'
                            )}
                      </p>
                      <ul className="max-h-32 space-y-1 overflow-auto rounded-md border bg-muted/30 p-2 text-sm">
                        {group.map((r) => (
                          <li key={`${r.kind}-${r.id}`} className="truncate text-muted-foreground">
                            •{' '}
                            {r.kind === 'app' && r.appBuiltin
                              ? t(`rules.apps.${r.label}` as any, r.label)
                              : r.label}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', '取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('ruleResources.deleteAnyway', '仍要删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
