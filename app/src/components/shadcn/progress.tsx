import * as React from 'react';
import { cn } from './utils';

/**
 * 进度条。一根 div 就够，不为它引 @radix-ui/react-progress。
 *
 * label 是必填的：进度条对读屏用户只是一串百分比，不说清「在进度什么」等于没说。
 */
function Progress({
  value,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** 0–100，越界自动夹住 */
  value: number;
  label: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export { Progress };
