'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from './utils';

/**
 * 轨道 48×28，触区 72×52——**扩区归控件自己**，不是"由调用方给到 44px"。
 *
 * `before:-inset-3` 的伪元素往四周各扩 12px，不参与布局。
 * 原来这行注释把责任推给调用方，而调用方那层 `size-11` 的 div 只做视觉居中、
 * 不转发点击，真实可点范围一直是 48×28（审查台账 SYS-03）。
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent',
        'before:absolute before:-inset-3',
        'transition-colors duration-150 ease-out',
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
