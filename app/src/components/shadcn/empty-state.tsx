import * as React from 'react';
import { cn } from './utils';

/**
 * 空状态。props 与手写版 @/components/ui/EmptyState 逐字一致，转体系的页面换 import 即可。
 * 文案给确定感，不写「暂无数据」这类无信息量的句子。
 */
function EmptyState({
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center rounded-[12px] border border-dashed border-border bg-card px-6 py-14 text-center',
        className,
      )}
      {...props}
    >
      <p className="text-[16px] font-semibold text-foreground">{title}</p>
      {description && (
        <p className="prose-measure mt-2 text-[15px] leading-7 text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export { EmptyState };
