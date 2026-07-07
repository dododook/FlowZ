import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import { ChevronDown, X } from 'lucide-react';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import type { RuleResourceListItem } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import {
  filterResources,
  isResourceSelectable,
  isResourceSelected,
  partitionResources,
  shouldShowSearch,
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

  useEffect(() => {
    // 内置（随包）+ 外置（已下载）都列出：两者都是本地 .srs，均可经 res:<id> 引用（内置 id=builtin:<tag>，
    // 后端 generateCustomRules 解析为随包 runtime 路径）。按 builtin 分组渲染。
    api.ruleResources
      .list()
      .then(setResources)
      .catch(() => {});
  }, []);

  const showSearch = shouldShowSearch(resources.length);

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
      <DropdownMenuCheckboxItem
        key={r.id}
        checked={selected}
        disabled={!selectable}
        // 勾选保持菜单打开（多选）：阻止 radix 默认「选中即关」；toggle 走 onCheckedChange。
        // 用 CheckboxItem（非自绘 Checkbox）拿回 role=menuitemcheckbox + aria-checked（a11y）。
        onSelect={(e) => e.preventDefault()}
        onCheckedChange={() => toggleRes(r.id)}
        className="gap-2"
      >
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
      </DropdownMenuCheckboxItem>
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
        <SearchableDropdown
          open={open}
          onOpenChange={setOpen}
          triggerClassName="h-10"
          contentClassName="max-h-[300px] w-[var(--radix-dropdown-menu-trigger-width)]"
          showSearch={showSearch}
          query={query}
          onQueryChange={setQuery}
          searchIcon
          searchPlaceholder={t('ruleResources.picker.search', '搜索规则集')}
          isEmpty={builtin.length === 0 && external.length === 0}
          emptyText={t('ruleResources.picker.noMatch', '无匹配规则集')}
          trigger={
            <>
              <span
                className={`min-w-0 flex-1 truncate ${value.length === 0 ? 'text-muted-foreground' : 'font-medium'}`}
              >
                {summary}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </>
          }
          footer={
            <button
              type="button"
              onClick={goToResources}
              className="mt-1 block w-full rounded-md px-2 py-1.5 text-start text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-primary"
            >
              {t('ruleResources.picker.manageMore', '前往「规则资源」下载更多 →')}
            </button>
          }
        >
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
        </SearchableDropdown>
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
