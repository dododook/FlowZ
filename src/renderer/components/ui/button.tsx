import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-lg border border-transparent text-[13px] font-[560] ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-flow text-white hover:bg-flow-hi',
        destructive:
          'bg-err-weak text-err border border-err/30 hover:bg-err/15 hover:border-err/50',
        outline:
          'border border-hair bg-transparent text-fg-dim hover:bg-surface-2 hover:border-line',
        secondary: 'bg-surface-2 text-fg-dim hover:bg-surface-3',
        ghost: 'text-fg-dim hover:bg-surface-2 hover:text-fg',
        link: 'text-flow underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[33px] px-[15px] text-[13px]',
        sm: 'h-[28px] px-[11px] text-xs',
        lg: 'h-[38px] px-6',
        icon: 'h-[33px] w-[33px] p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
