import * as React from 'react';
import { cn } from './utils';

/** 原生 label 就够，不为它引 @radix-ui/react-label */
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'text-[14px] font-medium text-foreground select-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
