import * as React from 'react';
import { cn } from './utils';

/** 纯装饰分隔线，一个 div 就够，不为它引 @radix-ui/react-separator */
function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      role="none"
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
