'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

/**
 * 尺寸对齐 DESIGN.md：主操作 48px、次级 44px（触屏目标 ≥44）。
 * danger 只用于不可逆操作的确认按钮。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] font-medium whitespace-nowrap outline-none transition-[opacity,background-color,border-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
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
