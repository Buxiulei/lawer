import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

/**
 * 页内提示块（登录失效、加载失败这类）。不是 toast，不会自己消失。
 *
 * tone 只开三档：默认（中性告知）、amber（要留意但没坏）、danger（真出错了）。
 * 色彩纪律照 DESIGN.md，小号文字一律走 *-ink 伴生色，保证浅底对比度。
 */
const alertVariants = cva(
  'rounded-[12px] border px-4 py-3.5',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-card text-foreground',
        amber: 'border-transparent bg-amber-wash text-foreground',
        danger: 'border-transparent bg-danger-wash text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

function Alert({
  className,
  tone,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ tone }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="alert-title"
      className={cn('text-[15px] leading-7 font-medium text-foreground', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="alert-description"
      className={cn('text-[14px] leading-6 text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
