'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

/**
 * 尺寸对齐 DESIGN.md：主操作 48px、次级 44px（触屏目标 ≥44）。
 * danger 只用于不可逆操作的确认按钮。
 *
 * 禁用态**不用整体 opacity**：那会把底和字一起冲淡，红底白字降到 45% 实测只剩
 * 2.35:1，而底和字各自降多少不受控。改成显式的一对 token（--disabled-surface /
 * --disabled-ink，深浅各一组，实测 4.32 / 4.09），底与字分开定。
 * 五个 variant 共用这一组：禁用后本就不该再靠颜色区分自己原来是主按钮还是次按钮。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] font-medium whitespace-nowrap transition-[opacity,background-color,border-color] duration-150 ease-out disabled:pointer-events-none disabled:bg-disabled-surface disabled:text-disabled-ink [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90 active:opacity-80',
        secondary: 'border border-border bg-card text-foreground hover:bg-muted',
        ghost: 'bg-transparent text-primary-ink hover:bg-primary-wash',
        outline: 'border border-border bg-transparent text-foreground hover:bg-muted',
        danger:
          'bg-destructive text-destructive-foreground hover:opacity-90 active:opacity-80',
      },
      size: {
        md: 'h-12 px-5 text-[16px]',
        sm: 'h-11 px-4 text-[15px]',
        icon: 'size-11',
        'icon-sm': 'size-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
