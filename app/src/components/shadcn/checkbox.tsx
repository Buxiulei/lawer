'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cn } from './utils';
import { CheckIcon } from './icons';

/**
 * 框本体 20×20，触区 44×44——**扩区归控件自己**。
 *
 * `before:-inset-3` 的伪元素往四周各扩 12px（20+12+12=44），它不参与布局，
 * 所以调用方的行高、间距一行都不用改。
 * 在此之前扩区是由调用方"包一层 min-h-11 min-w-11 的 div"负责的，
 * 那层只做视觉居中、不转发点击：真实可点范围一直是 20×20（审查台账 SYS-03）。
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative size-5 shrink-0 rounded-[6px] border border-ink-2/50 bg-card',
        'before:absolute before:-inset-3',
        'transition-colors duration-150 ease-out',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
