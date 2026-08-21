import * as React from 'react';
import { cn } from './utils';

/** 骨架块。动画关键帧 skeleton-pulse 在 globals.css 里，两套体系共用同一条。 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('rounded-[8px] bg-muted', className)}
      style={{ animation: 'skeleton-pulse 1.4s ease-in-out infinite' }}
      {...props}
    />
  );
}

/** 卡片列表的加载骨架，形状照着真实列表行来，免得内容一到位就跳版。 */
function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-[12px] border border-border bg-card p-4">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-3/5" />
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonList };
