import * as React from 'react';
import { cn } from './utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-12 w-full rounded-[10px] border border-input bg-muted px-3 text-[16px] text-foreground outline-none',
        'placeholder:text-muted-foreground/70 transition-colors duration-150 ease-out',
        'focus:border-primary focus-visible:ring-2 focus-visible:ring-ring',
        'aria-invalid:border-destructive',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
