import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

/**
 * 徽标。全站唯一一套（2026-08-27 批 0 起，手写版 ui/Badge 已删）。
 *
 * 色彩纪律照 DESIGN.md：danger 只给风险与不可逆结论，gold 只做品牌点缀
 * （会员/成就），不拿来做警示或倒计时。
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-[13px] leading-6 font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        primary: 'bg-primary-wash text-primary-ink',
        gold: 'bg-gold-wash text-gold',
        success: 'bg-success-wash text-success-ink',
        amber: 'bg-amber-wash text-amber-ink',
        danger: 'bg-danger-wash text-danger-ink',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

function Badge({
  className,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
