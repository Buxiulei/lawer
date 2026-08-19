import type { ReactNode } from 'react';

/**
 * 空状态文案给确定感，不写「暂无数据」这类无信息量的句子。
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[12px] border border-dashed border-line bg-surface px-6 py-14 text-center">
      <p className="text-[16px] font-semibold text-ink">{title}</p>
      {description && (
        <p className="prose-measure mt-2 text-[15px] leading-7 text-ink-2">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
