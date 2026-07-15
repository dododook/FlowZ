import { cn } from '@/lib/utils';

interface ProgressProps {
  /** 0–100 百分比；null/undefined = 不确定态（无 total 时的脉冲动画）。 */
  value?: number | null;
  className?: string;
}

/**
 * 统一进度条（下载 / 更新共用一套，样式对齐应用更新进度条）。
 * 确定态按 `value` 取宽度，不确定态显 1/3 宽脉冲条。
 */
export function Progress({ value, className }: ProgressProps) {
  const indeterminate = value == null;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-all duration-300 ease-out',
          indeterminate && 'w-1/3 animate-pulse'
        )}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
