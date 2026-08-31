import * as React from 'react';
import { cn } from './utils';

/** 与 input.tsx 同一套底/边/焦点，只是高度跟着 rows 走。 */
function Textarea({ className, rows = 4, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      rows={rows}
      data-slot="textarea"
      className={cn(
        'w-full resize-y rounded-[10px] border border-input bg-muted px-3 py-2.5 text-[16px] leading-7 text-foreground',
        'placeholder:text-muted-foreground/70 transition-colors duration-150 ease-out',
        'focus:border-focus-ring focus:outline-none',
        'aria-invalid:border-destructive',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
