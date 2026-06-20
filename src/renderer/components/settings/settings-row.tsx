import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { InfoTooltip } from './shared/info-tooltip';

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** 标签右侧 ⓘ 悬浮里的完整说明（密度瘦身：可见副文案留精简引子，长解释收进此处）。 */
  tooltip?: ReactNode;
  /** 右侧控件（Switch / Select / Input / Button 等） */
  children?: ReactNode;
  /** 控件需换到下一行（如长输入框、密钥行）时设 true：标签在上、控件全宽在下 */
  stacked?: boolean;
  /** 分组标题行（加粗、无右侧控件） */
  heading?: boolean;
  className?: string;
}

/** 标签 + 可选 ⓘ 行（tooltip 存在时横排在 label 右侧）。 */
function RowLabel({ label, tooltip }: { label: ReactNode; tooltip?: ReactNode }) {
  return (
    <div className={cn('text-sm font-medium', tooltip && 'flex items-center gap-1.5')}>
      {tooltip ? <span>{label}</span> : label}
      {tooltip && <InfoTooltip content={tooltip} />}
    </div>
  );
}

/**
 * 统一的设置行：左侧标签 + 副文案，右侧控件（macOS 系统设置范式）。
 * 卡片内用 `divide-y divide-border/60` 串联多行，替代零散的 border-t + ml-6 缩进，跨平台一致。
 */
export function SettingsRow({
  label,
  description,
  tooltip,
  children,
  stacked,
  heading,
  className,
}: SettingsRowProps) {
  if (heading) {
    return <div className={cn('pb-1 pt-3 text-sm font-semibold', className)}>{label}</div>;
  }
  if (stacked) {
    return (
      <div className={cn('space-y-2 py-3', className)}>
        <div>
          <RowLabel label={label} tooltip={tooltip} />
          {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className={cn('flex items-center justify-between gap-4 py-3', className)}>
      <div className="min-w-0">
        <RowLabel label={label} tooltip={tooltip} />
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
