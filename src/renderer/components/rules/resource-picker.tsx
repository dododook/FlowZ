import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, Search, X } from 'lucide-react';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import type { RuleResourceListItem } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import {
  filterResources,
  isResourceSelectable,
  isResourceSelected,
  partitionResources,
  shouldShowResourceSearch,
  toggleResourceRef,
} from './resource-picker-logic';

interface ResourcePickerProps {
  /** ruleSet 规则的 values：res:<id>（本地资源，内置随包 + 已在「规则资源」页下载）。
   *  fail-closed：远程 URL 能力已移除——所有 srs 统一由规则资源管理，运行期零远程下载。 */
  value: string[];
  onChange: (values: string[]) => void;
  /** 选「前往规则资源页」前先关闭弹窗 */
  onRequestClose?: () => void;
}

/**
 * 规则集「下拉复选」：收起态触发器显已选摘要，展开为可搜索、按内置/外置分组的多选面板，底部「前往规则资源」跳转。
 * 基于 radix dropdown-menu + checkbox（参考 .npick 模式）：勾选不关菜单（onSelect preventDefault）、多节点显搜索。
 * fail-closed 交互（文件缺失且未引用不可新选）、已选 chips、跳转均沿旧 ResourcePicker 语义，仅呈现改为下拉。
 */
export function ResourcePicker({ value, onChange, onRequestClose }: ResourcePickerProps) {
  const { t } = useTranslation();
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const [resources, setResources] = useState<RuleResourceListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 内置（随包）+ 外置（已下载）都列出：两者都是本地 .srs，均可经 res:<id> 引用（内置 id=builtin:<tag>，
    // 后端 generateCustomRules 解析为随包 runtime 路径）。按 builtin 分组渲染。
    api.ruleResources
      .list()
      .then(setResources)
      .catch(() => {});
  }, []);

  const showSearch = shouldShowResourceSearch(resources.length);

  // 关闭时清空查询；打开且有搜索框时把焦点交给输入框（rAF 让 radix 默认聚焦先跑，再夺回）。
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (showSearch) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, showSearch]);

  const toggleRes = (id: string) => onChange(toggleResourceRef(value, id));
  const remove = (v: string) => onChange(value.filter((x) => x !== v));
  const resName = (id: string) => resources.find((r) => r.id === id)?.name;

  const goToResources = () => {
    onRequestClose?.();
    setCurrentView('ruleResources');
  };

  const filtered = filterResources(resources, query);
  const { builtin, external } = partitionResources(filtered);
  const summary =
    value.length > 0
      ? t('ruleResources.picker.summary', {
          count: value.length,
          defaultValue: '已选 {{count}} 个规则集',
        })
      : t('ruleResources.picker.placeholder', '选择规则集');

  const renderRow = (r: RuleResourceListItem) => {
    const selected = isResourceSelected(value, r.id);
    const selectable = isResourceSelectable(r, selected);
    return (
      <DropdownMenuItem
        key={r.id}
        disabled={!selectable}
        // 勾选保持菜单打开（多选）：阻止 radix 默认「选中即关」。
        onSelect={(e) => {
          e.preventDefault();
          toggleRes(r.id);
        }}
        className="gap-3"
      >
        <Checkbox checked={selected} className="pointer-events-none" tabIndex={-1} />
        <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
        {!r.fileExists && (
          <Badge
            variant="outline"
            className="border-transparent bg-destructive/15 text-xs text-destructive"
          >
            {t('ruleResources.missing', '文件缺失')}
          </Badge>
        )}
        <Badge variant="outline" className="text-xs">
          {t(`ruleResources.category.${r.category}`, r.category)}
        </Badge>
      </DropdownMenuItem>
    );
  };

  return (
    <div className="space-y-3">
      {resources.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center">
          <p className="mb-2 text-sm text-muted-foreground">
            {t('ruleResources.picker.empty', '尚无已下载资源')}
          </p>
          <Button variant="outline" size="sm" onClick={goToResources}>
            {t('ruleResources.picker.goDownload', '前往规则资源页')}
          </Button>
        </div>
      ) : (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-start text-sm ring-offset-background transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:border-primary/55"
            >
              <span
                className={`min-w-0 flex-1 truncate ${value.length === 0 ? 'text-muted-foreground' : 'font-medium'}`}
              >
                {summary}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[300px] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto p-1.5"
          >
            {showSearch && (
              <div className="mb-1 px-1 pt-0.5">
                <div className="relative">
                  <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    // 阻止 printable 键冒泡触发 radix typeahead（会抢焦点）；放行 Esc(关)/方向键(进列表)。
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
                        e.stopPropagation();
                      }
                    }}
                    placeholder={t('ruleResources.picker.search', '搜索规则集')}
                    className="w-full rounded-md border border-input bg-muted/40 py-1.5 ps-8 pe-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>
            )}
            {builtin.length === 0 && external.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t('ruleResources.picker.noMatch', '无匹配规则集')}
              </div>
            ) : (
              <>
                {builtin.length > 0 && (
                  <>
                    <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('ruleResources.picker.groupBuiltin', '内置 · 随包')}
                    </div>
                    {builtin.map(renderRow)}
                  </>
                )}
                {external.length > 0 && (
                  <>
                    <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('ruleResources.picker.groupExternal', '已下载')}
                    </div>
                    {external.map(renderRow)}
                  </>
                )}
              </>
            )}
            <button
              type="button"
              onClick={goToResources}
              className="mt-1 block w-full rounded-md px-2 py-1.5 text-start text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-primary"
            >
              {t('ruleResources.picker.manageMore', '前往「规则资源」下载更多 →')}
            </button>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* 已选 chips（仅 res:<id> 本地引用；旧配置遗留的裸 URL 值仍可在此移除） */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const isRes = v.startsWith('res:');
            const id = v.slice(4);
            const name = isRes ? resName(id) : v;
            const deleted = isRes && !name;
            return (
              <span
                key={v}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                  deleted ? 'border-destructive/40 text-destructive' : 'bg-muted'
                }`}
              >
                <span className="max-w-[180px] truncate">
                  {isRes ? name || t('ruleResources.picker.deletedBadge', '已删除') : v}
                </span>
                {isRes && !deleted && (
                  <Badge variant="outline" className="h-4 px-1 text-[10px]">
                    {t('ruleResources.picker.localBadge', '本地')}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => remove(v)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
