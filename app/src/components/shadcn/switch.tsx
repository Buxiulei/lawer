'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from './utils';

/** 轨道 48×28，外层触区由调用方给到 44px（DESIGN.md 触屏目标） */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent outline-none',
        'transition-colors duration-150 ease-out',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-border',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-5 rounded-full bg-card shadow-soft ring-0',
          'transition-transform duration-150 ease-out',
          'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
