import { Fragment, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { SearchableDropdown } from '@/components/ui/searchable-dropdown';
import {
  enterSelection,
  filterItems,
  findItem,
  groupItems,
  latencyTone,
  shouldShowSearch,
  LATENCY_TONE_TEXT_CLASS,
  type DotTone,
  type NodePickerGroup,
  type NodePickerItem,
} from './node-picker-logic';

export type { NodePickerGroup, NodePickerItem } from './node-picker-logic';

const DOT_CLASS: Record<DotTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-destructive',
  mesh: 'bg-primary',
  idle: 'bg-muted-foreground/50',
};

/** 缺省状态点色：direct/none → idle；不可测（组网）→ mesh 青；否则由延迟色档映射。 */
function dotToneOf(item: NodePickerItem): DotTone {
  if (item.dotTone) return item.dotTone;
  if (item.role === 'direct' || item.role === 'none' || item.role === 'follow') return 'idle';
  if (item.latencyNA) return 'mesh';
  const tone = latencyTone(item.latency, item.latencyNA);
  return tone === 'good' ? 'ok' : tone === 'medium' ? 'warn' : tone === 'bad' ? 'err' : 'idle';
}

/** 延迟徽标（数值 + 色档 / 超时 / N/A）；未测且非 N/A → 不渲染（与 SpeedBadge 口径一致）。 */
function LatencyLabel({ item, className }: { item: NodePickerItem; className?: string }) {
  const { t } = useTranslation();
  if (item.latencyNA) {
    return (
      <span className={cn('shrink-0 text-xs text-muted-foreground', className)}>
        {t('servers.speedTestNotApplicable', 'N/A')}
      </span>
    );
  }
  if (item.latency === undefined) return null;
  const label = item.latency < 0 ? t('servers.timeout', '超时') : `${item.latency} ms`;
  return (
    <span
      className={cn(
        'shrink-0 font-mono text-xs font-medium tabular-nums',
        LATENCY_TONE_TEXT_CLASS[latencyTone(item.latency)],
        className
      )}
    >
      {label}
    </span>
  );
}

export interface NodePickerProps {
  /** 已算好的节点项（含延迟/协议/地址/groupId）。 */
  items: NodePickerItem[];
  /** 有序分组定义；缺省/单一来源 → 平铺不显分组头。 */
  groups?: NodePickerGroup[];
  /** 当前选中 id（触发器回填 + 选项 ✓）。 */
  value?: string | null;
  /** 选中回调（一步选中即触发，菜单随即关闭）。 */
  onSelect: (id: string) => void;
  /** 未选占位。 */
  placeholder?: string;
  /** 触发器尺寸：lg 用于首页出口，default 用于表单内选择。 */
  size?: 'default' | 'lg';
  disabled?: boolean;
  className?: string;
  /** 超过此数量才显搜索框（默认 6）。 */
  searchThreshold?: number;
  searchPlaceholder?: string;
  /** 无匹配文案。 */
  emptyText?: string;
  /** 触发器是否显示地址副文本（首页 lg 用）。 */
  showAddress?: boolean;
  ariaLabel?: string;
}

/**
 * 一步选节点下拉（`.npick`）—— 基于 radix `dropdown-menu` 组合（非从零造）：点触发即下拉、点选项即选中并关闭。
 * 特性：分组（无分组桶置顶 + 有序分组头）、延迟色档、✓ 当前、多节点自动搜索、宽度按内容（min=触发器宽、
 * 上限 420px、长名截断不换行）、键盘可达（Esc 关 / 方向键进列表 / 项 Enter 选中）、双主题（走 token）。
 * 数据源解耦：只吃 items + groups + value + onSelect，供首页/应用分流/规则/组网各「选出口」场景共用。
 */
export function NodePicker({
  items,
  groups,
  value,
  onSelect,
  placeholder,
  size = 'default',
  disabled,
  className,
  searchThreshold = 6,
  searchPlaceholder,
  emptyText,
  showAddress,
  ariaLabel,
}: NodePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const current = findItem(items, value);
  const showSearch = shouldShowSearch(items.length, searchThreshold);
  const filtered = query ? filterItems(items, query) : items;
  const sections = groupItems(filtered, groups);
  // 多段（>1）才显分组头：置顶「无分组」桶 + 各有序分组段。
  const multiSection = sections.length > 1;

  return (
    <SearchableDropdown
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      triggerAriaLabel={ariaLabel}
      // 宽度按内容：至少触发器宽、内容撑到 max-content、封顶 420px（长名在选项内截断）。
      contentClassName="max-h-[280px] w-max min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[min(420px,calc(100vw-3rem))]"
      triggerClassName={cn(size === 'lg' ? 'h-11' : 'h-10', className)}
      showSearch={showSearch}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={searchPlaceholder ?? t('common.search', '搜索')}
      // Enter 选中当前首个结果（分组后视觉第一项）→ 搜到即回车确认；enterSelection 挡下空 query 的裸 Enter，
      // 杜绝误选顶部哨兵（None / 直连 / 跟随全局）静默清空已配置出口。
      onSearchEnter={() => {
        const first = enterSelection(query, sections);
        if (first) {
          onSelect(first.id);
          setOpen(false);
        }
      }}
      isEmpty={sections.length === 0}
      emptyText={emptyText ?? t('common.noResults', '无匹配')}
      trigger={
        current ? (
          <>
            <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[dotToneOf(current)])} />
            <span
              className={cn('min-w-0 truncate font-medium', size === 'lg' && 'text-[0.95rem]')}
              title={current.name}
            >
              {current.name}
            </span>
            {current.protocol && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                {current.protocol}
              </span>
            )}
            {showAddress && current.address && (
              <span className="hidden min-w-0 shrink truncate font-mono text-[11px] text-muted-foreground/70 sm:inline">
                {current.address}
              </span>
            )}
            <LatencyLabel item={current} className="ms-auto" />
            <ChevronDown className="ms-1 h-4 w-4 shrink-0 opacity-50" />
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {placeholder ?? t('home.selectServer')}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </>
        )
      }
    >
      {sections.map((sec) => (
        <Fragment key={sec.group?.id ?? '__ungrouped'}>
          {sec.group && multiSection && (
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {sec.group.label}
            </div>
          )}
          {sec.items.map((item) => {
            const selected = item.id === value;
            return (
              <DropdownMenuItem
                key={item.id}
                disabled={item.disabled}
                onSelect={() => onSelect(item.id)}
                className={cn(
                  'gap-2',
                  selected && 'bg-primary/10 text-primary focus:bg-primary/15 focus:text-primary'
                )}
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[dotToneOf(item)])} />
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                {item.note && (
                  <span className="shrink-0 text-xs text-muted-foreground">{item.note}</span>
                )}
                {item.protocol && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                    {item.protocol}
                  </span>
                )}
                <LatencyLabel item={item} />
                <Check
                  className={cn(
                    'ms-0.5 h-4 w-4 shrink-0 text-primary',
                    selected ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </DropdownMenuItem>
            );
          })}
        </Fragment>
      ))}
    </SearchableDropdown>
  );
}
