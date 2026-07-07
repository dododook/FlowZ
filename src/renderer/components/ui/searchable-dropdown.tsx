import { useEffect, useRef, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** 触发器按钮基座样式（node-picker / resource-picker 共用）：边框 + muted 底 + hover/focus/open 态；各 picker 附加高度/尺寸/宽度。 */
const TRIGGER_BASE =
  'flex w-full items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-start text-sm ring-offset-background transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-primary/55';

export interface SearchableDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** 触发器内部内容（各 picker 自绘：显选中详情 / 摘要）。 */
  trigger: ReactNode;
  /** 触发器按钮附加 class（高度 / 尺寸 / 宽度差异）。 */
  triggerClassName?: string;
  triggerAriaLabel?: string;
  /** 是否显搜索框（各 picker 按项数阈值算）。 */
  showSearch?: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder?: string;
  /** 搜索框前缀放大镜图标（resource-picker 用；node-picker 不显）。 */
  searchIcon?: boolean;
  /**
   * 搜索框 Enter 选中回调——单选 picker 传入以支持「搜到即回车确认」。空 query 的裸 Enter 由回调内部 gate
   * （enterSelection）挡下：不选顶部哨兵，避免误清空已配置。多选 picker（resource）不传 → Enter 无副作用。
   */
  onSearchEnter?: () => void;
  /** 面板内容附加 class（宽度 / max-h 差异）。 */
  contentClassName?: string;
  /** 是否空（显空态文案而非分组项）。 */
  isEmpty?: boolean;
  emptyText: ReactNode;
  /** 分组项（item-render + 选择模式由各 picker 自绘）。 */
  children: ReactNode;
  /** 面板底部附加（如「前往规则资源」跳转）。 */
  footer?: ReactNode;
}

/**
 * 「可搜索下拉」共享壳——抽出 node-picker / resource-picker 逐字节重复的：触发器按钮、搜索框（含 radix
 * typeahead 抑制 onKeyDown + rAF 夺焦 + 关闭清空 query）、面板容器、空态。item 渲染与选择模式（单选
 * DropdownMenuItem / 多选 DropdownMenuCheckboxItem）留各 picker 经 children 注入。
 * Enter 选中经 onSearchEnter 路由，空 query gate 由回调内部（enterSelection）统一，两 picker 行为一致。
 */
export function SearchableDropdown({
  open,
  onOpenChange,
  disabled,
  trigger,
  triggerClassName,
  triggerAriaLabel,
  showSearch,
  query,
  onQueryChange,
  searchPlaceholder,
  searchIcon,
  onSearchEnter,
  contentClassName,
  isEmpty,
  emptyText,
  children,
  footer,
}: SearchableDropdownProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 关闭时清空查询（下次打开回全量）；打开且有搜索框时把焦点交给输入框（rAF 让 radix 默认聚焦首项先跑，再夺回）。
  useEffect(() => {
    if (!open) {
      onQueryChange('');
      return;
    }
    if (showSearch) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, showSearch, onQueryChange]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={triggerAriaLabel}
          className={cn(TRIGGER_BASE, triggerClassName)}
        >
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn('overflow-y-auto p-1.5', contentClassName)}>
        {showSearch && (
          <div className="mb-1 px-1 pt-0.5">
            <div className="relative">
              {searchIcon && (
                <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              )}
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                // Enter → onSearchEnter（单选 picker 选首个匹配；空 query gate 在回调内 enterSelection）。
                // 阻止其余 printable 键冒泡触发 radix typeahead（会抢焦点）；放行 Esc(关) / 方向键(进列表)。
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (onSearchEnter) {
                      e.preventDefault();
                      onSearchEnter();
                    }
                    return;
                  }
                  if (e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
                    e.stopPropagation();
                  }
                }}
                className={cn(
                  'h-8 text-xs focus-visible:border-primary focus-visible:ring-offset-0 md:text-xs',
                  searchIcon ? 'ps-8' : 'px-2.5'
                )}
              />
            </div>
          </div>
        )}
        {isEmpty ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText}</div>
        ) : (
          children
        )}
        {footer}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
