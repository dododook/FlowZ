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
  /** 分组标题行（渲染为卡内 .set-h 头，加粗、无右侧控件） */
  heading?: boolean;
  className?: string;
}

function RowLabel({ label, tooltip }: { label: ReactNode; tooltip?: ReactNode }) {
  return (
    <div className="srow-lbl">
      {tooltip ? <span>{label}</span> : label}
      {tooltip && <InfoTooltip content={tooltip} />}
    </div>
  );
}

/**
 * 统一设置行（macOS 系统设置范式，左标签+右控件）；卡内相邻 .srow 由 conduit `.srow + .srow` 规则自动生成分隔线，无需 divide-y 包裹。
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
    return (
      <div className={cn('set-h', className)}>
        <b>{label}</b>
      </div>
    );
  }
  if (stacked) {
    return (
      <div className={cn('srow stacked', className)}>
        <div className="srow-main">
          <RowLabel label={label} tooltip={tooltip} />
          {description && <div className="srow-desc">{description}</div>}
        </div>
        {children && <div className="srow-ctl">{children}</div>}
      </div>
    );
  }
  return (
    <div className={cn('srow', className)}>
      <div className="srow-main">
        <RowLabel label={label} tooltip={tooltip} />
        {description && <div className="srow-desc">{description}</div>}
      </div>
      {children && <div className="srow-ctl">{children}</div>}
    </div>
  );
}
