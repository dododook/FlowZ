/**
 * 轻量按钮说明 tooltip（radix Tooltip）——用于 icon-only 交互按钮的「功能识别」说明。
 * 取代原生 `title=`（Electron 下不稳、经常不弹、一排小图标扫视无跨元素宽限期，见 unlock-inline.tsx:66 前例）。
 * 富内容/预览卡仍用 HoverCard（InfoTooltip 等）；本组件专职「按钮做什么」的短说明。
 *
 * 统一延迟单一真值 TOOLTIP_OPEN_DELAY_MS=500（= 解锁 AI 点 openDelay，全库对齐）。TooltipProvider 挂 App 根，
 * skipDelayDuration 让「扫到相邻按钮」即时弹出（治「一排图标扫视不弹」的主诉求）。
 */
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/** 停留多久弹出按钮说明（ms）。单一真值——与解锁检测 AI 点一致（0.5s）。 */
export const TOOLTIP_OPEN_DELAY_MS = 500;
/** 关闭一个 tooltip 后此窗口内再 hover 相邻触发器即时弹（无需重等 delay）——治扫视一排 icon 按钮的卡顿。 */
export const TOOLTIP_SKIP_DELAY_MS = 300;

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-56 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md outline-none data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/**
 * icon 按钮说明便捷封装：`<ActionTip label="测速"><button aria-label="测速">…</button></ActionTip>`。
 * children 须是可接收 ref+事件的单元素（asChild）。**调用方仍须给按钮 aria-label**（tooltip 非 accessible name，
 * 屏幕阅读器不读 tooltip 内容）——迁移时把原 title 的值同时放 aria-label。
 * disabled 按钮不派发 pointer 事件 → tooltip 不弹：调用方用 <span> 包一层承接 hover（见 unlock-inline.tsx:117 先例）。
 */
export function ActionTip({
  label,
  children,
  side,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
