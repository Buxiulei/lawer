import { cn } from '@/app/_ui/cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('rounded-[8px] bg-surface-2', className)}
      style={{ animation: 'skeleton-pulse 1.4s ease-in-out infinite' }}
    />
  );
}

/** 列表加载骨架：卡片列表通用形态 */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-[12px] border border-line bg-surface p-4">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-3/5" />
        </div>
      ))}
    </div>
  );
}
