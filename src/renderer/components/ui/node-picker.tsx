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

/** 协议角标（Conduit `.pill.proto`：flow-weak 底 + flow-hi 字）；置于状态点后、名称前——测速延迟恒靠右，
 *  协议前置避免「名称 + 协议 + 延迟」三段挤在右侧导致排版抖动（用户反馈）。 */
function ProtoPill({ protocol }: { protocol?: string }) {
  if (!protocol) return null;
  return (
    <span className="shrink-0 rounded-md bg-flow-weak px-2 py-0.5 text-[10.5px] font-semibold text-flow-hi">
      {protocol}
    </span>
  );
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
 * 特性：分组（无分组桶置顶 + 有序分组头，**分组可折叠**）、协议角标前置、延迟色档、✓ 当前、多节点自动搜索、
 * 宽度按内容（min=触发器宽、上限 420px、长名截断不换行）、键盘可达（Esc 关 / 方向键进列表 / 项 Enter 选中）、双主题（走 token）。
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
  // 分组折叠态（按 group.id）；默认全展开，点击组头 toggle。搜索时忽略折叠（全展以免藏结果）。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const current = findItem(items, value);
  // 所选节点归属的组默认展开、其余组默认折叠（用户反馈）；用户手动 toggle 后以 collapsed[gid] 覆盖默认。
  const selectedGroupId = current?.groupId;
  // toggle「当前生效折叠态」而非裸 collapsed[id]：默认折叠组 collapsed[id]=undefined，`!undefined=true` 会让首点
  // 仍折叠（需点两次）；故对生效态 `collapsed[id] ?? (id !== selectedGroupId)` 取反。
  const toggleGroup = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? id !== selectedGroupId) }));
  const showSearch = shouldShowSearch(items.length, searchThreshold);
  const searching = query.trim().length > 0;
  const filtered = searching ? filterItems(items, query) : items;
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
      // Conduit `.npick-trig` 观感：surface-2 实底 + line 描边（覆盖壳的 muted/40 + input）。
      triggerClassName={cn(
        'gap-[9px] rounded-[9px] border-line bg-surface-2',
        size === 'lg' ? 'h-11' : 'h-10',
        className
      )}
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
            <ProtoPill protocol={current.protocol} />
            <span
              className={cn(
                'min-w-0 truncate font-medium',
                size === 'lg' ? 'text-[14px] font-semibold' : 'text-[12.5px]'
              )}
              title={current.name}
            >
              {current.name}
            </span>
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
      {sections.map((sec) => {
        const gid = sec.group?.id;
        // 组头可折叠：仅在多段 + 有 group 时渲染；搜索态强制展开。
        // 默认：仅展开所选节点所属组，其余折叠；选中「默认节点/跟随全局」哨兵（无 group）或未选 → 全组折叠保持整洁。
        // collapsed[gid] 有值（用户点过）则覆盖默认。搜索态强制全展。
        const isCollapsed =
          !!gid && !searching && (collapsed[gid] ?? gid !== selectedGroupId);
        return (
          <Fragment key={gid ?? '__ungrouped'}>
            {sec.group && multiSection && (
              <button
                type="button"
                // 组头非 DropdownMenuItem：点击只折叠、不选中、不关菜单。
                onClick={(e) => {
                  e.preventDefault();
                  toggleGroup(sec.group!.id);
                }}
                className="flex w-full items-center gap-1.5 px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-fg-faint hover:text-fg-dim"
                aria-expanded={!isCollapsed}
              >
                <ChevronDown
                  className={cn(
                    'h-3 w-3 shrink-0 transition-transform',
                    isCollapsed && '-rotate-90'
                  )}
                />
                <span className="truncate">{sec.group.label}</span>
              </button>
            )}
            {!isCollapsed &&
              sec.items.map((item) => {
                const selected = item.id === value;
                return (
                  <DropdownMenuItem
                    key={item.id}
                    disabled={item.disabled}
                    onSelect={() => onSelect(item.id)}
                    className={cn(
                      'gap-2',
                      selected &&
                        'bg-accent text-accent-foreground focus:bg-accent focus:text-accent-foreground'
                    )}
                  >
                    <span
                      className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[dotToneOf(item)])}
                    />
                    <ProtoPill protocol={item.protocol} />
                    <span className="min-w-0 flex-1 truncate" title={item.name}>
                      {item.name}
                    </span>
                    {item.note && (
                      <span className="shrink-0 text-xs text-muted-foreground">{item.note}</span>
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
        );
      })}
    </SearchableDropdown>
  );
}
