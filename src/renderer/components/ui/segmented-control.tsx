import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** 悬停提示（如模式说明） */
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * OpenClash 风格的分段切换控件（一行多按钮，单选高亮）。
 * 用于首页「接管方式 / 分流策略」两行快速切换。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn('inline-flex w-full gap-1 rounded-lg bg-muted p-1', className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            disabled={disabled || opt.disabled}
            onClick={() => !active && onChange(opt.value)}
            className={cn(
              // whitespace-nowrap：禁止「TUN 网卡」等含空格标签在窄列里从空格处折行（双列布局下曾断成两行）。
              'flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-50',
              active
                ? 'bg-white text-foreground shadow-sm dark:bg-card'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
