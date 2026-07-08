import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.01em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-flow-weak text-flow-hi',
        secondary: 'border-transparent bg-surface-3 text-fg-dim',
        destructive: 'border-transparent bg-err-weak text-err',
        // 语义状态标（低饱和 tint，非实心）：连接/日志等「状态即色」小 pill 复用，取代各处自绘 span。
        success: 'border-transparent bg-ok-weak text-ok',
        warning: 'border-transparent bg-warn-weak text-warn',
        outline: 'bg-transparent border-hair text-fg-faint',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
