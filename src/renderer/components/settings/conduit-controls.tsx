import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Conduit 设置面板原语（`.srow` / `.swt` / `.set-collapse`）——仅供本 settings/* 面板 1:1 移植消费。
 * 与 agent D 的 SettingsRow/SettingsCollapsible 解耦：原型卡结构（.set-h 标题、.set-collapse 折叠、
 * .excl、.ng-group、.danger-zone、.ctl-group）无法经既有 SettingsRow API 表达，故本组以原型 DOM 为准自绘。
 */

/** Conduit `.srow`：左侧标签+副文案，右侧控件；`stacked` 时控件换行全宽。 */
export function Srow({
  label,
  desc,
  stacked,
  children,
  className,
}: {
  label: ReactNode;
  desc?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('srow', stacked && 'stacked', className)}>
      <div className="srow-main">
        <div className="srow-lbl">{label}</div>
        {desc != null && desc !== '' && <div className="srow-desc">{desc}</div>}
      </div>
      {children != null && children !== false && <div className="srow-ctl">{children}</div>}
    </div>
  );
}

/** Conduit `.swt` 开关按钮（受控）。 */
export function Swt({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={cn('swt', checked && 'on')}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * Conduit `.set-collapse` 折叠块。受控 `open` + `onToggle`（防 config 重渲把用户折叠态弹回，同 logs-page）。
 * `className` 传 `nested` / `flush` 走原型变体。
 */
export function Collapse({
  summary,
  defaultOpen,
  className,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <details
      className={cn('set-collapse', className)}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="sc-label">{summary}</span>
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="sc-body">{children}</div>
    </details>
  );
}
