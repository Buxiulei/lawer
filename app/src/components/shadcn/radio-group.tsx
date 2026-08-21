'use client';

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cn } from './utils';

/**
 * 单选组。用 Radix 而不是一排 aria-checked 的 button，图的是 roving tabindex：
 * 一组单选在 Tab 序里只占**一个**停靠点，组内用方向键走——
 * 手写版让八个类别按钮各占一个 Tab 停靠点，键盘用户要按八下才能过去。
 */
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('flex flex-wrap gap-2', className)}
      {...props}
    />
  );
}

/**
 * 药丸形状的单选项（选中＝主色淡底 + 主色边）。
 * 触区 44px 起，照 DESIGN.md 的触屏目标下限。
 */
function RadioGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'min-h-11 rounded-[10px] border px-3.5 text-[15px] font-medium',
        'transition-colors duration-150 ease-out',
        'border-border bg-card text-muted-foreground hover:bg-muted',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary-wash data-[state=checked]:text-primary-ink',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
