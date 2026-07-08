import * as React from 'react';

import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-[33px] w-full rounded-lg border border-line bg-surface-2 px-[11px] py-[7px] text-[13px] text-fg file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-flow disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
