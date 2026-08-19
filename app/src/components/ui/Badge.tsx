import type { ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'amber' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  primary: 'bg-primary-wash text-primary-ink',
  success: 'bg-success-wash text-success',
  amber: 'bg-amber-wash text-amber',
  danger: 'bg-danger-wash text-danger',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[13px] leading-6 font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
